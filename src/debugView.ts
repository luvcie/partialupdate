import { parseAllUpdates, type Update } from "./updateFormat";

type LlmRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type DebugState = {
  messages: LlmMessage[];
  objectId: string;
  updatedAt: string;
};

const htmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
};

export function renderDebugPage(url: URL, state: DebugState): Response {
  return url.searchParams.get("mode") === "pretty"
    ? renderPrettyDebugPage(url, state)
    : renderRawDebugPage(url, state);
}

function renderRawDebugPage(url: URL, state: DebugState): Response {
  const json = JSON.stringify(state, null, 2);
  const modeHref = withSearchParam(url, "mode", "pretty");

  return debugResponse(
    state,
    url,
    `<div class="toolbar-extra"><a href="${escapeAttribute(modeHref)}">Pretty view</a></div>
		<pre class="raw-json">${escapeHtml(json)}</pre>`,
  );
}

function renderPrettyDebugPage(url: URL, state: DebugState): Response {
  const rawHref = withSearchParam(url, "mode", "");
  const messages = state.messages
    .map((message, index) => renderMessage(message, index))
    .join("");

  return debugResponse(
    state,
    url,
    `<div class="toolbar-extra"><a href="${escapeAttribute(rawHref)}">Raw JSON</a></div>
		<div class="timeline">${messages || `<p class="empty">No messages yet.</p>`}</div>`,
  );
}

function debugResponse(state: DebugState, url: URL, content: string): Response {
  const chatHref = new URL(`/${state.objectId}`, url.origin).toString();
  const clearAction = `/${state.objectId}/debug/clear`;

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>PartialUpdate Debug ${escapeHtml(state.objectId)}</title>
		<style>${debugStyles}</style>
	</head>
	<body>
		<header class="topbar">
			<div>
				<h1>Debug: ${escapeHtml(state.objectId)}</h1>
				<p>Updated ${escapeHtml(state.updatedAt)}</p>
			</div>
			<div class="actions">
				<a href="${escapeAttribute(chatHref)}">Open chat</a>
				<form method="post" action="${escapeAttribute(clearAction)}">
					<button type="submit">Clear chat</button>
				</form>
			</div>
		</header>
		${content}
	</body>
</html>`,
    { headers: htmlHeaders },
  );
}

function renderMessage(message: LlmMessage, index: number): string {
  const updates = message.role === "assistant" ? parseAllUpdates(message.content) : [];
  const body = updates.length
    ? updates.map((update, updateIndex) => renderUpdate(update, updateIndex)).join("")
    : `<pre class="code text">${escapeHtml(message.content)}</pre>`;

  return `<section class="message ${message.role}">
		<div class="message-meta">
			<span class="role">${escapeHtml(message.role)}</span>
			<span>#${index + 1}</span>
		</div>
		${body}
	</section>`;
}

function renderUpdate(update: Update, index: number): string {
  const header = {
    ...(update.vars ? { vars: update.vars } : {}),
    clients: update.clients,
    path: update.path,
    type: update.type,
  };
  const body =
    update.type === "html"
      ? highlightJsx(update.payload)
      : highlightJs(formatPayloadAsJs(update.payload));
  const bodyLabel = update.type === "html" ? "jsx" : "js";

  return `<article class="update">
		<div class="update-title">update ${index + 1}</div>
		<div class="nested">
			<div class="block">
				<div class="label">header</div>
				<pre class="code json">${highlightJson(JSON.stringify(header, null, 2))}</pre>
			</div>
			<div class="block">
				<div class="label">body <span>${bodyLabel}</span></div>
				<pre class="code ${bodyLabel}">${body}</pre>
			</div>
		</div>
	</article>`;
}

function formatPayloadAsJs(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

function highlightJson(value: string): string {
  return escapeHtml(value).replace(
    /(&quot;[^&]*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g,
    (match, stringValue: string, colon: string | undefined) => {
      if (stringValue) {
        return colon
          ? `<span class="key">${stringValue}</span>${colon}`
          : `<span class="string">${stringValue}</span>`;
      }

      if (/true|false|null/.test(match)) {
        return `<span class="literal">${match}</span>`;
      }

      return `<span class="number">${match}</span>`;
    },
  );
}

function highlightJs(value: string): string {
  return escapeHtml(value).replace(
    /(&quot;[^&]*?&quot;|'[^']*?'|`[^`]*?`)|\b(const|let|var|return|if|else|true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g,
    (match, stringValue: string, keyword: string) => {
      if (stringValue) {
        return `<span class="string">${stringValue}</span>`;
      }

      if (keyword) {
        return `<span class="literal">${keyword}</span>`;
      }

      return `<span class="number">${match}</span>`;
    },
  );
}

