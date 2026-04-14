// index.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appendFileSync } from "node:fs";
// --- Types ---
interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
interface AnthropicMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}
// --- Config ---
const PORT = parseInt(process.argv[2] || Bun.env.PORT || "3456", 10);
const CREDENTIALS_PATH = Bun.env.CREDENTIALS_PATH || join(homedir(), ".claude", ".credentials.json");
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const REFRESH_URL = "https://claude.ai/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const VERSION = "2.1.90";
const SALT = "59cf53e54c78";
const MAX_RETRIES = 3;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LOG_PATH = Bun.env.LOG_PATH || "/var/log/claude-plan-api.log";
// --- Anti-loop guard ---
const MAX_CONSECUTIVE_TOOL_ERRORS = 2;
const toolErrorCounters: Map<string, number> = new Map();
function trackToolError(sessionId: string): boolean {
  const count = (toolErrorCounters.get(sessionId) || 0) + 1;
  toolErrorCounters.set(sessionId, count);
  if (count >= MAX_CONSECUTIVE_TOOL_ERRORS) {
    toolErrorCounters.delete(sessionId);
    log("WARN", `[${sessionId}] Anti-loop: ${count} consecutive tool errors, aborting session`);
    return true;
  }
  return false;
}
function resetToolErrorCounter(sessionId: string) {
  toolErrorCounters.delete(sessionId);
}
const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-1": "claude-opus-4-1-20250805",
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "claude-opus-4-1-20250805": "claude-opus-4-1-20250805",
  "claude-opus-4-20250514": "claude-opus-4-20250514",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307": "claude-3-haiku-20240307",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};
