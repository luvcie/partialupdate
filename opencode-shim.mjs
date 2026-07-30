#!/usr/bin/env node
// OpenAI-compatible /chat/completions shim backed by a local `opencode serve`.
// Lets partialupdate run on whatever model opencode is logged into (Zen credits,
// Copilot sub, etc.) with no separate API key in the app.
//
// Run:   opencode serve            # in one terminal (defaults to :4096)
//        node opencode-shim.mjs     # in another (defaults to :8790)
//        # then in the app: CLAUDE_SHIM_URL=http://localhost:8790/v1/chat/completions
//        node opencode-shim.mjs --selftest   # offline, no opencode needed
//
// Env: PORT (8790), OPENCODE_URL (http://127.0.0.1:4096),
//      OPENCODE_MODEL (optional "provider/model"; omit to use opencode's default)
//
// NOTE: v1 is blocking (no token streaming), so the app renders the reply at
// once instead of progressively. Streaming is the upgrade path: subscribe to
// GET /event and forward text-part deltas. See --doc probe below to confirm the
// exact API shapes on the target machine before trusting this.

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8790);
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const MODEL_STR = process.env.OPENCODE_MODEL || "";
const MODEL = MODEL_STR ? (() => {
  const parts = MODEL_STR.split("/");
  if (parts.length === 2) return { providerID: parts[0], modelID: parts[1] };
  return { providerID: MODEL_STR, modelID: MODEL_STR };
})() : null;
const MODEL_NAME = MODEL_STR || "opencode";

// --- request translation (shared shape with claude-openai-shim) -----------

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  return "";
}

export function buildInputs(messages = []) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => contentToText(m.content))
    .join("\n\n")
    .trim();

  const turns = messages.filter((m) => m.role !== "system");
  let prompt;
  if (turns.length <= 1) {
    prompt = contentToText(turns[0]?.content).trim();
  } else {
    prompt = turns
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${contentToText(m.content)}`)
      .join("\n\n");
  }
  return { system, prompt };
}

// Pull assistant text out of opencode's response `parts`. Only text parts;
// skip tool calls, reasoning, step markers. Handles a couple of field names
// since the exact Part shape must be confirmed against /doc.
export function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text")
    .map((p) => p.text ?? p.content ?? "")
    .join("");
}

// Insert a BODY_END before any `<prefix>:SPLIT_MESSAGE` line that lacks one,
// so a model that forgets to close each message doesn't leak raw delimiters.
// Runs over the full reply (blocking mode), so no streaming-boundary handling.
const SPLIT_RE = /^(.+):SPLIT_MESSAGE\s*$/;

export function fixSplits(text) {
  let out = "";
  let lastNonBlank = null;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const m = trimmed.match(SPLIT_RE);
    if (m && lastNonBlank !== `${m[1]}:BODY_END`) {
      out += `${m[1]}:BODY_END\n`;
      lastNonBlank = `${m[1]}:BODY_END`;
    }
    out += i === lines.length - 1 ? line : line + "\n";
    if (trimmed) lastNonBlank = trimmed;
  });
  return out;
}

// --- opencode calls -------------------------------------------------------

async function runOpencode({ system, prompt }) {
  // 1. create a fresh session (stateless: app resends full history each turn)
  const sRes = await fetch(`${OPENCODE_URL}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "partialupdate" }),
  });
  if (!sRes.ok) throw new Error(`create session ${sRes.status}: ${await sRes.text().catch(() => "")}`);
  const session = await sRes.json();
  const id = session.id ?? session.sessionID ?? session.session?.id;
  if (!id) throw new Error(`no session id in ${JSON.stringify(session).slice(0, 200)}`);

  // 2. send the message and wait for the full reply
  const body = {
    parts: [{ type: "text", text: prompt }],
    tools: {}, // pure generation, no tool calls
    ...(system ? { system } : {}),
    ...(MODEL ? { model: MODEL } : {}),
  };
  const mRes = await fetch(`${OPENCODE_URL}/session/${encodeURIComponent(id)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!mRes.ok) throw new Error(`message ${mRes.status}: ${await mRes.text().catch(() => "")}`);
  const out = await mRes.json();

  // 3. best-effort cleanup, ignore if the route differs
  fetch(`${OPENCODE_URL}/session/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});

  return fixSplits(partsToText(out.parts ?? out.info?.parts));
}

// --- SSE + HTTP -----------------------------------------------------------

function sseChunk(id, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("opencode-shim ok");
    return;
  }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { res.writeHead(400).end('{"error":"invalid json"}'); return; }

  const inputs = buildInputs(body.messages);
  const id = "chatcmpl-" + crypto.randomUUID();
  const stream = body.stream !== false;

  try {
    const text = await runOpencode(inputs);
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(sseChunk(id, { content: text }));
      res.write(sseChunk(id, {}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: MODEL || "opencode",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }));
    }
  } catch (e) {
    console.error("[opencode-shim]", e.message);
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseChunk(id, { content: `<!-- opencode-shim error: ${e.message} -->` }, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  }
});

// --- self test (offline) --------------------------------------------------

function selftest() {
  const assert = (c, m) => { if (!c) throw new Error("selftest: " + m); };

  const a = buildInputs([
    { role: "system", content: "SYS" },
    { role: "user", content: "hello" },
  ]);
  assert(a.system === "SYS" && a.prompt === "hello", "single turn");

  const b = buildInputs([
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ]);
  assert(b.prompt === "User: u1\n\nAssistant: a1\n\nUser: u2", "multi-turn fold");

  assert(partsToText([{ type: "text", text: "A" }, { type: "tool", text: "x" }, { type: "text", content: "B" }]) === "AB", "parts text only");
  assert(partsToText(undefined) === "", "parts undefined safe");

  assert(
    fixSplits("X:BODY_START\na\nX:SPLIT_MESSAGE\nX:BODY_START\nb\nX:BODY_END") ===
      "X:BODY_START\na\nX:BODY_END\nX:SPLIT_MESSAGE\nX:BODY_START\nb\nX:BODY_END",
    "fixSplits inserts missing BODY_END",
  );
  assert(!/X:BODY_END\nX:BODY_END/.test(fixSplits("X:BODY_START\na\nX:BODY_END\nX:SPLIT_MESSAGE\nX:BODY_START\nb\nX:BODY_END")), "no double BODY_END");

  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) {
  selftest();
} else if (process.argv.includes("--doc")) {
  // print the probe commands to confirm the API on the target machine
  console.log(`# confirm opencode serve API shapes before trusting this shim:
curl ${OPENCODE_URL}/doc | less                     # full OpenAPI spec
SID=$(curl -s -XPOST ${OPENCODE_URL}/session -H 'content-type: application/json' -d '{"title":"probe"}' | tee /dev/stderr | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
curl -s -XPOST ${OPENCODE_URL}/session/$SID/message -H 'content-type: application/json' \\
  -d '{"system":"reply in one word","parts":[{"type":"text","content":"hi"}]}' | node -e 'process.stdin.on("data",d=>console.log(JSON.stringify(JSON.parse(d),null,2)))'`);
} else {
  server.listen(PORT, () => {
    console.log(`opencode-shim on http://localhost:${PORT} -> ${OPENCODE_URL} (model: ${MODEL_NAME || "opencode default"})`);
  });
}
