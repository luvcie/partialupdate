#!/usr/bin/env node
// OpenAI-compatible /chat/completions shim backed by the local `claude` CLI.
// Bills your Claude Code subscription (no ANTHROPIC_API_KEY), not the API.
//
// Run:   node claude-openai-shim.mjs           # listens on :8787
//        PORT=9000 CLAUDE_MODEL=opus node claude-openai-shim.mjs
//        node claude-openai-shim.mjs --selftest # no network, no claude
//
// Point partialupdate's LLM fetch at http://localhost:8787/v1/chat/completions.
// It accepts POST on ANY path (treats it as a chat completion), so the exact
// path the app uses doesn't matter.

import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.CLAUDE_MODEL || ""; // "" = your Claude Code default
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// --- request translation -------------------------------------------------

// OpenAI content can be a string or an array of parts; flatten to text.
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  return "";
}

// Split an OpenAI messages[] into (system prompt, folded user/assistant prompt).
// The app resends full history each call, so we fold prior turns into one text
// prompt with role labels — claude -p is stateless here, which is what we want.
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

// --- claude stream-json parsing ------------------------------------------

// Pull assistant text out of one stream-json line. Prefers token-level
// text_delta events; falls back to whole assistant message blocks. Ignores
// thinking, tool, system/init and result events.
export function textFromLine(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (obj.type === "stream_event") {
    const ev = obj.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      return ev.delta.text || "";
    }
    return "";
  }
  return ""; // assistant/result handled separately as fallback
}

// Whole assistant message -> text (fallback when no partials arrive).
export function textFromAssistant(obj) {
  if (obj?.type !== "assistant") return "";
  const blocks = obj.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// --- protocol repair ------------------------------------------------------

// Some models (sonnet/opus) end each partialupdate message with SPLIT_MESSAGE
// but drop the required BODY_END before it, so every message except the last is
// left unterminated and the app renders the raw delimiters as visible text.
// Insert a BODY_END before any `<prefix>:SPLIT_MESSAGE` line not already
// preceded by one. Prefix is read per-line, so this stays app-agnostic.
// ponytail: assumes delimiters sit on their own lines (they do in the protocol)
// and that body content never contains a line ending in ":SPLIT_MESSAGE".
const SPLIT_RE = /^(.+):SPLIT_MESSAGE\s*$/;

export function makeSplitFixer(emit) {
  let buf = "";
  let lastNonBlank = null;

  function emitLine(line, last) {
    const trimmed = line.trim();
    const m = trimmed.match(SPLIT_RE);
    if (m && lastNonBlank !== `${m[1]}:BODY_END`) {
      emit(`${m[1]}:BODY_END\n`);
      lastNonBlank = `${m[1]}:BODY_END`;
    }
    emit(last ? line : line + "\n");
    if (trimmed) lastNonBlank = trimmed;
  }

  return {
    push(text) {
      buf += text;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) emitLine(p, false);
    },
    flush() {
      if (buf) {
        emitLine(buf, true);
        buf = "";
      }
    },
  };
}

// --- SSE helpers ---------------------------------------------------------