const MODELS_LIST = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307",
].map((id) => ({ id, object: "model" as const, owned_by: "anthropic" }));
const TOOL_NAME_MAP: Record<string, string> = {
  question: "AskUserQuestion",
  bash: "Bash",
  exec: "CodeExec",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  skill: "Skill",
  delegate: "Agent",
  delegation_read: "View",
  delegation_list: "TaskList",
};
let dynamicToolMap: Record<string, string> = {};
let dynamicToolReverse: Record<string, string> = {};
function resetDynamicMap() {
  dynamicToolMap = {};
  dynamicToolReverse = {};
}
function sanitizeToolName(name: string): string {
  // Anthropic tool names: [a-zA-Z0-9_], max 64 chars, must start with a letter
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "T" + s;
  return s.slice(0, 64);
}
function mapToolNameFn(name: string): string {
  if (TOOL_NAME_MAP[name]) return TOOL_NAME_MAP[name];
  if (dynamicToolMap[name]) return dynamicToolMap[name];
  // Derive mapped name deterministically from the original name
  const sanitized = sanitizeToolName(name);
  // Collision check: two different originals with same sanitized name
  const usedSanitized = new Set([
    ...Object.values(TOOL_NAME_MAP),
    ...Object.values(dynamicToolMap),
  ]);
  let mapped = sanitized;
  let suffix = 2;
  while (usedSanitized.has(mapped)) {
    mapped = `${sanitized}_${suffix++}`;
  }
  dynamicToolMap[name] = mapped;
  dynamicToolReverse[mapped] = name;
  return mapped;
}
const TOOL_NAME_REVERSE = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([k, v]) => [v, k])
);
// --- State ---
let credentials: Credentials | null = null;
let refreshPromise: Promise<void> | null = null;
// --- Credentials ---
function readCredentials(): Credentials {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  credentials = raw.claudeAiOauth;
  return credentials!;
}
function writeCredentials(accessToken: string, refreshToken: string, expiresIn: number) {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  raw.claudeAiOauth.accessToken = accessToken;
  raw.claudeAiOauth.refreshToken = refreshToken;
  raw.claudeAiOauth.expiresAt = Date.now() + expiresIn * 1000;
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(raw, null, 2));
  credentials = raw.claudeAiOauth;
}
async function refreshToken(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials!.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    writeCredentials(
      data.access_token as string,
      data.refresh_token as string,
      data.expires_in as number
    );
    log("INFO", "Token refreshed");
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
async function ensureValidToken() {
  readCredentials();
  if (Date.now() > credentials!.expiresAt - REFRESH_MARGIN_MS) {
    log("INFO", "Token near expiry, refreshing...");
    await refreshToken();
  }
}
// --- Billing ---
function computeBilling(firstUserMessage: string): string {
  const msg = firstUserMessage || "";
  const cch = createHash("sha256").update(msg).digest("hex").slice(0, 5);
  const sampled = [4, 7, 20].map((i) => (i < msg.length ? msg[i] : "0")).join("");
  const suffix = createHash("sha256").update(`${SALT}${sampled}${VERSION}`).digest("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; cc_entrypoint=cli; cch=${cch};`;
}
// --- Headers ---
function buildBetas(model: string): string {
  const parts = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
  ];
  if (model.includes("haiku")) {
    const idx = parts.indexOf("interleaved-thinking-2025-05-14");
    if (idx !== -1) parts.splice(idx, 1);
  }
  if (model.includes("4-6")) parts.push("effort-2025-11-24");
  return parts.join(",");
}
function buildHeaders(model: string): Record<string, string> {
  return {
    authorization: `Bearer ${credentials!.accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": buildBetas(model),
    "x-app": "cli",
    "user-agent": `claude-cli/${VERSION} (external, cli)`,
    "content-type": "application/json",
  };
}
// --- Format Conversion ---
function resolveModel(input: string): string {
  return MODEL_MAP[input] || MODEL_MAP[input.replace(/^(openai|claude-local)\//, "")] || MODEL_MAP["sonnet"];
}
function mapToolName(name: string): string {
  return mapToolNameFn(name);
}
function unmapToolName(name: string): string {
  return TOOL_NAME_REVERSE[name] || dynamicToolReverse[name] || name;
}
function openaiToAnthropic(body: Record<string, unknown>) {
  resetDynamicMap();
  const model = resolveModel(body.model as string || "sonnet");
  const messages: AnthropicMessage[] = [];
  let systemPrompt: string | null = null;
  for (const msg of (body.messages as Array<Record<string, unknown>>) || []) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    } else if (msg.role === "assistant" && msg.tool_calls) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown>;
        let input = {};
        try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments as string) : fn.arguments || {}; } catch {}
        content.push({ type: "tool_use", id: tc.id, name: mapToolName(fn.name as string), input });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const last = messages[messages.length - 1];
      const result = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };
      if (last?.role === "user" && (last as Record<string, unknown>)._batch) {
        (last.content as Array<Record<string, unknown>>).push(result);
      } else {
        const entry = { role: "user", content: [result], _batch: true } as unknown as AnthropicMessage;
        messages.push(entry);
      }
    } else {
      messages.push({ role: msg.role as string, content: msg.content as string });
    }
  }
  for (const msg of messages) delete (msg as Record<string, unknown>)._batch;
  const firstUser = messages.find((m) => m.role === "user");
  const firstText = typeof firstUser?.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser?.content)
      ? (firstUser!.content as Array<Record<string, unknown>>).find((c) => c.type === "text")?.text as string || ""
      : "";
  const system: Array<Record<string, unknown>> = [{ type: "text", text: computeBilling(firstText) }];
  if (systemPrompt) {
    system.push({ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } });
  }
  const result: Record<string, unknown> = {
    model,
    max_tokens: (body.max_tokens as number) || 4096,
    stream: body.stream || false,
    system,
    messages,
  };
  if (body.tools && (body.tools as unknown[]).length > 0) {
    result.tools = (body.tools as Array<Record<string, unknown>>).map((t) => {
      const fn = t.function as Record<string, unknown>;
      return {
        name: mapToolName(fn.name as string),
        description: (fn.description as string) || "",
        input_schema: fn.parameters || { type: "object", properties: {} },
      };
    });
  }
  return result;
}
function anthropicToOpenai(res: Record<string, unknown>, model: string) {
  const content = (res.content as Array<Record<string, unknown>>) || [];
  const textBlock = content.find((c) => c.type === "text");
  const toolBlocks = content.filter((c) => c.type === "tool_use");
  const stopMap: Record<string, string> = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  const message: Record<string, unknown> = { role: "assistant", content: (textBlock?.text as string) || null };
  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((tu) => ({
      id: tu.id,
      type: "function",
      function: { name: unmapToolName(tu.name as string), arguments: JSON.stringify(tu.input) },
    }));
  }
  const usage = res.usage as Record<string, number> || {};
  return {
    id: res.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopMap[res.stop_reason as string] || "stop" }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}
// --- Logging helpers ---
function logRequest(anthropicBody: Record<string, unknown>, model: string, isStream: boolean) {
  const messages = anthropicBody.messages as Array<Record<string, unknown>>;
  const tools = (anthropicBody.tools as Array<Record<string, unknown>>) || [];
  const system = anthropicBody.system as Array<Record<string, unknown>>;
  const lines: string[] = [];
  lines.push(`REQUEST model=${model} messages=${messages.length} tools=${tools.length} stream=${isStream}`);
  lines.push(`system_blocks=${system.length} max_tokens=${anthropicBody.max_tokens}`);
  if (tools.length > 0) {
    lines.push(`tools: ${tools.map((t) => t.name).join(", ")}`);
  }
  lines.push("messages:");
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const parts = m.content as Array<Record<string, unknown>>;
      for (const p of parts) {
        if (p.type === "tool_use") {
          let args = "";
          try { args = JSON.stringify(p.input, null, 2).replace(/\n/g, "\n"); } catch {}
          lines.push(`[${m.role}] tool_use → ${p.name}`);
          lines.push(`${args}`);
        } else if (p.type === "tool_result") {
          const content = String(p.content || "").slice(0, 300);
          lines.push(`[tool_result id=${p.tool_use_id}] ${content}${String(p.content || "").length > 300 ? "…" : ""}`);
        } else if (p.type === "text") {
          const text = String(p.text || "").slice(0, 300);
          lines.push(`[${m.role}] ${text}${String(p.text || "").length > 300 ? "…" : ""}`);
        }
      }
    } else {
      const text = String(m.content || "").slice(0, 300);
      lines.push(`[${m.role}] ${text}${String(m.content || "").length > 300 ? "…" : ""}`);
    }
  }
  log("REQUEST", lines.join("\n"));
}
function logResponse(model: string, stopReason: string, text: string, tools: Array<{ name: string; arguments: string }>, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  const lines: string[] = [];
  lines.push(`RESPONSE model=${model} stop=${stopReason}`);
  if (text) {
    const preview = text.length > 500 ? text.slice(0, 500) + "…" : text;
    lines.push(`text: ${preview.replace(/\n/g, "\n")}`);
  }
  for (const tool of tools) {
    let args = tool.arguments;
    try { args = JSON.stringify(JSON.parse(tool.arguments), null, 2).replace(/\n/g, "\n"); } catch {}
    lines.push(`tool_call: ${tool.name}`);
    lines.push(`args: ${args}`);
  }
  const cacheHit = usage.cache_read_input_tokens > 0 ? ` [CACHE HIT: ${usage.cache_read_input_tokens} tokens saved]` : "";
  const cacheWrite = usage.cache_creation_input_tokens > 0 ? ` [CACHE WRITE: ${usage.cache_creation_input_tokens}]` : "";
  lines.push(`USAGE input=${usage.input_tokens} output=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens} cache_write=${usage.cache_creation_input_tokens} total=${usage.input_tokens + usage.output_tokens}${cacheHit}${cacheWrite}`);
  log("RESPONSE", lines.join("\n"));
}
// --- Streaming ---
function streamAnthropicToOpenai(anthropicStream: ReadableStream<Uint8Array>, model: string): ReadableStream {
  const decoder = new TextDecoder();
  let buffer = "";
  let msgId = `chatcmpl-${Date.now()}`;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let toolIndex = -1;
  let sentRole = false;
  let stopReason = "end_turn";
  // Accumulate full response for logging
  let responseText = "";
  const responseTools: Array<{ name: string; arguments: string }> = [];
  let currentToolArgs = "";
  const stopMap: Record<string, string> = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  function chunk(data: Record<string, unknown>): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }
  return new ReadableStream({
    async start(controller) {
      const reader = anthropicStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (!json || json === "[DONE]") continue;
            try {
              const event = JSON.parse(json);
              if (event.type === "message_start") {
                if (event.message?.id) msgId = event.message.id;
                if (event.message?.usage) {
                  usage.input_tokens = event.message.usage.input_tokens || 0;
                  usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
                  usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
                }
              } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                toolIndex++;
                currentToolArgs = "";
                const name = unmapToolName(event.content_block.name);
                responseTools.push({ name, arguments: "" });
                controller.enqueue(chunk({
                  id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), tool_calls: [{ index: toolIndex, id: event.content_block.id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
                }));
                sentRole = true;
              } else if (event.type === "content_block_delta") {
                if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
                  currentToolArgs += event.delta.partial_json;
                  if (responseTools[toolIndex]) responseTools[toolIndex].arguments = currentToolArgs;
                  controller.enqueue(chunk({
                    id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }],
                  }));
                } else if (event.delta?.text) {
                  responseText += event.delta.text;
                  controller.enqueue(chunk({
                    id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), content: event.delta.text }, finish_reason: null }],
                  }));
                  sentRole = true;
                }
              } else if (event.type === "message_delta") {
                if (event.usage) usage.output_tokens = event.usage.output_tokens || 0;
                if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
                controller.enqueue(chunk({
                  id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: {}, finish_reason: stopMap[event.delta?.stop_reason] || "stop" }],
                  usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens },
                }));
              } else if (event.type === "message_stop") {
                logResponse(model, stopReason, responseText, responseTools, usage);
              }
            } catch {}
          }
        }
        controller.enqueue("data: [DONE]\n\n");
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
// --- Request Handler ---
async function handleChat(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const messages = (body.messages as Array<Record<string, unknown>>) || [];
  const sessionId = (messages[0]?.content as string)?.slice(0, 40) || `session-${Date.now()}`;
  let trailingErrors = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.includes("unavailable tool")) {
      trailingErrors++;
    } else {
      break;
    }
  }
  if (trailingErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
    log("WARN", `[${sessionId}] Anti-loop: ${trailingErrors} consecutive tool errors detected in history, aborting`);
    return Response.json({
      error: {
        message: `Loop detectado: ${trailingErrors} errores consecutivos de tool inválida. Revisá el mapeo de tools en el proxy.`,
        type: "proxy_error",
        code: 400,
      }
    }, { status: 400 });
  }
  await ensureValidToken();
  const anthropicBody = openaiToAnthropic(body);
  const model = anthropicBody.model as string;
  const isStream = anthropicBody.stream as boolean;
  const headers = buildHeaders(model);
  logRequest(anthropicBody, model, isStream);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicBody),
    });
    if (res.ok) {
      resetToolErrorCounter(sessionId);
      if (isStream) {
        return new Response(streamAnthropicToOpenai(res.body!, model), {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }
      const data = await res.json() as Record<string, unknown>;
      const usage = (data.usage as Record<string, number>) || {};
      const content = (data.content as Array<Record<string, unknown>>) || [];
      const textBlock = content.find((c) => c.type === "text");
      const toolBlocks = content.filter((c) => c.type === "tool_use");
      logResponse(
        model,
        String(data.stop_reason || "end_turn"),
        String(textBlock?.text || ""),
        toolBlocks.map((tu) => ({ name: unmapToolName(tu.name as string), arguments: JSON.stringify(tu.input) })),
        {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        }
      );
      return Response.json(anthropicToOpenai(data, model));
    }
    const errorBody = await res.text();
    if (res.status === 401 && attempt === 0) {
      log("WARN", "401 — refreshing token");
      await refreshToken();
      continue;
    }
    if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
      const wait = parseInt(res.headers.get("retry-after") || "") || 2 ** attempt;
      log("WARN", `${res.status} — retry in ${wait}s`);
      await Bun.sleep(wait * 1000);
      continue;
    }
    log("ERROR", `Anthropic ${res.status}: ${errorBody}`);
    return Response.json({ error: { message: errorBody, type: "error", code: res.status } }, { status: res.status });
  }
  return Response.json({ error: { message: "Max retries exceeded", type: "error", code: 502 } }, { status: 502 });
}
// --- Utils ---

// SSE subscribers for /logs endpoint
const logSubscribers: Set<(data: string) => void> = new Set();

function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(LOG_PATH, line);
  } catch (e) {
    process.stdout.write(`[WARN] No se pudo escribir en ${LOG_PATH}: ${(e as Error).message}\n`);
  }
  const sseData = `data: ${JSON.stringify({ ts, level, msg })}\n\n`;
  for (const emit of logSubscribers) {
    try { emit(sseData); } catch {}
  }
}
// --- Server ---
readCredentials();
log("INFO", `Credentials loaded. Expires ${new Date(credentials!.expiresAt).toISOString()}`);
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const { method, pathname } = { method: req.method, pathname: url.pathname };
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    try {
      if (method === "GET" && pathname === "/health") return Response.json({ status: "ok" });
      if (method === "GET" && pathname === "/v1/models") return Response.json({ object: "list", data: MODELS_LIST });
      if (method === "GET" && pathname === "/logs") {
        let emitFn: (data: string) => void;
        const stream = new ReadableStream({
          start(controller) {
            emitFn = (data: string) => controller.enqueue(new TextEncoder().encode(data));
            logSubscribers.add(emitFn);
            try {
              const content = readFileSync(LOG_PATH, "utf8");
              const lines = content.trim().split("\n").slice(-100);
              for (const rawLine of lines) {
                const match = rawLine.match(/^\[(.+?)\] \[(.+?)\] ([\s\S]*)$/);
                if (match) {
                  const entry = { ts: match[1], level: match[2], msg: match[3] };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(entry)}\n\n`));
                }
              }
            } catch {}
          },
          cancel() { logSubscribers.delete(emitFn); },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      if (method === "POST" && pathname === "/v1/chat/completions") return await handleChat(req);
      return Response.json({ error: { message: `Not found: ${method} ${pathname}` } }, { status: 404 });
    } catch (err) {
      log("ERROR", `${(err as Error).message}`);
      return Response.json({ error: { message: (err as Error).message } }, { status: 500 });
    }
  },
});
log("INFO", `claude-plan-api listening on http://127.0.0.1:${server.port}`);
log("INFO", `POST http://127.0.0.1:${server.port}/v1/chat/completions`);
setInterval(() => ensureValidToken().catch((e) => log("ERROR", `Refresh: ${e.message}`)), 60_000);