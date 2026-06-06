export type UpdateType = "html" | "json" | "pogo";
export type ClientMode = "include" | "exclude";

export type Update = {
  clients: {
    mode: ClientMode;
    ids: string[];
  };
  vars?: Record<string, unknown>;
  type: UpdateType;
  path: string;
  payload: string;
};

type Headers = {
  config?: unknown;
  private?: unknown;
  public?: unknown;
  vars?: unknown;
};

type ParseContext = {
  vars: Record<string, unknown>;
};

type RawMarkup = {
  kind: "raw-markup";
  value: string;
};

export class UpdateStreamParser {
  private buffer = "";

  push(chunk: string): Update[] {
    this.buffer += chunk;
    const updates: Update[] = [];

    while (true) {
      const parsed = this.parseNext(false);

      if (!parsed) {
        return updates;
      }

      updates.push(parsed);
    }
  }

  finish(): Update[] {
    const updates: Update[] = [];

    while (this.buffer.trim()) {
      const parsed = this.parseNext(true);

      if (!parsed) {
        break;
      }

      updates.push(parsed);
    }

    return updates;
  }

  private parseNext(final: boolean): Update | null {
    this.buffer = this.buffer.trimStart();

    if (!this.buffer) {
      return null;
    }

    const start = this.buffer.indexOf("{");

    if (start === -1) {
      this.buffer = final ? "" : this.buffer;
      return null;
    }

    if (start > 0) {
      this.buffer = this.buffer.slice(start);
    }

    const end = findUpdateObjectEnd(this.buffer);

    if (end === -1) {
      return null;
    }

    const candidate = this.buffer.slice(0, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    return parseUpdate(candidate);
  }
}

export function parseAllUpdates(text: string): Update[] {
  const parser = new UpdateStreamParser();
  return [...parser.push(text), ...parser.finish()];
}

export function shouldSendToClient(update: Update, clientId: string): boolean {
  if (update.clients.mode === "include") {
    return update.clients.ids.includes(clientId);
  }

  return !update.clients.ids.includes(clientId);
}

export function injectUpdateClientId(update: Update, clientId: string): Update {
  return {
    ...update,
    payload: update.payload.replaceAll(
      "INSERT_CLIENT_ID",
      escapeAttribute(clientId),
    ),
  };
}

function parseUpdate(input: string): Update | null {
  const json = parseJson(input);
  const legacy = coerceUpdate(json);

  if (legacy) {
    return legacy;
  }

  try {
    const parsed = new LooseParser(input, { vars: {} }).parseRootObject();
    return coerceDocument(parsed);
  } catch (error) {
    console.warn("Could not parse update object", error);
    return null;
  }
}

function coerceDocument(value: unknown): Update | null {
  const legacy = coerceUpdate(value);

  if (legacy) {
    return legacy;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const document = value as { body?: unknown; headers?: Headers };
  const headers = document.headers;

  if (!headers || typeof headers !== "object") {
    return null;
  }

  const vars = recordFromUnknown(headers.vars ?? headers.public);
  const config = headers.config ?? headers.private;
  const updateBase = coerceUpdateConfig(config);

  if (!updateBase) {
    return null;
  }

  return {
    ...updateBase,
    vars,
    payload: payloadFromBody(document.body, updateBase.type, vars),
  };
}

function coerceUpdateConfig(value: unknown): Omit<Update, "payload"> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Omit<Update, "payload">>;
  const clients = candidate.clients;

  if (!clients || typeof clients !== "object") {
    return null;
  }

  const mode =
    clients.mode === "include" || clients.mode === "exclude"
      ? clients.mode
      : null;
  const ids = Array.isArray(clients.ids)
    ? clients.ids.map(String)
    : null;
  const type =
    candidate.type === "html" ||
    candidate.type === "json" ||
    candidate.type === "pogo"
      ? candidate.type
      : null;

  if (!mode || !ids || !type || typeof candidate.path !== "string") {
    return null;
  }

  return {
    clients: { mode, ids },
    path: candidate.path,
    type,
  };
}

function coerceUpdate(value: unknown): Update | null {
  const base = coerceUpdateConfig(value);

  if (!base || !value || typeof value !== "object") {
    return null;
  }

  const payload = (value as Partial<Update>).payload;

  if (typeof payload !== "string") {
    return null;
  }

  return {
    ...base,
    payload,
  };
}

function payloadFromBody(
  body: unknown,
  type: UpdateType,
  vars: Record<string, unknown>,
): string {
  if (isRawMarkup(body)) {
    return body.value;
  }

  if (type === "html") {
    return typeof body === "string" ? body : String(body);
  }

  return JSON.stringify(body ?? null);
}

function renderJsxLike(markup: string, vars: Record<string, unknown>): string {
  const input = markup.trim();
  let output = "";

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (char === "<") {
      const rawTextElement = readRawTextElement(input, index);

      if (rawTextElement) {
        output +=
          renderJsxLike(rawTextElement.openingTag, vars) + rawTextElement.content;
        index = rawTextElement.end;
        continue;
      }
    }

    if (char === "=") {
      const spaces = readSpaces(input, index + 1);

      if (input[spaces.end] === "{") {
        const expression = readBraceExpression(input, spaces.end);
        output += `="${escapeAttribute(
          String(evaluateExpression(expression.value, vars)),
        )}"`;
        index = expression.end;
        continue;
      }

      output += char + spaces.value;
      index = spaces.end - 1;
      continue;
    }

    if (char === "$" && input[index + 1] === "{") {
      const expression = readBraceExpression(input, index + 1);
      output += escapeAttribute(String(evaluateExpression(expression.value, vars)));
      index = expression.end;
      continue;
    }

    if (char === "{") {
      const expression = readBraceExpression(input, index);
      output += escapeHtml(String(evaluateExpression(expression.value, vars)));
      index = expression.end;
      continue;
    }

    output += char;
  }