function highlightJsx(value: string): string {
  return escapeHtml(value)
    .replace(
      /(&lt;\/?)([A-Za-z0-9:-]+)([\s\S]*?)(\/?&gt;)/g,
      (_match, open: string, tag: string, attrs: string, close: string) =>
        `<span class="punct">${open}</span><span class="tag">${tag}</span>${highlightAttrs(attrs)}<span class="punct">${close}</span>`,
    )
    .replace(
      /(&lt;\?)(start|end|marker)([\s\S]*?)(\/?&gt;)/g,
      (_match, open: string, name: string, attrs: string, close: string) =>
        `<span class="punct">${open}</span><span class="pi">${name}</span>${highlightAttrs(attrs)}<span class="punct">${close}</span>`,
    );
}

function highlightAttrs(value: string): string {
  return value.replace(
    /([A-Za-z_:][-A-Za-z0-9_:.]*)(=)(&quot;.*?&quot;|'.*?'|\{.*?\})/g,
    (_match, name: string, equals: string, attrValue: string) =>
      `<span class="attr">${name}</span>${equals}<span class="string">${attrValue}</span>`,
  );
}

function withSearchParam(url: URL, key: string, value: string): string {
  const next = new URL(url.toString());

  if (value) {
    next.searchParams.set(key, value);
  } else {
    next.searchParams.delete(key);
  }

  return next.toString();
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

const debugStyles = `
:root {
	color-scheme: light dark;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

body {
	margin: 0;
	padding: 24px;
	background: light-dark(#f8fafc, #0f172a);
	color: light-dark(#0f172a, #e2e8f0);
}

.topbar {
	align-items: center;
	display: flex;
	gap: 16px;
	justify-content: space-between;
	margin-bottom: 16px;
}

h1 {
	font-size: 20px;
	margin: 0;
}

p {
	color: light-dark(#64748b, #94a3b8);
	font-size: 12px;
	margin: 4px 0 0;
}

.actions,
.toolbar-extra {
	align-items: center;
	display: flex;
	gap: 8px;
}

.toolbar-extra {
	margin-bottom: 12px;
}

a,
button {
	background: light-dark(#ffffff, #1e293b);
	border: 1px solid light-dark(#cbd5e1, #475569);
	border-radius: 6px;
	color: inherit;
	cursor: pointer;
	font: inherit;
	padding: 8px 10px;
	text-decoration: none;
}

button {
	background: light-dark(#fee2e2, #7f1d1d);
	border-color: light-dark(#fecaca, #991b1b);
}

.timeline {
	display: grid;
	gap: 14px;
}

.message,
.raw-json {
	background: light-dark(#ffffff, #020617);
	border: 1px solid light-dark(#dbe3ee, #334155);
	border-radius: 8px;
	margin: 0;
	padding: 14px;
}

.message-meta {
	align-items: center;
	color: light-dark(#64748b, #94a3b8);
	display: flex;
	font-size: 12px;
	gap: 8px;
	justify-content: space-between;
	margin-bottom: 10px;
}

.role {
	color: light-dark(#0f172a, #e2e8f0);
	font-weight: 700;
}

.update {
	background: light-dark(#f8fafc, #0b1220);
	border: 1px solid light-dark(#e2e8f0, #1e293b);
	border-radius: 8px;
	padding: 10px;
}

.update + .update {
	margin-top: 10px;
}

.update-title,
.label {
	color: light-dark(#475569, #cbd5e1);
	font-size: 12px;
	font-weight: 700;
	margin-bottom: 8px;
	text-transform: uppercase;
}

.label span {
	color: light-dark(#64748b, #94a3b8);
	font-weight: 400;
	text-transform: none;
}

.nested {
	display: grid;
	gap: 10px;
	grid-template-columns: minmax(260px, 0.45fr) minmax(320px, 1fr);
}

.block {
	min-width: 0;
}

.code {
	background: light-dark(#f1f5f9, #020617);
	border: 1px solid light-dark(#e2e8f0, #1e293b);
	border-radius: 6px;
	line-height: 1.5;
	margin: 0;
	overflow: auto;
	padding: 12px;
	white-space: pre-wrap;
	word-break: break-word;
}

.key,
.attr {
	color: light-dark(#7c2d12, #fdba74);
}

.string {
	color: light-dark(#166534, #86efac);
}

.literal,
.number {
	color: light-dark(#1d4ed8, #93c5fd);
}

.tag,
.pi {
	color: light-dark(#9333ea, #d8b4fe);
}

.punct {
	color: light-dark(#64748b, #94a3b8);
}

.empty {
	margin: 0;
}

@media (max-width: 860px) {
	body {
		padding: 14px;
	}

	.topbar,
	.nested {
		grid-template-columns: 1fr;
	}

	.topbar {
		align-items: stretch;
		flex-direction: column;
	}
}
`;
