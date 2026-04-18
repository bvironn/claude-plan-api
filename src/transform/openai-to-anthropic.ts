import type { AnthropicMessage } from "../types.ts";
import { resetDynamicMap, mapToolName } from "../domain/tool-mapping.ts";
import {
  resolveModelVariant,
  getModelCapabilities,
  getEffortLevels,
  getModelLimits,
} from "../domain/models.ts";
import { buildUserMetadata } from "../domain/account.ts";
import { computeBilling } from "../upstream/billing.ts";
import { emit } from "../observability/logger.ts";
import { repairToolPairs } from "./repair-tool-pairs.ts";

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Budget tokens per effort level. Mirrors the budgets the official Claude
 * Code CLI uses for its "think" / "think hard" / "think harder" /
 * "ultrathink" triggers. Values are floor + per-step ramp; Anthropic caps
 * them per-model internally if they exceed what the model allows.
 */
const EFFORT_TO_BUDGET: Record<string, number> = {
  low: 2_048,
  medium: 4_096,
  high: 8_192,
  max: 16_000,
};

// CONTEXT_PREAMBLE (the string that used to wrap the client's forwarded
// system prompt) is intentionally GONE. The reference plugin
// `opencode-claude-auth` does NOT wrap third-party system content in any
// marker — it injects the text DIRECTLY at the head of the first user
// message, separated by "\n\n". Anthropic's safety/redaction pipeline
// appears to detect the preamble marker as a "third-party injection"
// signal and redact thinking as a countermeasure. Match the plugin's
// shape exactly to keep thinking plaintext flowing.
export const CONTEXT_PREAMBLE = "";

export interface TransformResult {
  body: Record<string, unknown>;
  isStructuredOutput: boolean;
}