  return output;
}

function evaluateExpression(
  expression: string,
  vars: Record<string, unknown>,
): unknown {
  const parser = new LooseParser(expression, { vars });
  return parser.parseExpressionOnly();
}

class LooseParser {
  private index = 0;

  constructor(
    private readonly input: string,
    private readonly context: ParseContext,
  ) {}

  parseRootObject(): unknown {
    const value = this.parseValue();
    this.skipSpaceAndCommas();
    return value;
  }

  parseExpressionOnly(): unknown {
    const value = this.parseConcatExpression();
    this.skipSpaceAndCommas();
    return value;
  }

  private parseValue(): unknown {
    this.skipSpaceAndCommas();
    const char = this.peek();

    if (char === "{") {
      return this.parseObject();
    }

    if (char === "[") {
      return this.parseArray();
    }

    if (char === '"' || char === "'") {
      return this.parseQuotedString();
    }

    if (char === "`") {
      return this.parseTemplateString();
    }

    if (char === "<") {
      return { kind: "raw-markup", value: this.readRawMarkup() } satisfies RawMarkup;
    }

    if (isNumberStart(char)) {
      return this.parseNumber();
    }

    return this.parseIdentifierValue();
  }

  private parseConcatExpression(): unknown {
    let value = this.parseValue();

    while (true) {
      this.skipSpaceAndCommas();

      if (this.peek() !== "+") {
        return value;
      }

      this.index += 1;
      const right = this.parseValue();
      value = String(value ?? "") + String(right ?? "");
    }
  }

  private parseObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.expect("{");

    while (true) {
      this.skipSpaceAndCommas();

      if (this.peek() === "}") {
        this.index += 1;
        return result;
      }

      const key = this.parseKey();
      this.skipSpaceAndCommas();

      if (this.peek() === ":") {
        this.index += 1;
      }

      result[key] =
        key === "body" ? this.parseBodyValue() : this.parseConcatExpression();

      if (key === "headers") {
        const headers = result[key] as Headers;
        this.context.vars = recordFromUnknown(headers.vars ?? headers.public);
      }
    }
  }

  private parseArray(): unknown[] {
    const result: unknown[] = [];
    this.expect("[");

    while (true) {
      this.skipSpaceAndCommas();

      if (this.peek() === "]") {
        this.index += 1;
        return result;
      }

      result.push(this.parseConcatExpression());
      this.skipSpaceAndCommas();

      if (this.peek() === "]") {
        this.index += 1;
        return result;
      }
    }
  }

  private parseBodyValue(): unknown {
    this.skipSpaceAndCommas();

    if (this.peek() === "<") {
      return { kind: "raw-markup", value: this.readRawBody() } satisfies RawMarkup;
    }

    return this.parseConcatExpression();
  }

  private parseKey(): string {
    this.skipSpaceAndCommas();
    const char = this.peek();

    if (char === '"' || char === "'") {
      return this.parseQuotedString();
    }

    const start = this.index;

    while (/[A-Za-z0-9_$/-]/.test(this.peek())) {
      this.index += 1;
    }

    if (this.index === start) {
      throw new Error(`Expected object key at ${this.index}`);
    }

    return this.input.slice(start, this.index);
  }

  private parseIdentifierValue(): unknown {
    const identifier = this.parseKey();

    if (identifier === "true") {
      return true;
    }

    if (identifier === "false") {
      return false;
    }

    if (identifier === "null") {
      return null;
    }

    if (identifier in this.context.vars) {
      return this.context.vars[identifier];
    }

    return identifier;
  }

  private parseNumber(): number {
    const start = this.index;

    while (/[0-9.eE+-]/.test(this.peek())) {
      this.index += 1;
    }

    return Number(this.input.slice(start, this.index));
  }

  private parseQuotedString(): string {
    const quote = this.peek();
    let result = "";
    this.index += 1;

    while (this.index < this.input.length) {
      const char = this.input[this.index];
      this.index += 1;

      if (char === quote) {
        return result;
      }

      if (char === "\\") {
        result += this.readEscape();
      } else {
        result += char;
      }
    }

    throw new Error("Unterminated string");
  }

  private parseTemplateString(): string {
    let result = "";
    this.expect("`");

    while (this.index < this.input.length) {
      const char = this.input[this.index];

      if (char === "`") {
        this.index += 1;
        return result;
      }

      if (char === "\\" && this.input[this.index + 1]) {
        result += this.input[this.index + 1];
        this.index += 2;
        continue;
      }

      if (char === "$" && this.input[this.index + 1] === "{") {
        const end = findMatchingBrace(this.input, this.index + 1);

        if (end === -1) {
          throw new Error("Unterminated template interpolation");
        }

        const expression = this.input.slice(this.index + 2, end);
        result += String(evaluateExpression(expression, this.context.vars));
        this.index = end + 1;
        continue;
      }

      result += char;
      this.index += 1;
    }

    throw new Error("Unterminated template string");
  }

  private readEscape(): string {
    if (this.index >= this.input.length) {
      return "";
    }

    const char = this.input[this.index];
    this.index += 1;

    if (char === "n") {
      return "\n";
    }

    if (char === "r") {
      return "\r";
    }

    if (char === "t") {
      return "\t";
    }

    return char;
  }

  private readRawMarkup(): string {
    const start = this.index;

    while (this.index < this.input.length && this.peek() !== "}") {
      this.index += 1;
    }

    return this.input.slice(start, this.index).trim();
  }

  private readRawBody(): string {
    const start = this.index;
    const end = findBodyEnd(this.input, this.index);

    if (end === -1) {
      throw new Error("Unterminated raw body");
    }

    this.index = end;
    return this.input.slice(start, end).trim();
  }

  private skipSpaceAndCommas(): void {
    while (/[\s,]/.test(this.peek())) {
      this.index += 1;
    }
  }

  private expect(expected: string): void {
    if (this.peek() !== expected) {
      throw new Error(`Expected ${expected} at ${this.index}`);
    }

    this.index += 1;
  }

  private peek(): string {
    return this.input[this.index] || "";
  }
}

