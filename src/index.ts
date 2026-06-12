import { DurableObject } from "cloudflare:workers";
import appStyles from "./app.css";
import appHtml from "./app.html";
import { handleAuthRoute, isAuthRoute } from "./auth/routes";
import { isAuthEnabled } from "./auth/providers";
import { getAuthSession } from "./auth/server";
import {
  requireRolePermission,
  type RoleGateResult,
  type RolePermission,
} from "./auth/roles";
import {
  renderDebugPage,
  type DebugState,
  type LlmMessage,
  type LlmRole,
} from "./debug";
import type { AppEnv } from "./env";
import { getPrompt } from "./getPrompt";
import pageStyles from "./page.css";

type ChatRole = "user" | "assistant" | "form";
type UpdateType = "html" | "json";
type ClientMode = "include" | "exclude";

type ChatMessage = {
  id: number;
  role: ChatRole;
  clientId: string;
  content: string;
  createdAt: number;
};

type ChatSnapshot = {
  messages: ChatMessage[];
  llmMessages: LlmMessage[];
  llmUpdatedAt: string;
};

type Update = {
  clients: {
    mode: ClientMode;
    ids: string[];
  };
  type: UpdateType;
  path: string;
  payload: string;
};

type ClientUpdate = {
  type: UpdateType;
  path: string;
  payload: string;
};

type WebSocketAttachment = {
	clientId: string;
	chatId: string;
};

declare global {
	interface Element {
		appendHTML?(html: string): void;
		appendHTMLUnsafe?(html: string): void;
	}
}

const htmlHeaders = {
	"Cache-Control": "no-store",
	"Content-Type": "text/html; charset=utf-8",
};

const PROTOCOL_PREFIX = "PpqUtcLGQdYN4oqc";
const SPLIT_MESSAGE = `${PROTOCOL_PREFIX}:SPLIT_MESSAGE`;
const SERVER_PROPS_START = `${PROTOCOL_PREFIX}:SERVER_PROPS_START`;
const SERVER_PROPS_END = `${PROTOCOL_PREFIX}:SERVER_PROPS_END`;
const CLIENT_PROPS_START = `${PROTOCOL_PREFIX}:CLIENT_PROPS_START`;
const CLIENT_PROPS_END = `${PROTOCOL_PREFIX}:CLIENT_PROPS_END`;
const BODY_START = `${PROTOCOL_PREFIX}:BODY_START`;
const BODY_END = `${PROTOCOL_PREFIX}:BODY_END`;
const CLIENT_ID_TOKEN = `${PROTOCOL_PREFIX}:CLIENT_ID`;
const CHAT_ID_TOKEN = `${PROTOCOL_PREFIX}:CHAT_ID`;
const FORK_ID_TOKEN = `${PROTOCOL_PREFIX}:FORK_ID`;
const FORK_INDEX_OBJECT = "__fork_index";