function sseChunk(id, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL || "claude-code",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

// --- claude invocation ---------------------------------------------------

function claudeArgs(system) {
  const args = [
    "-p",
    "--system-prompt", system || "You are a helpful assistant that replies in HTML.",
    "--tools", "", // disable all tools -> pure generation
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose", // required for stream-json in print mode
    "--no-session-persistence",
  ];
  if (MODEL) args.push("--model", MODEL);
  return args;
}

// Run claude, invoking onText(chunk) as text streams in. Resolves with the
// full text (for non-stream mode) or rejects on failure.
function runClaude({ system, prompt }, onText) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, claudeArgs(system), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let full = "";
    let assistantRaw = "";
    let sawPartial = false;
    let stderr = "";

    // Repair the protocol stream (insert missing BODY_END), then forward it.
    const fixer = makeSplitFixer((out) => {
      full += out;
      onText(out);
    });

    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let obj;
        try { obj = JSON.parse(s); } catch { continue; }
        const t = textFromLine(obj);
        if (t) { sawPartial = true; fixer.push(t); continue; }
        const a = textFromAssistant(obj);
        if (a) assistantRaw += a;
        if (obj.type === "result" && obj.is_error) stderr += `\n[result error] ${obj.error || obj.subtype || ""}`;
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      // No token-level partials? Run the whole assistant message through the fixer.
      if (!sawPartial && assistantRaw) fixer.push(assistantRaw);
      fixer.flush();
      if (code !== 0 && !full) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(full);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// --- HTTP server ---------------------------------------------------------

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
    res.end("claude-openai-shim ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid json body" } }));
    return;
  }

  const inputs = buildInputs(body.messages);
  const id = "chatcmpl-" + crypto.randomUUID();
  const stream = body.stream !== false; // default to streaming

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      await runClaude(inputs, (t) => res.write(sseChunk(id, { content: t })));
      res.write(sseChunk(id, {}, "stop"));
      res.write("data: [DONE]\n\n");
    } catch (e) {
      // stream already started; surface the error as a final content chunk
      res.write(sseChunk(id, { content: `\n<!-- shim error: ${String(e.message)} -->` }, "stop"));
      res.write("data: [DONE]\n\n");
      console.error("[shim]", e.message);
    }
    res.end();
    return;
  }

  // non-streaming
  try {
    const full = await runClaude(inputs, () => {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL || "claude-code",
      choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: "stop" }],
    }));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e.message) } }));
    console.error("[shim]", e.message);
  }
});

// --- self test (no network, no claude) -----------------------------------

function selftest() {
  const assert = (c, m) => { if (!c) throw new Error("selftest: " + m); };

  const a = buildInputs([
    { role: "system", content: "SYS" },
    { role: "user", content: "hello" },
  ]);
  assert(a.system === "SYS", "system extract");
  assert(a.prompt === "hello", "single user prompt raw");

  const b = buildInputs([
    { role: "system", content: [{ type: "text", text: "S1" }] },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
  ]);
  assert(b.system === "S1", "array content flatten");
  assert(b.prompt === "User: u1\n\nAssistant: a1\n\nUser: u2", "multi-turn fold");

  assert(textFromLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }) === "hi", "text_delta");
  assert(textFromLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } } }) === "", "thinking ignored");
  assert(textFromLine({ type: "system", subtype: "init" }) === "", "init ignored");
  assert(textFromAssistant({ type: "assistant", message: { content: [{ type: "text", text: "AB" }, { type: "tool_use" }] } }) === "AB", "assistant fallback");

  let fixed = "";
  const fx = makeSplitFixer((s) => (fixed += s));
  fx.push("X:BODY_START\n<div>a</div>\nX:SPLIT_MESSAGE\nX:BODY_START\n<div>b</div>\nX:BODY_END");
  fx.flush();
  assert(
    fixed ===
      "X:BODY_START\n<div>a</div>\nX:BODY_END\nX:SPLIT_MESSAGE\nX:BODY_START\n<div>b</div>\nX:BODY_END",
    "split fixer inserts missing BODY_END",
  );
  let fixed2 = "";
  const fx2 = makeSplitFixer((s) => (fixed2 += s));
  fx2.push("X:BODY_START\nc\nX:BODY_END\nX:SPLIT_MESSAGE\nX:BODY_START\nd\nX:BODY_END");
  fx2.flush();
  assert(!/X:BODY_END\nX:BODY_END/.test(fixed2), "no double BODY_END when already present");

  console.log("selftest ok");
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  server.listen(PORT, () => {
    console.log(`claude-openai-shim on http://localhost:${PORT}  (model: ${MODEL || "default"})`);
  });
}