function findUpdateObjectEnd(input: string): number {
  let depth = 0;
  let stringQuote = "";
  let inTemplate = false;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (stringQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        stringQuote = "";
      }
      continue;
    }

    if (inTemplate) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "`") {
        inTemplate = false;
      } else if (char === "{" || char === "}") {
        depth += char === "{" ? 1 : -1;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      continue;
    }

    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findBodyEnd(input: string, start: number): number {
  let stringQuote = "";
  let inTemplate = false;
  let escaped = false;
  let expressionDepth = 0;

  for (let index = start; index < input.length; index++) {
    const char = input[index];

    if (stringQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        stringQuote = "";
      }
      continue;
    }

    if (inTemplate) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "`") {
        inTemplate = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      stringQuote = char;
      continue;
    }

    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "{") {
      expressionDepth += 1;
      continue;
    }

    if (char === "}") {
      if (expressionDepth === 0 && onlyWhitespaceAndCommas(input, index + 1)) {
        return index;
      }

      expressionDepth = Math.max(0, expressionDepth - 1);
    }
  }

  return -1;
}

function findMatchingBrace(input: string, start: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = start; index < input.length; index++) {
    const char = input[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function readBraceExpression(
  input: string,
  start: number,
): { end: number; value: string } {
  const end = findMatchingBrace(input, start);

  if (end === -1) {
    throw new Error("Unterminated brace expression");
  }

  return {
    end,
    value: input.slice(start + 1, end),
  };
}

function readRawTextElement(
  input: string,
  start: number,
): { content: string; end: number; openingTag: string } | null {
  const match = /^<(script|style)\b[^>]*>/i.exec(input.slice(start));

  if (!match) {
    return null;
  }

  const tagName = match[1].toLowerCase();
  const openingTag = match[0];
  const contentStart = start + openingTag.length;
  const closePattern = new RegExp(`</${tagName}\\s*>`, "i");
  const closeMatch = closePattern.exec(input.slice(contentStart));

  if (!closeMatch) {
    return null;
  }

  const contentEnd = contentStart + closeMatch.index + closeMatch[0].length;

  return {
    content: input.slice(contentStart, contentEnd),
    end: contentEnd - 1,
    openingTag,
  };
}

function readSpaces(input: string, start: number): { end: number; value: string } {
  let end = start;

  while (/\s/.test(input[end] || "")) {
    end += 1;
  }

  return {
    end,
    value: input.slice(start, end),
  };
}

function onlyWhitespaceAndCommas(input: string, start: number): boolean {
  for (let index = start; index < input.length; index++) {
    if (!/[\s,]/.test(input[index])) {
      return false;
    }
  }

  return true;
}

function isRawMarkup(value: unknown): value is RawMarkup {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as RawMarkup).kind === "raw-markup",
  );
}

function isNumberStart(value: string): boolean {
  return /[0-9-]/.test(value);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