export class PartialUpdate extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ensureSchema();
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/socket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const chatId = url.searchParams.get("chatId");
      const clientId = url.searchParams.get("clientId");

      if (!chatId || !clientId) {
        return new Response("Missing chatId or clientId", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        chatId,
        clientId,
      } satisfies WebSocketAttachment);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async nextClientId(): Promise<string> {
    const clientId = this.getNextClientId();
    this.setNextClientId(clientId + 1);
    return String(clientId);
  }

  async getInitialPage(chatId: string, clientId: string): Promise<string> {
    const forkId = await this.ensureForkId(chatId);
    this.ensureSystemMessage(clientId, chatId);
    const updates = this.readAssistantUpdates(1000).filter((update) =>
      shouldSendToClient(update, clientId),
    );

    return renderAppPage({
      chatId,
      clientId,
      forkId,
      history: updates.map((update) =>
        toClientUpdate(update, chatId, clientId, forkId),
      ),
      title: `PartialUpdate ${chatId}`,
    });
  }

  async getForkId(chatId: string): Promise<string> {
    return this.ensureForkId(chatId);
  }

  async getReadOnlyForkPage(
    chatId: string,
    forkId: string,
    clientId: string,
    canSubmit = true,
  ): Promise<string> {
    const updates = this.readAssistantUpdates(1000).filter((update) =>
      shouldSendToClient(update, clientId),
    );

    return renderAppPage({
      chatId: forkId,
      clientId,
      connect: false,
      forkId,
      hidePrompt: !canSubmit,
      history: updates.map((update) =>
        toClientUpdate(update, forkId, clientId, forkId),
      ),
      title: `PartialUpdate fork ${forkId}`,
    });
  }

  async getDebugState(chatId: string): Promise<DebugState> {
    return {
      messages: this.readLlmMessages(),
      objectId: chatId,
      updatedAt: this.getLlmUpdatedAt(),
    };
  }

  async clearHistory(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    this.setNextClientId(0);
    await this.broadcast({
      clients: { mode: "exclude", ids: [] },
      path: "/body",
      payload: `<template for="/chat/append-message">
	<?start name="/chat/append-message">
	<?marker name="/chat/append-message">
</template>`,
      type: "html",
    });
  }

  async lookupFork(forkId: string): Promise<string | undefined> {
    const rows = this.ctx.storage.sql
      .exec("SELECT chat_id FROM fork_index WHERE fork_id = ?", forkId)
      .toArray() as Array<{ chat_id: string }>;
    return rows[0]?.chat_id;
  }

  async lookupChatFork(chatId: string): Promise<string | undefined> {
    const rows = this.ctx.storage.sql
      .exec("SELECT fork_id FROM fork_index WHERE chat_id = ?", chatId)
      .toArray() as Array<{ fork_id: string }>;
    return rows[0]?.fork_id;
  }

  async registerFork(chatId: string, forkId: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fork_index (fork_id, chat_id, created_at) VALUES (?, ?, ?)",
      forkId,
      chatId,
      Date.now(),
    );
    return result.rowsWritten > 0;
  }

  async snapshotForFork(): Promise<ChatSnapshot> {
    return {
      llmMessages: this.readLlmMessages(),
      llmUpdatedAt: this.getLlmUpdatedAt(),
      messages: this.readMessages(),
    };
  }

  async cloneFromSnapshot(
    chatId: string,
    clientId: string,
    snapshot: ChatSnapshot,
  ): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    this.setNextClientId(maxClientId(snapshot.messages) + 1);
    const forkId = await this.ensureForkId(chatId);
    this.addLlmMessage("system", getPrompt(clientId, chatId, forkId));

    for (const message of snapshot.llmMessages) {
      if (message.role === "system") {
        continue;
      }

      this.addLlmMessage(message.role, message.content);
    }

    for (const message of snapshot.messages) {
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (role, client_id, content, created_at) VALUES (?, ?, ?, ?)",
        message.role,
        message.clientId,
        message.content,
        message.createdAt,
      );
    }

    this.setMetadata("llmUpdatedAt", snapshot.llmUpdatedAt);
  }

  async submitPrompt(
    clientId: string,
    prompt: string,
    chatId = "chat",
  ): Promise<void> {
    const normalizedPrompt = prompt.trim();

    if (!normalizedPrompt) {
      return;
    }

    await this.addMessage("user", clientId, normalizedPrompt);
    await this.runModel(clientId, chatId, normalizedPrompt);
  }

  async submitForm(
    clientId: string,
    fields: Record<string, string>,
    chatId = "chat",
  ): Promise<void> {
    const description = fields.description?.trim() || "form submission";
    const fieldText = Object.entries(fields)
      .filter(([key]) => key !== "clientId")
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    const prompt = `${clientId}: ${description}\n${fieldText}`.trim();

    await this.addMessage("form", clientId, prompt);
    await this.runModel(clientId, chatId, formatFormPrompt(fields));
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (message === "ping") {
      ws.send("pong");
      return;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "WebSocket error");
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				client_id TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS llm_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS fork_index (
				fork_id TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE UNIQUE INDEX IF NOT EXISTS fork_index_fork_id_idx
				ON fork_index (fork_id);

			CREATE UNIQUE INDEX IF NOT EXISTS fork_index_chat_id_idx
				ON fork_index (chat_id)
		`);
  }

  private async runModel(
    clientId: string,
    chatId: string,
    prompt: string,
  ): Promise<void> {
    await this.ensureForkId(chatId);
    this.ensureSystemMessage(clientId, chatId);
    this.addLlmMessage(
      "user",
      prompt.startsWith("[form]:")
        ? prompt
        : formatClientPrompt(clientId, prompt),
    );
    const llmMessages = this.readLlmMessages();
    const parser = new UpdateStreamParser();
    let response = "";

    for await (const chunk of streamModelResponse(
      this.env,
      llmMessages,
      clientId,
    )) {
      const normalizedChunk = normalizeModelOutput(
        sanitizeModelOutput(chunk),
        clientId,
      );

      if (!normalizedChunk) {
        continue;
      }

      response += normalizedChunk;

      for (const update of parser.push(normalizedChunk)) {
        await this.broadcast(update);
      }
    }

    for (const update of parser.finish()) {
      await this.broadcast(update);
    }

    if (response) {
      await this.addMessage("assistant", clientId, response);
      this.addLlmMessage("assistant", response);
    }
  }

  private async broadcast(update: Update): Promise<void> {
    const staleSockets: WebSocket[] = [];
    const forkId = this.readForkId();

    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as
        | WebSocketAttachment
        | undefined;

      if (!attachment || !shouldSendToClient(update, attachment.clientId)) {
        continue;
      }

      try {
        socket.send(
          JSON.stringify(
            toClientUpdate(
              update,
              attachment.chatId,
              attachment.clientId,
              forkId,
            ),
          ),
        );
      } catch {
        staleSockets.push(socket);
      }
    }

    for (const socket of staleSockets) {
      socket.close(1011, "Stale socket");
    }
  }

  private async addMessage(
    role: ChatRole,
    clientId: string,
    content: string,
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, client_id, content, created_at) VALUES (?, ?, ?, ?)",
      role,
      clientId,
      content,
      Date.now(),
    );
  }

  private ensureSystemMessage(clientId: string, chatId: string): void {
    const row = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS count FROM llm_messages")
      .one() as { count: number };

    if (row.count > 0) {
      return;
    }

    this.addLlmMessage(
      "system",
      getPrompt(clientId, chatId, this.readForkId()),
    );
  }

  private addLlmMessage(role: LlmRole, content: string): void {
    const createdAt = Date.now();

    this.ctx.storage.sql.exec(
      "INSERT INTO llm_messages (role, content, created_at) VALUES (?, ?, ?)",
      role,
      content,
      createdAt,
    );
    this.setMetadata("llmUpdatedAt", new Date(createdAt).toISOString());
  }

  private readLlmMessages(): LlmMessage[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT role, content
				FROM llm_messages
				ORDER BY id ASC`,
      )
      .toArray() as unknown as LlmMessage[];
  }

  private readMessages(): ChatMessage[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, role, client_id, content, created_at
				FROM messages
				ORDER BY id ASC`,
      )
      .toArray() as Array<{
        id: number;
        role: ChatRole;
        client_id: string;
        content: string;
        created_at: number;
      }>;

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      clientId: row.client_id,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  private readAssistantUpdates(limit = 100): Update[] {
    const messages = this.ctx.storage.sql
      .exec(
        `SELECT content
				FROM messages
				WHERE role = 'assistant'
				ORDER BY id ASC
				LIMIT ?`,
        limit,
      )
      .toArray() as Array<{ content: string }>;

    return messages.flatMap((message) => parseAllUpdates(message.content));
  }

  private getNextClientId(): number {
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM metadata WHERE key = 'nextClientId'")
      .toArray() as Array<{ value: string }>;
    const parsed = Number.parseInt(rows[0]?.value ?? "0", 10);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private setNextClientId(value: number): void {
    this.setMetadata("nextClientId", String(value));
  }

  private readForkId(): string {
    return this.getMetadata("forkId") ?? "";
  }

  private async ensureForkId(chatId: string): Promise<string> {
    const existing = this.readForkId();

    if (existing) {
      return existing;
    }

    const index = this.env.PARTIAL_UPDATE.getByName(FORK_INDEX_OBJECT);
    const indexed = await index.lookupChatFork(chatId);

    if (indexed) {
      this.setMetadata("forkId", indexed);
      return indexed;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const forkId = newForkId();

      if (await index.registerFork(chatId, forkId)) {
        this.setMetadata("forkId", forkId);
        return forkId;
      }
    }

    throw new Error("Unable to allocate fork id");
  }

  private getLlmUpdatedAt(): string {
    return this.getMetadata("llmUpdatedAt") ?? "1970-01-01T00:00:00.000Z";
  }

  private getMetadata(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM metadata WHERE key = ?", key)
      .toArray() as Array<{ value: string }>;
    return rows[0]?.value;
  }

  private setMetadata(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO metadata (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (isAuthRoute(url.pathname)) {
      return handleAuthRoute(request, env);
    }

    const route = parseRoute(url.pathname);

    if (request.method === "GET" && route.kind === "home") {
      const gate = await authorize(request, env, "chat");

      if (!gate.ok) {
        return gate.response;
      }

      return Response.redirect(
        new URL(`/${newChatId()}`, url.origin).toString(),
        302,
      );
    }

    if (request.method === "GET" && route.kind === "chat") {
      const forkSourceChatId = await lookupForkSourceChatId(env, route.chatId);

      if (forkSourceChatId) {
        const gate = await authorize(request, env, "viewFork");

        if (!gate.ok) {
          return gate.response;
        }

        const clientId = newForkClientId();
        const stub = env.PARTIAL_UPDATE.getByName(forkSourceChatId);
        return new Response(
          await stub.getReadOnlyForkPage(
            forkSourceChatId,
            route.chatId,
            clientId,
            gate.role !== "view",
          ),
          {
            headers: htmlHeaders,
          },
        );
      }

      const gate = await authorize(request, env, "chat");

      if (!gate.ok) {
        return gate.response;
      }

      const stub = env.PARTIAL_UPDATE.getByName(route.chatId);
      const clientId = await stub.nextClientId();
      return new Response(await stub.getInitialPage(route.chatId, clientId), {
        headers: htmlHeaders,
      });
    }

    if (request.method === "GET" && route.kind === "fork") {
      const gate = await authorize(request, env, "chat");

      if (!gate.ok) {
        return gate.response;
      }

      const forkId = await env.PARTIAL_UPDATE.getByName(
        route.chatId,
      ).getForkId(route.chatId);
      return Response.redirect(new URL(`/${forkId}`, url.origin).toString(), 302);
    }

    if (request.method === "GET" && route.kind === "socket") {
      const gate = await authorize(request, env, "websocket");

      if (!gate.ok) {
        return gate.response;
      }

      const clientId = url.searchParams.get("clientId");

      if (!clientId) {
        return new Response("Missing clientId", { status: 400 });
      }

      const socketUrl = new URL("https://partialupdate.internal/socket");
      socketUrl.searchParams.set("chatId", route.chatId);
      socketUrl.searchParams.set("clientId", clientId);

      return env.PARTIAL_UPDATE.getByName(route.chatId).fetch(
        new Request(socketUrl.toString(), {
          headers: request.headers,
          signal: request.signal,
        }),
      );
    }

    if (request.method === "GET" && route.kind === "debug") {
      const gate = await authorize(request, env, "debug");

      if (!gate.ok) {
        return gate.response;
      }

      const debugState = await env.PARTIAL_UPDATE.getByName(
        route.chatId,
      ).getDebugState(route.chatId);
      return renderDebugPage(url, debugState);
    }

    if (request.method === "POST" && route.kind === "prompt") {
      const form = await request.formData();
      const clientId = getFormString(form, "clientId");
      const prompt = getFormString(form, "prompt");

      if (!clientId || !prompt) {
        return new Response(null, { status: 400 });
      }

      const gate = await authorize(request, env, "chat");

      if (!gate.ok) {
        return gate.response;
      }

      const forkSourceChatId = await lookupForkSourceChatId(env, route.chatId);

      if (forkSourceChatId) {
        const newChatId = await createForkedChat(env, {
          clientId,
          sourceChatId: forkSourceChatId,
        });

        await env.PARTIAL_UPDATE.getByName(newChatId).submitPrompt(
          clientId,
          prompt,
          newChatId,
        );

        return renderParentRedirect(new URL(`/${newChatId}`, url.origin));
      }

      await env.PARTIAL_UPDATE.getByName(route.chatId).submitPrompt(
        clientId,
        prompt,
        route.chatId,
      );
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && route.kind === "form") {
      const form = await request.formData();
      const fields = formDataToRecord(form);
      const clientId = fields.clientId || "unknown";

      const gate = await authorize(request, env, "chat");

      if (!gate.ok) {
        return gate.response;
      }

      const forkSourceChatId = await lookupForkSourceChatId(env, route.chatId);

      if (forkSourceChatId) {
        const newChatId = await createForkedChat(env, {
          clientId,
          sourceChatId: forkSourceChatId,
        });

        await env.PARTIAL_UPDATE.getByName(newChatId).submitForm(
          clientId,
          fields,
          newChatId,
        );

        return renderParentRedirect(new URL(`/${newChatId}`, url.origin));
      }

      await env.PARTIAL_UPDATE.getByName(route.chatId).submitForm(
        clientId,
        fields,
        route.chatId,
      );
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && route.kind === "debugClear") {
      const gate = await authorize(request, env, "debug");

      if (!gate.ok) {
        return gate.response;
      }

      await env.PARTIAL_UPDATE.getByName(route.chatId).clearHistory();
      return Response.redirect(
        new URL(`/${route.chatId}/debug`, url.origin).toString(),
        303,
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<AppEnv>;

async function authorize(
  request: Request,
  env: AppEnv,
  permission: RolePermission,
): Promise<RoleGateResult> {
  if (isAuthEnabled(env) && !env.BETTER_AUTH_SECRET) {
    return {
      ok: false,
      response: new Response("Authentication is not configured", {
        status: 503,
      }),
    };
  }

  const session = isAuthEnabled(env) ? await getAuthSession(request, env) : null;
  return requireRolePermission(request, env, session, permission);
}

async function lookupForkSourceChatId(
  env: AppEnv,
  forkId: string,
): Promise<string | undefined> {
  if (!forkId.startsWith("fork-")) {
    return undefined;
  }

  return env.PARTIAL_UPDATE.getByName(FORK_INDEX_OBJECT).lookupFork(forkId);
}

async function createForkedChat(
  env: AppEnv,
  options: {
    clientId: string;
    sourceChatId: string;
  },
): Promise<string> {
  const newChatId = newChatIdFromFork();
  const source = env.PARTIAL_UPDATE.getByName(options.sourceChatId);
  const snapshot = await source.snapshotForFork();
  await env.PARTIAL_UPDATE.getByName(newChatId).cloneFromSnapshot(
    newChatId,
    options.clientId,
    snapshot,
  );
  return newChatId;
}

function renderParentRedirect(url: URL): Response {
  return new Response(
    `<!DOCTYPE html><script>window.parent.location.href = ${JSON.stringify(
      url.toString(),
    )};</script>`,
    { headers: htmlHeaders },
  );
}

function parseRoute(
  pathname: string,
):
  | { kind: "home" }
  | { kind: "chat"; chatId: string }
  | { kind: "fork"; chatId: string }
  | { kind: "socket"; chatId: string }
  | { kind: "debug"; chatId: string }
  | { kind: "debugClear"; chatId: string }
  | { kind: "prompt"; chatId: string }
  | { kind: "form"; chatId: string }
  | { kind: "unknown" } {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return { kind: "home" };
  }

  if (parts.length === 1 && isSafeId(parts[0])) {
    return { kind: "chat", chatId: parts[0] };
  }

  if (parts.length === 2 && isSafeId(parts[0]) && parts[1] === "fork") {
    return { kind: "fork", chatId: parts[0] };
  }

  if (parts.length === 2 && isSafeId(parts[0]) && parts[1] === "socket") {
    return { kind: "socket", chatId: parts[0] };
  }

  if (parts.length === 2 && isSafeId(parts[0]) && parts[1] === "debug") {
    return { kind: "debug", chatId: parts[0] };
  }

  if (
    parts.length === 3 &&
    isSafeId(parts[0]) &&
    parts[1] === "debug" &&
    parts[2] === "clear"
  ) {
    return { kind: "debugClear", chatId: parts[0] };
  }

  if (parts.length === 2 && isSafeId(parts[0]) && parts[1] === "prompt") {
    return { kind: "prompt", chatId: parts[0] };
  }

  if (parts.length === 2 && isSafeId(parts[0]) && parts[1] === "form") {
    return { kind: "form", chatId: parts[0] };
  }

  return { kind: "unknown" };
}

function isSafeId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function newChatId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function newChatIdFromFork(): string {
  return newChatId();
}

function newForkClientId(): string {
  return `fork-${crypto.randomUUID().slice(0, 8)}`;
}

function newForkId(): string {
  return `fork-${crypto.randomUUID().slice(0, 8)}`;
}

function maxClientId(messages: ChatMessage[]): number {
  return messages.reduce((max, message) => {
    const parsed = Number.parseInt(message.clientId, 10);
    return Number.isFinite(parsed) && parsed >= max ? parsed : max;
  }, 0);
}

function getFormString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function formDataToRecord(form: FormData): Record<string, string> {
  const record: Record<string, string> = {};

  for (const [key, value] of form.entries()) {
    record[key] = typeof value === "string" ? value : value.name;
  }

  return record;
}

function renderAppPage(options: {
  chatId: string;
  clientId: string;
  connect?: boolean;
  forkId: string;
  hidePrompt?: boolean;
  history: ClientUpdate[];
  title: string;
}): string {
  const body = injectPageIds(
    appHtml,
    options.chatId,
    options.clientId,
    options.forkId,
  );

  return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>${escapeHtml(options.title)}</title>
		<script src="https://unpkg.com/html-setters-polyfill"></script>
		<script src="https://unpkg.com/template-for-polyfill"></script>
		<style>${pageStyles}</style>
		<style>${appStyles}</style>
		${options.hidePrompt ? "<style>.prompt { display: none !important; }</style>" : ""}
	</head>
	<body>
		${body}
		<script>${renderClientRuntime(options.chatId, options.clientId, options.history, options.connect ?? true)}</script>
	</body>
</html>`;
}