export function openaiToAnthropic(body: Record<string, unknown>): TransformResult {
  resetDynamicMap();
  const { id: model, effort: suffixEffort } = resolveModelVariant(
    (body.model as string) || "sonnet",
  );
  const isHaiku = model.includes("haiku");

  // Resolve the final effort level. Precedence: body > suffix > none.
  //   - body.reasoning_effort: OpenAI-dialect (Cline, Roo, Cursor).
  //   - body.output_config.effort: Anthropic-native (OpenCode, direct SDK).
  //   - ":<level>" suffix in the model id: OpenRouter-style variant.
  // "default" is a universal sentinel that means "omit effort, let the
  // provider pick"; any value not in the model's declared effortLevels
  // is dropped with a warn log (NOT silently mapped — upstream is the
  // source of truth).
  const effectiveEffort = resolveEffort(body, model, suffixEffort);

  const respFormat = body.response_format as Record<string, unknown> | undefined;
  const isStructuredOutput = respFormat?.type === "json_schema";

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
      if (last?.role === "user" && (last as unknown as Record<string, unknown>)._batch) {
        (last.content as Array<Record<string, unknown>>).push(result);
      } else {
        const entry = { role: "user", content: [result], _batch: true } as unknown as AnthropicMessage;
        messages.push(entry);
      }
    } else {
      messages.push({ role: msg.role as string, content: msg.content as string });
    }
  }
  for (const msg of messages) delete (msg as unknown as Record<string, unknown>)._batch;

  const firstUser = messages.find((m) => m.role === "user");
  const firstText = typeof firstUser?.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser?.content)
      ? (firstUser!.content as Array<Record<string, unknown>>).find((c) => c.type === "text")?.text as string || ""
      : "";

  // Forward the client's system prompt by prepending it DIRECTLY to the
  // first user message, separated by a blank line. No wrapper marker.
  // OAuth-authenticated Claude Code requests reject third-party system
  // prompts in the system[] array, so they must travel as part of user
  // content. Matching the reference plugin's shape exactly:
  //   firstUser.content = <client system text> + "\n\n" + <original user text>
  //
  // Ordering: runs AFTER `firstText` is extracted so billing (hashed from
  // the ORIGINAL user text) is not disturbed by the forwarded system.
  if (systemPrompt !== null && systemPrompt.length > 0 && firstUser) {
    const separator = "\n\n";
    if (typeof firstUser.content === "string") {
      firstUser.content = systemPrompt + separator + firstUser.content;
    } else if (Array.isArray(firstUser.content)) {
      const blocks = firstUser.content as Array<Record<string, unknown>>;
      const textBlockIndex = blocks.findIndex((c) => c.type === "text");
      if (textBlockIndex >= 0) {
        const block = blocks[textBlockIndex] as Record<string, unknown>;
        block.text = systemPrompt + separator + ((block.text as string) || "");
      } else {
        blocks.unshift({ type: "text", text: systemPrompt + separator });
      }
    }
  }

  // System array matches the plugin's final shape: billing header (no
  // cache_control) + identity (cache_control WITHOUT `scope: "global"`).
  // The plugin preserves cache_control from the incoming identity entry
  // when present; we construct it fresh here because our request pipeline
  // builds system[] from scratch rather than editing an incoming one.
  const system: Array<Record<string, unknown>> = [
    { type: "text", text: computeBilling(firstText) },
    {
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ];

  addCacheControlToLastUserText(messages);

  const repaired = repairToolPairs(messages);

  // Resolve the per-model default max_tokens from the registry. Falls back
  // to a conservative 64000 when the upstream hasn't declared it (old models,
  // fallback catalog). Client-supplied body.max_tokens always wins.
  const limits = getModelLimits(model);
  const defaultMaxTokens = limits.maxOutputTokens ?? 64000;

  const result: Record<string, unknown> = {
    model,
    max_tokens: (body.max_tokens as number) || defaultMaxTokens,
    stream: body.stream || false,
    system,
    messages: repaired,
    metadata: buildUserMetadata(),
  };

  if (typeof body.temperature === "number") {
    result.temperature = body.temperature;
  } else if (isStructuredOutput) {
    result.temperature = 1;
  }

  const caps = getModelCapabilities(model);

  // --- Thinking / effort mode selection ---
  //
  // Departure from the previous "always adaptive" approach. The reference
  // plugin `opencode-claude-auth` works because it runs against OpenCode's
  // NATIVE anthropic provider, which sends `thinking: {type:"enabled",
  // budget_tokens:N}` directly — the form that actually forces plaintext
  // `thinking_delta` streaming.
  //
  // We're an openai-compatible proxy, so we receive `reasoning_effort` and
  // MUST translate. The previous translation (`thinking: adaptive` +
  // `output_config.effort`) produced empty-plaintext thinking blocks —
  // adaptive mode decided the prompts didn't merit streaming CoT.
  //
  // Rules:
  //   A. adaptiveThinking + effort        → thinking.enabled{budget}
  //   B. adaptiveThinking + no effort     → thinking.adaptive (model decides)
  //   C. outputEffort only (no adaptive)  → output_config.effort
  //   D. structured output                → neither (schema mode suppresses)
  //
  // thinking.enabled and output_config.effort are mutually exclusive —
  // budget_tokens already expresses effort intent.
  let usedEnabledThinking = false;
  if (!isStructuredOutput && caps.adaptiveThinking) {
    if (effectiveEffort !== null) {
      const budget = EFFORT_TO_BUDGET[effectiveEffort] ?? 4096;
      result.thinking = { type: "enabled", budget_tokens: budget };
      usedEnabledThinking = true;
    } else {
      result.thinking = { type: "adaptive" };
    }
  }

  // INTENTIONALLY OMITTED: context_management edits in the request body.
  //
  // Background: declaring `context_management.edits[].type =
  // "clear_thinking_20251015"` (even with `keep: "all"`) signals to
  // Anthropic that this client knows how to consume thinking blocks in
  // their REDACTED form (empty `thinking` text + signed ciphertext).
  // Server-side, this appears to flip the streaming pipeline into the
  // redacted-thinking codepath: the SSE stream emits a `thinking` block
  // shell with the signature filled in, but ZERO `thinking_delta`
  // events — i.e. no plaintext chain-of-thought. The audit pipeline
  // becomes useless.
  //
  // Confirmed by comparison with the reference plugin
  // `~/opencode-claude-auth` — it uses the same OAuth flow, the same
  // `context-management-2025-06-27` beta header, the same model IDs,
  // but it NEVER puts `context_management` in the request body. With
  // that single difference, the plugin obtains real `thinking_delta`
  // streaming. We mirror that behaviour here.
  //
  // What we keep:
  //   - The `context-management-2025-06-27` beta in the headers
  //     (matches the plugin) — declares the *capability* without
  //     opting into the redacted-thinking path.
  //   - The `pickContextManagementEdit()` helper and the
  //     `contextManagementEdits` registry field — still surfaced via
  //     `GET /v1/models` so future explicit clients can opt in if a
  //     real use case appears.
  //
  // If a caller ever needs explicit context-management edits (long
  // multi-turn agent runs that exceed the window), the right fix is
  // to expose an opt-in knob on the request, not to inject it by
  // default. Default behaviour optimises for the audit use-case:
  // visible thinking, byte-for-byte parity with the plugin.

  // Case C: emit output_config.effort only when we did NOT use
  // thinking.enabled. When enabled is active, budget_tokens already
  // expresses intent and effort would be redundant/conflicting.
  if (
    caps.outputEffort &&
    !isStructuredOutput &&
    effectiveEffort !== null &&
    !usedEnabledThinking
  ) {
    result.output_config = { effort: effectiveEffort };
  }

  if (isStructuredOutput) {
    const schema = (respFormat?.json_schema as Record<string, unknown>)?.schema
      ?? (respFormat as Record<string, unknown>)?.schema
      ?? {};
    result.output_config = {
      format: { type: "json_schema", schema },
    };
  }

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

  emit("debug", "transform.request", {
    model,
    messageCount: repaired.length,
    toolsCount: (result.tools as unknown[] | undefined)?.length ?? 0,
    hasSystem: systemPrompt !== null,
    isStructuredOutput,
    isHaiku,
  });

  return { body: result, isStructuredOutput };
}

