/**
 * BARE thinking test: issue a direct /v1/messages request to Anthropic
 * WITHOUT going through our proxy's transform/header pipeline.
 *
 * Purpose: isolate whether the thinking-redaction issue is:
 *   (A) something our proxy is doing (body shape / headers)
 *   (B) something server-side (account / OAuth scope)
 *
 * This script uses ONLY the proxy's credentials module to read the
 * OAuth token — everything else (body, headers, billing header) is
 * hand-rolled here, byte-for-byte mirroring the opencode-claude-auth
 * plugin. The token value is never printed.
 *
 * Usage:
 *   bun run scripts/bare-thinking-test.ts
 */

import { readCredentials } from "../src/domain/credentials.ts";

const creds = readCredentials();
const token = creds.accessToken;

const reqId = crypto.randomUUID();
const sessId = crypto.randomUUID();

// Replicate the kind of body the proxy sends when thinking+tools are
// active — that is the scenario where the model DOES emit a thinking
// block (and where we observe the empty plaintext + signature pattern).
const body = {
  model: "claude-opus-4-7",
  max_tokens: 32000,
  stream: true,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.90; cc_entrypoint=cli;" },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ],
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "max" },
  tool_choice: { type: "auto" },
  tools: [
    {
      name: "mcp_Bash",
      description:
        "Executes a given bash command in a persistent shell session with optional timeout.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute" },
          timeout: { type: "number", description: "Optional timeout in ms" },
        },
        required: ["command"],
      },
    },
    {
      name: "mcp_Read",
      description: "Read a file from the local filesystem.",
      input_schema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file" },
        },
        required: ["filePath"],
      },
    },
  ],
  messages: [
    {
      role: "user",
      content:
        "Antes de responder necesito que pienses en profundidad. Dado el directorio `/tmp/project-x`, planifica los pasos para encontrar el archivo de configuración principal (puede llamarse config.json, config.yaml, .env, package.json u otros formatos), leerlo e identificar qué puerto expone el servicio. Piensa cuidadosamente qué comandos usar con mcp_Bash vs mcp_Read, qué hacer si el archivo está en subdirectorios, y cómo distinguir el puerto entre múltiples candidatos. No ejecutes tools todavía — describe tu plan paso a paso primero.",
    },
  ],
};

const headers: Record<string, string> = {
  authorization: `Bearer ${token}`,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "effort-2025-11-24",
    "structured-outputs-2025-11-13",
    "fine-grained-tool-streaming-2025-05-14",
  ].join(","),
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.90 (external, cli)",
  "x-client-request-id": reqId,
  "X-Claude-Code-Session-Id": sessId,
  "content-type": "application/json",
};

console.log("=== SENDING DIRECT REQUEST TO api.anthropic.com (NO PROXY) ===");
console.log("model:", body.model);
console.log("thinking:", JSON.stringify(body.thinking));
console.log("headers (no auth printed):");
for (const [k, v] of Object.entries(headers)) {
  if (k.toLowerCase() === "authorization") continue;
  console.log(`  ${k}: ${v}`);
}
console.log("x-client-request-id:", reqId);
console.log();

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

console.log("=== HTTP RESPONSE ===");
console.log("status:", res.status);
console.log("content-type:", res.headers.get("content-type"));
console.log();

if (!res.ok) {
  const text = await res.text();
  console.log("ERROR BODY:");
  console.log(text.slice(0, 2000));
  process.exit(1);
}

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
let thinkingDeltas = 0;
let textDeltas = 0;
let contentBlockStarts = 0;
let contentBlockStartsJson: string[] = [];
let allBytes = 0;
let firstEvents: string[] = [];

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value, { stream: true });
  buffer += chunk;
  allBytes += chunk.length;

  // Simple line scanner — SSE events are separated by \n\n.
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    if (!raw.includes("data:")) continue;
    // Keep first 12 events raw for inspection.
    if (firstEvents.length < 12) firstEvents.push(raw);
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.slice(5).trim();
    if (payload.includes('"thinking_delta"')) thinkingDeltas++;
    if (payload.includes('"text_delta"')) textDeltas++;
    if (payload.includes('"content_block_start"')) {
      contentBlockStarts++;
      contentBlockStartsJson.push(payload);
    }
  }
}

console.log("=== RESULT SUMMARY ===");
console.log("total bytes:", allBytes);
console.log("content_block_start events:", contentBlockStarts);
console.log("thinking_delta events:", thinkingDeltas);
console.log("text_delta events:", textDeltas);
console.log();

console.log("=== CONTENT BLOCK STARTS (thinking block shows if plaintext or redacted) ===");
for (const s of contentBlockStartsJson) {
  console.log(s.slice(0, 500));
  console.log("---");
}

console.log();
console.log("=== FIRST 6 EVENTS RAW ===");
for (const e of firstEvents.slice(0, 6)) {
  console.log(e);
  console.log("---");
}

if (thinkingDeltas > 0) {
  console.log();
  console.log("✅ VERDICT: thinking_delta IS streaming → problem is NOT server-side");
  console.log("  → the redaction must be triggered by something our proxy does");
  console.log("  → diff this script's body/headers against the proxy's and find the delta");
} else {
  console.log();
  console.log("❌ VERDICT: thinking_delta is 0 → problem IS server-side (account / OAuth / IP)");
  console.log("  → proxy is NOT at fault; no client-side fix will unlock plaintext");
}