function renderClientRuntime(
  chatId: string,
  clientId: string,
  history: ClientUpdate[],
  connectToSocket: boolean,
): string {
  return `
(() => {
	const chatId = ${jsonForInlineScript(chatId)};
	const clientId = ${jsonForInlineScript(clientId)};
	const history = ${jsonForInlineScript(history)};
	const connectToSocket = ${jsonForInlineScript(connectToSocket)};
	const subscriptions = new Set();

	class Subscription {
		constructor(match, handler) {
			this.match = match;
			this.handler = handler;
		}
	}

	const dispatch = (event) => {
		for (const subscription of subscriptions) {
			if (subscription.match(event)) {
				subscription.handler(event);
			}
		}
	};

	const processingInstructionText = (node) => {
		if (node.nodeType === Node.COMMENT_NODE) {
			return node.data.replace(/^\\?(start|end|marker)\\b/i, (match) => match.toLowerCase());
		}

		if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
			return "?" + node.target.toLowerCase() + (node.data ? " " + node.data : "");
		}

		return "";
	};

		const instructionNameMatches = (text, name) => {
			const escaped = name.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&");
			return new RegExp("\\\\bname\\\\s*=\\\\s*([\\"'])?" + escaped + "\\\\1").test(text);
		};

		const activateScripts = (root) => {
			const scripts = root.querySelectorAll ? root.querySelectorAll("script") : [];

			for (const inertScript of scripts) {
				const script = document.createElement("script");

				for (const attribute of inertScript.attributes) {
					script.setAttribute(attribute.name, attribute.value);
				}

				if (script.src) {
					script.async = false;
				}

				script.text = inertScript.textContent || "";
				inertScript.replaceWith(script);
			}

			return root;
		};

		const activeClone = (content) => {
			return activateScripts(content.cloneNode(true));
		};

		const replaceMarker = (name, content) => {
			const walker = document.createTreeWalker(
				document.documentElement,
			NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION
		);
		let start = null;
		let depth = 0;
		let startDepth = 0;

		while (walker.nextNode()) {
			const node = walker.currentNode;
			const text = processingInstructionText(node);

			if (!text) {
				continue;
			}

			if (text.toLowerCase().startsWith("?marker") && instructionNameMatches(text, name)) {
				node.replaceWith(activeClone(content));
				return true;
			}

			if (text.toLowerCase().startsWith("?start")) {
				depth += 1;

				if (!start && instructionNameMatches(text, name)) {
					start = node;
					startDepth = depth;
				}
				continue;
			}

			if (text.toLowerCase().startsWith("?end") && start) {
				if (depth <= startDepth) {
					const end = start.parentElement === node.parentElement ? node : null;
					let next = start.nextSibling;

					while (next) {
						if (next === end) {
							next.remove();
							break;
						}

						const remove = next;
						next = next.nextSibling;
						remove.remove();
					}

					start.replaceWith(activeClone(content));
					return true;
				}

				if (depth > 1) {
					depth -= 1;
				}
			}
		}

		return false;
	};

		const appendRawHtml = (html) => {
			if (typeof document.body.appendHTMLUnsafe === "function") {
				document.body.appendHTMLUnsafe(html, { runScripts: true });
			} else if (typeof document.body.appendHTML === "function") {
				document.body.appendHTML(html);
			} else {
				const container = document.createElement("template");
				container.innerHTML = html;
				document.body.append(activeClone(container.content));
			}
		};

	const applyHtmlUpdate = (html) => {
		const container = document.createElement("template");
		container.innerHTML = html;
		const templates = Array.from(container.content.querySelectorAll("template[for]"));

		for (const template of templates) {
			const name = template.getAttribute("for");

			if (name && replaceMarker(name, template.content)) {
				template.remove();
			}
		}

			if (container.content.textContent.trim() || container.content.children.length > 0) {
				const wrapper = document.createElement("div");
				wrapper.append(activeClone(container.content));
				appendRawHtml(wrapper.innerHTML);
			}
		};

	window.Subscription = Subscription;
	window.partialupdates = {
		clientId,
		subscribe(subscription) {
			subscriptions.add(subscription);
			return () => subscriptions.delete(subscription);
		},
		dispatch
	};

	window.partialupdates.subscribe(new Subscription(
		(update) => update.path === "/body" && update.type === "html",
		(update) => {
			applyHtmlUpdate(update.payload);
			requestAnimationFrame(() => {
				document.documentElement.scrollTo({
					top: document.documentElement.scrollHeight,
					behavior: "smooth"
				});
			});
		}
	));

	for (const update of history) {
		dispatch(update);
	}

	const connect = () => {
		const url = new URL("/" + encodeURIComponent(chatId) + "/socket", window.location.href);
		url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("clientId", clientId);
		const socket = new WebSocket(url);
		let pingTimer;

		socket.addEventListener("open", () => {
			pingTimer = window.setInterval(() => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send("ping");
				}
			}, 25000);
		});

		socket.addEventListener("message", (message) => {
			if (message.data === "pong") {
				return;
			}

			try {
				dispatch(JSON.parse(message.data));
			} catch (error) {
				console.warn("Invalid partial update", error);
			}
		});

		socket.addEventListener("close", () => {
			window.clearInterval(pingTimer);
			window.setTimeout(connect, 1000);
		});
	};

	if (connectToSocket) {
		connect();
	}
})();`;
}

function jsonForInlineScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

async function* streamModelResponse(
  env: AppEnv,
  messages: LlmMessage[],
  clientId: string,
): AsyncIterable<string> {
  const provider = env.MODEL_PROVIDER || "cloudflare-gateway";
  const fallbackPrompt = lastUserMessage(messages);

  if (provider === "gemini-direct" && env.GEMINI_API_KEY) {
    yield* streamGeminiResponse(env, messages);
    return;
  }

  if (provider === "workers-ai" && env.AI) {
    yield* streamWorkersAiResponse(env, messages);
    return;
  }

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    yield* streamCloudflareGatewayResponse(env, messages);
    return;
  }

  if (env.GEMINI_API_KEY) {
    yield* streamGeminiResponse(env, messages);
    return;
  }

  yield fallbackUpdate(fallbackPrompt, clientId);
}

async function* streamCloudflareGatewayResponse(
  env: AppEnv,
  messages: LlmMessage[],
): AsyncIterable<string> {
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID || "default";
  const model = env.CLOUDFLARE_AI_GATEWAY_MODEL || "google/gemini-3-flash";
  const modelSettings = parseGatewayModelSettings(
    env.CLOUDFLARE_AI_GATEWAY_MODEL_SETTINGS,
  );
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || "")}/ai/v1/chat/completions`;
  const response = await fetch(url, {
    body: JSON.stringify({
      ...modelSettings,
      messages: gatewayChatMessagesFromMessages(messages),
      model,
      stream: true,
    }),
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN || ""}`,
      "Content-Type": "application/json",
      "cf-aig-gateway-id": gatewayId,
    },
    method: "POST",
  });

  if (!response.ok || !response.body) {
    console.warn("Cloudflare Gateway did not return a stream", {
      model,
      status: response.status,
      statusText: response.statusText,
      body: await response.text().catch(() => ""),
    });
    yield fallbackUpdate(lastUserMessage(messages), "");
    return;
  }

  const contentType = response.headers.get("Content-Type") || "";

  if (contentType.includes("text/event-stream")) {
    yield* parseSseTextStream(response.body);
    return;
  }

  yield extractTextFromPayload(await response.json().catch(() => undefined)) ||
    fallbackUpdate(lastUserMessage(messages), "");
}