function addCacheControlToLastUserText(messages: AnthropicMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      msg.content = [
        { type: "text", text: msg.content, cache_control: { type: "ephemeral", ttl: "1h" } },
      ] as unknown as AnthropicMessage["content"];
      return;
    }
    if (Array.isArray(msg.content)) {
      const arr = msg.content as Array<Record<string, unknown>>;
      for (let j = arr.length - 1; j >= 0; j--) {
        const item = arr[j];
        if (!item) continue;
        if (item.type === "text") {
          item.cache_control = { type: "ephemeral", ttl: "1h" };
          return;
        }
      }
    }
    return;
  }
}

/**
 * Decide the effort value to send upstream. Returns null to mean "omit
 * output_config.effort entirely" (Anthropic will use its own default).
 *
 * Inputs checked, in precedence order:
 *   1. body.reasoning_effort                    (OpenAI dialect, top-level)
 *   2. body.options.reasoning_effort            (AI SDK v4 / OpenCode nested convention)
 *   3. body.options.effort                      (AI SDK alt)
 *   4. body.output_config.effort                (Anthropic-native dialect)
 *   5. Suffix parsed from the model id          (":high" style)
 *
 * Why body.options.* matters: Vercel's @ai-sdk/openai-compatible (used by
 * OpenCode and some Cline forks) places provider-specific params INSIDE a
 * nested `options` object rather than at the top level. Without this read
 * the effort selected by the user silently never reaches the upstream.
 *
 * Validation rules:
 *   - "default" → always returns null (omit).
 *   - Any value NOT in the model's declared effortLevels returns null and
 *     emits a warn. We do not invent mappings like xhigh→max — upstream
 *     is the source of truth, so invalid values are dropped.
 *   - If the resolved model does not support effort at all, returns null
 *     regardless of what the caller asked for.
 */
function resolveEffort(
  body: Record<string, unknown>,
  model: string,
  suffixEffort: string | null,
): string | null {
  const options = body.options as Record<string, unknown> | undefined;
  const outputConfig = body.output_config as Record<string, unknown> | undefined;
  const bodyEffortRaw =
    (body.reasoning_effort as string | undefined) ??
    (options?.reasoning_effort as string | undefined) ??
    (options?.effort as string | undefined) ??
    (outputConfig?.effort as string | undefined);

  const requested = bodyEffortRaw ?? suffixEffort;
  if (requested == null) return null;

  if (bodyEffortRaw && suffixEffort && bodyEffortRaw !== suffixEffort) {
    emit("warn", "models.variant.effort_conflict", {
      model,
      fromBody: bodyEffortRaw,
      fromSuffix: suffixEffort,
      chose: "body",
    });
  }

  const normalized = requested.toLowerCase();
  if (normalized === "default") return null;

  const supported = getEffortLevels(model);
  if (!supported.includes(normalized)) {
    emit("warn", "models.variant.effort_dropped", {
      model,
      requested: normalized,
      supported: [...supported],
      reason: supported.length === 0 ? "model_does_not_support_effort" : "level_not_declared",
    });
    return null;
  }

  return normalized;
}
