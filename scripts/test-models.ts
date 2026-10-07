#!/usr/bin/env bun
/**
 * Live smoke test: send one tiny streamed request per model through the real
 * gateway pipeline (openaiToAnthropic → callAnthropic: billing header, betas,
 * headers, credential refresh) and report which models answer, and whether
 * thinking arrives as plaintext `thinking_delta` or redacted.
 *
 * Uses real quota (a few tokens per model). Run it on the host that holds the
 * credentials after changing VERSION, betas or headers.
 *
 *   bun scripts/test-models.ts                         # every model in /v1/models
 *   bun scripts/test-models.ts claude-opus-5-5 claude-sonnet-5
 *   bun scripts/test-models.ts --json
 */
import { ensureValidToken, readCredentials } from "../src/domain/credentials.ts";
import { ensureAccountUuid } from "../src/domain/account.ts";
import { getModelCapabilities, refreshRegistry } from "../src/domain/models.ts";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";
import { callAnthropic } from "../src/upstream/anthropic-client.ts";
import { VERSION } from "../src/config.ts";

interface Result {
  model: string;
  status: "pass" | "fail";
  httpStatus: number;
  thinking: "plaintext" | "redacted" | "none";
  timeMs: number;
  error?: string;
}

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/** Drain an Anthropic SSE stream and classify what it carried. */
async function inspectStream(body: ReadableStream<Uint8Array>): Promise<{ text: string; thinking: Result["thinking"]; error?: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawThinkingBlock = false;
  let thinkingChars = 0;
  let error: string | undefined;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.type === "content_block_start" && ev.content_block?.type?.includes("thinking")) sawThinkingBlock = true;
      if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") thinkingChars += String(ev.delta.thinking ?? "").length;
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text ?? "";
      if (ev.type === "error") error = ev.error?.message ?? JSON.stringify(ev.error);
    }
  }
  const thinking = thinkingChars > 0 ? "plaintext" : sawThinkingBlock ? "redacted" : "none";
  return { text, thinking, error };
}

async function testModel(model: string): Promise<Result> {
  const started = performance.now();
  const adaptive = getModelCapabilities(model).adaptiveThinking;
  const { body, isStructuredOutput } = openaiToAnthropic({
    model,
    stream: true,
    max_tokens: adaptive ? 2048 : 32,
    // Enough reasoning to make an adaptive-thinking model think.
    ...(adaptive ? { reasoning_effort: "low" } : {}),
    messages: [{ role: "user", content: adaptive ? "What is 17 * 23? Think it through, then answer with just the number." : "Reply with exactly: OK" }],
  });
  const res = await callAnthropic(body, { model: body.model as string, isStream: true, isStructuredOutput });
  const timeMs = Math.round(performance.now() - started);
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    return { model, status: "fail", httpStatus: res.status, thinking: "none", timeMs, error: errText.slice(0, 300) };
  }
  const { text, thinking, error } = await inspectStream(res.body);
  const ok = !error && text.trim().length > 0;
  return { model, status: ok ? "pass" : "fail", httpStatus: res.status, thinking, timeMs, error: error ?? (ok ? undefined : "empty response") };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const requested = args.filter((a) => !a.startsWith("--"));

  readCredentials();
  await ensureValidToken();
  await ensureAccountUuid();
  const catalog = await refreshRegistry();
  const models = requested.length > 0 ? requested : catalog.map((m) => m.id);

  if (!json) console.log(c.dim(`CLI version ${VERSION} · ${models.length} model(s)\n`));
  const results: Result[] = [];
  for (const model of models) {
    const r = await testModel(model);
    results.push(r);
    if (json) continue;
    const mark = r.status === "pass" ? c.green("✓") : c.red("✗");
    const thinking = r.thinking === "plaintext" ? c.green("thinking:plaintext") : r.thinking === "redacted" ? c.yellow("thinking:REDACTED") : c.dim("thinking:none");
    console.log(`${mark} ${model.padEnd(32)} ${String(r.httpStatus).padEnd(4)} ${thinking.padEnd(28)} ${c.dim(`${r.timeMs}ms`)}${r.error ? `  ${c.red(r.error)}` : ""}`);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  if (json) console.log(JSON.stringify({ version: VERSION, date: new Date().toISOString(), results }, null, 2));
  else console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