async function* streamWorkersAiResponse(
  env: AppEnv,
  messages: LlmMessage[],
): AsyncIterable<string> {
  if (!env.AI) {
    yield fallbackUpdate(lastUserMessage(messages), "");
    return;
  }

  let stream: unknown;

  try {
    const model = env.WORKERS_AI_MODEL || "@cf/zai-org/glm-4.7-flash";
    stream = await env.AI.run(
      model,
      {
        messages,
        stream: true,
      },
      env.CLOUDFLARE_AI_GATEWAY_ID
        ? {
            gateway: {
              id: env.CLOUDFLARE_AI_GATEWAY_ID,
            },
          }
        : undefined,
    );
  } catch {
    yield fallbackUpdate(lastUserMessage(messages), "");
    return;
  }

  if (stream instanceof ReadableStream) {
    yield* parseSseTextStream(stream);
    return;
  }

  yield extractTextFromPayload(stream) ||
    fallbackUpdate(lastUserMessage(messages), "");
}

async function* streamGeminiResponse(
  env: AppEnv,
  messages: LlmMessage[],
): AsyncIterable<string> {
  const model = env.GEMINI_MODEL || "gemini-3-flash-preview";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
      env.GEMINI_API_KEY || "",
    )}`,
    {
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: messages
                  .map((message) => `${message.role}: ${message.content}`)
                  .join("\n\n"),
              },
            ],
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  if (!response.ok || !response.body) {
    console.warn("Gemini direct did not return a stream", {
      model,
      status: response.status,
      statusText: response.statusText,
      body: await response.text().catch(() => ""),
    });
    yield fallbackUpdate(lastUserMessage(messages), "");
    return;
  }

  yield* parseSseTextStream(response.body);
}

function lastUserMessage(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].content;
    }
  }

  return "";
}

function formatClientPrompt(clientId: string, prompt: string): string {
  return `[${clientId}]:${prompt}`;
}

function formatFormPrompt(fields: Record<string, string>): string {
  return `[form]:${new URLSearchParams(fields).toString()}`;
}

function gatewayChatMessagesFromMessages(messages: LlmMessage[]): Array<{
  content: string;
  role: LlmRole;
}> {
  return messages.map((message) => ({
    content: message.content,
    role: message.role,
  }));
}

function parseGatewayModelSettings(
  value: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }

  const parsed = typeof value === "string" ? parseJson(value) : value;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("Ignoring invalid Cloudflare Gateway model settings", {
      value,
    });
    return {};
  }

  const settings = { ...(parsed as Record<string, unknown>) };

  for (const reservedKey of ["messages", "model", "stream"]) {
    delete settings[reservedKey];
  }

  return settings;
}

async function* parseSseTextStream(
  stream: ReadableStream,
): AsyncIterable<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const data = line.slice(6).trim();

      if (!data || data === "[DONE]") {
        continue;
      }

      try {
        const text = extractTextFromPayload(JSON.parse(data));

        if (text) {
          yield text;
        }
      } catch {
        continue;
      }
    }
  }
}

function extractTextFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const data = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    choices?: Array<{
      delta?: { content?: string };
      message?: { content?: string };
      text?: string;
    }>;
    response?: string;
    result?: unknown;
  };

  return (
    data.choices
      ?.map(
        (choice) =>
          choice.delta?.content || choice.message?.content || choice.text || "",
      )
      .join("") ||
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") ||
    data.response ||
    extractTextFromPayload(data.result) ||
    ""
  );
}

class UpdateStreamParser {
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

    const bodyEnd = findDelimiterLine(this.buffer, BODY_END);

    if (bodyEnd === -1) {
      if (!final || containsProtocolDelimiter(this.buffer)) {
        return null;
      }

      return this.parseLegacyNext(final);
    }

    const endOfMessage = bodyEnd + BODY_END.length;
    const candidate = this.buffer.slice(0, endOfMessage);
    const parsed = parseDelimitedUpdate(candidate);

    if (!parsed) {
      this.buffer = this.buffer.slice(endOfMessage);
      this.consumeSplitMessage();
      return null;
    }

    this.buffer = this.buffer.slice(endOfMessage);
    this.consumeSplitMessage();
    return parsed;
  }

  private parseLegacyNext(final: boolean): Update | null {
    const end = findJsonObjectEnd(this.buffer);

    if (end === -1) {
      if (final) {
        this.buffer = "";
      }

      return null;
    }

    const candidate = this.buffer.slice(0, end + 1);
    const parsed = coerceUpdate(parseJson(candidate));
    this.buffer = this.buffer.slice(end + 1);
    return parsed;
  }

  private consumeSplitMessage(): void {
    this.buffer = this.buffer.trimStart();

    if (this.buffer.startsWith(SPLIT_MESSAGE)) {
      this.buffer = this.buffer.slice(SPLIT_MESSAGE.length);
    }
  }
}

function parseAllUpdates(text: string): Update[] {
  const parser = new UpdateStreamParser();
  return [...parser.push(text), ...parser.finish()];
}

function parseDelimitedUpdate(text: string): Update | null {
  const body = readDelimitedSection(text, BODY_START, BODY_END);

  if (body === null) {
    return null;
  }

  const serverProps = parseLooseObject(
    readDelimitedSection(text, SERVER_PROPS_START, SERVER_PROPS_END),
  );
  const clientProps = parseLooseObject(
    readDelimitedSection(text, CLIENT_PROPS_START, CLIENT_PROPS_END),
  );

  return coerceDelimitedUpdate(serverProps, clientProps, body);
}

function readDelimitedSection(
  text: string,
  startDelimiter: string,
  endDelimiter: string,
): string | null {
  const start = findDelimiterLine(text, startDelimiter);

  if (start === -1) {
    return null;
  }

  const contentStart = lineEndIndex(text, start + startDelimiter.length);
  const end = findDelimiterLine(text, endDelimiter, contentStart);

  if (end === -1) {
    return null;
  }

  return trimOneLeadingAndTrailingLineBreak(text.slice(contentStart, end));
}

function findDelimiterLine(
  text: string,
  delimiter: string,
  fromIndex = 0,
): number {
  let index = text.indexOf(delimiter, fromIndex);

  while (index !== -1) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + delimiter.length] || "";
    const startsLine = index === 0 || before === "\n" || before === "\r";
    const endsLine = after === "" || after === "\n" || after === "\r";

    if (startsLine && endsLine) {
      return index;
    }

    index = text.indexOf(delimiter, index + delimiter.length);
  }

  return -1;
}

function lineEndIndex(text: string, index: number): number {
  if (text[index] === "\r" && text[index + 1] === "\n") {
    return index + 2;
  }

  if (text[index] === "\n" || text[index] === "\r") {
    return index + 1;
  }

  return index;
}

function trimOneLeadingAndTrailingLineBreak(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function containsProtocolDelimiter(text: string): boolean {
  return text.includes(`${PROTOCOL_PREFIX}:`);
}

function findJsonObjectEnd(input: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function formatDelimitedUpdate(update: Update): string {
  return [
    SERVER_PROPS_START,
    JSON.stringify(
      {
        clients: {
          type: update.clients.mode,
          ids: update.clients.ids,
        },
      },
      null,
      2,
    ),
    SERVER_PROPS_END,
    CLIENT_PROPS_START,
    JSON.stringify(
      {
        path: update.path,
        type: update.type,
      },
      null,
      2,
    ),
    CLIENT_PROPS_END,
    BODY_START,
    update.payload,
    BODY_END,
  ].join("\n");
}

function parseLooseObject(value: string | null): unknown {
  if (value === null || !value.trim()) {
    return undefined;
  }

  const parsed = parseJson(value);

  if (parsed !== undefined) {
    return parsed;
  }

  return parseJson(jsonishToJson(value));
}

function jsonishToJson(value: string): string {
  return value
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, content: string) =>
      JSON.stringify(content.replace(/\\'/g, "'")),
    )
    .replace(/,\s*([}\]])/g, "$1");
}

function coerceDelimitedUpdate(
  serverProps: unknown,
  clientProps: unknown,
  payload: string,
): Update {
  const server = serverProps && typeof serverProps === "object"
    ? (serverProps as { clients?: unknown })
    : {};
  const client = clientProps && typeof clientProps === "object"
    ? (clientProps as { path?: unknown; type?: unknown })
    : {};
  const clients = coerceClients(server.clients) ?? {
    mode: "exclude" as const,
    ids: [],
  };
  const type = client.type === "json" ? "json" : "html";
  const path = typeof client.path === "string" ? client.path : "/body";

  return {
    clients,
    path,
    payload,
    type,
  };
}

function coerceUpdate(value: unknown): Update | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Update>;
  const clients = candidate.clients;

  if (!clients || typeof clients !== "object") {
    return null;
  }

  const coercedClients = coerceClients(clients);
  const type =
    candidate.type === "html" || candidate.type === "json"
      ? candidate.type
      : null;

  if (
    !coercedClients ||
    !type ||
    typeof candidate.path !== "string" ||
    typeof candidate.payload !== "string"
  ) {
    return null;
  }

  return {
    clients: coercedClients,
    path: candidate.path,
    payload: candidate.payload,
    type,
  };
}

function coerceClients(value: unknown): Update["clients"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const clients = value as {
    ids?: unknown;
    mode?: unknown;
    type?: unknown;
  };
  const mode =
    clients.type === "include" || clients.type === "exclude"
      ? clients.type
      : clients.mode === "include" || clients.mode === "exclude"
        ? clients.mode
        : null;

  if (!mode || !Array.isArray(clients.ids)) {
    return null;
  }

  return {
    mode,
    ids: clients.ids
      .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
      .map(String),
  };
}

function shouldSendToClient(update: Update, clientId: string): boolean {
  if (update.clients.mode === "include") {
    return update.clients.ids.includes(clientId);
  }

  return !update.clients.ids.includes(clientId);
}

function toClientUpdate(
  update: Update,
  chatId: string,
  clientId: string,
  forkId: string,
): ClientUpdate {
  return {
    path: update.path,
    payload: injectServerReplacements(update.payload, chatId, clientId, forkId),
    type: update.type,
  };
}

function injectServerReplacements(
  value: string,
  chatId: string,
  clientId: string,
  forkId: string,
): string {
  return value
    .replaceAll(CLIENT_ID_TOKEN, escapeAttribute(clientId))
    .replaceAll(CHAT_ID_TOKEN, escapeAttribute(chatId))
    .replaceAll(FORK_ID_TOKEN, escapeAttribute(forkId));
}

function fallbackUpdate(prompt: string, fallbackClientId: string): string {
  const { clientId, text } = splitPrompt(prompt);
  const id = clientId || fallbackClientId;
  const update: Update = {
    clients: { mode: "exclude", ids: [] },
    path: "/body",
    payload: `<template for="/chat/append-message">
	<?start name="/chat/append-message">
		<div class="message message-user" data-client-id="${escapeAttribute(id)}">${escapeHtml(text)}</div>
		<div class="message message-agent">I received your message, but the configured model provider did not return a stream. Check the Cloudflare Gateway, Workers AI, or Gemini direct settings.</div>
	<?marker name="/chat/append-message">
</template>`,
    type: "html",
  };

  return formatDelimitedUpdate(update);
}

function splitPrompt(prompt: string): { clientId: string; text: string } {
  const match =
    prompt.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/) ??
    prompt.match(/^([^:]+):\s*([\s\S]*)$/);

  if (!match) {
    return { clientId: "", text: prompt };
  }

  return { clientId: match[1], text: match[2] };
}

function sanitizeModelOutput(output: string): string {
  return output;
}

function normalizeModelOutput(output: string, clientId: string): string {
  const escapedClientId = escapeRegExp(clientId);
  const userMessagePattern = new RegExp(
    `(<div\\b[^>]*class=["'][^"']*\\bmessage-user\\b[^"']*["'][^>]*data-client-id=["']${escapedClientId}["'][^>]*>\\s*)${escapedClientId}:\\s*`,
    "gi",
  );

  return output.replace(userMessagePattern, "$1");
}

function injectPageIds(
  html: string,
  chatId: string,
  clientId: string,
  forkId: string,
): string {
  return injectServerReplacements(html, chatId, clientId, forkId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
