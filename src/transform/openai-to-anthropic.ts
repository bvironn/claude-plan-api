import type { AnthropicMessage } from "../types.ts";
import { createToolMap, mapToolName, type ToolMap } from "../domain/tool-mapping.ts";
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
import { isClaudeCodeIdentityEnabled } from "../config.ts";

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// =============================================================================
// Vision block translation (OpenAI / Responses API → Anthropic-native)
// =============================================================================
//
// Anthropic accepts ONLY its native `image` block shape with a typed `source`
// (either `{type:"base64", media_type, data}` or `{type:"url", url}`).
// OpenAI clients send `{type:"image_url", image_url:{url}|"<url>"}`; the
// Responses API uses `{type:"input_image", image_url:...}`. Without
// translation Anthropic returns HTTP 400 on the literal `image_url` tag,
// and tool messages with array content silently lose their images via
// `JSON.stringify`. The helpers below translate both forms in a single
// pure pass; malformed or unsafe blocks are dropped with a `warn` event.

/**
 * Pull the URL out of an OpenAI / Responses-API image block. Handles both
 * the object form (`image_url: { url }`) and the legacy string form
 * (`image_url: "..."`). Returns null if no usable URL exists — caller
 * decides whether to drop the block.
 */
function extractImageUrl(block: Record<string, unknown>): string | null {
  const iu = block.image_url;
  if (typeof iu === "string") return iu;
  if (iu && typeof iu === "object") {
    const url = (iu as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return null;
}

/**
 * Convert an extracted URL to an Anthropic `source` object. `data:` URIs
 * become `base64` sources (media_type parsed from the MIME segment);
 * `http(s)://` URLs become `url` sources. Any other scheme returns null
 * — the caller drops the block to avoid forwarding `file://` or other
 * potentially unsafe URIs to the upstream.
 */
function imageUrlToAnthropicSource(url: string): Record<string, unknown> | null {
  const m = url.match(/^data:([^;,]+);base64,(.*)$/);
  if (m) return { type: "base64", media_type: m[1], data: m[2] };
  if (/^https?:\/\//i.test(url)) return { type: "url", url };
  return null;
}

/**
 * Convert an OpenAI / Responses-API content array into Anthropic's native
 * shape. Recognized inputs:
 *   - {type: "image_url", image_url: {url} | "<url>"}      → image base64|url
 *   - {type: "input_image", image_url: ...}                → identical to above
 *   - {type: "image", source: ...} (already native)        → pass-through
 *   - {type: "text", text}                                  → pass-through
 *   - any other block shape (tool_use, tool_result, ...)   → pass-through
 *
 * Malformed / unsafe blocks are dropped with a `transform.image_block_dropped`
 * warn event; the helper NEVER throws. Anthropic accepts both string and
 * array shapes for `tool_result.content`, so this helper is safe to call
 * on any array source.
 */
export function toAnthropicContentBlocks(
  content: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    const t = block.type;
    if (t === "image_url" || t === "input_image") {
      const url = extractImageUrl(block);
      if (!url) {
        emit("warn", "transform.image_block_dropped", { reason: "no_url", urlPrefix: "" });
        continue;
      }
      const source = imageUrlToAnthropicSource(url);
      if (!source) {
        emit("warn", "transform.image_block_dropped", {
          reason: "unsupported_scheme",
          urlPrefix: url.slice(0, 60),
        });
        continue;
      }
      out.push({ type: "image", source });
      continue;
    }
    // text, image (already native), or any other block type — pass through.
    out.push(block);
  }
  return out;
}

// (Removed EFFORT_TO_BUDGET — we no longer emit `thinking: { type: "enabled",
// budget_tokens: N }`. See the thinking-mode block further down in
// `openaiToAnthropic` for the rationale: `enabled + budget` triggers the
// server-side redacted-thinking contract, which breaks audit streaming.
// We now always emit `thinking: { type: "adaptive", display: "summarized" }`
// alongside `output_config: { effort }` — byte-for-byte parity with the
// reference opencode-claude-auth plugin.)

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
  // Request-scoped tool-name map built during this transform. Callers MUST
  // thread this into the response transforms (`streamAnthropicToOpenai` /
  // `anthropicToOpenai`) so `unmapToolName` reverses names against THIS
  // request's map, never a shared module global (issue #1).
  toolMap: ToolMap;
}

/**
 * Sanitize OpenAI-shape messages BEFORE the openaiToAnthropic transform.
 *
 * Anthropic rejects requests with empty text content blocks (HTTP 400:
 * "messages.N.content.M.text: Input should be a valid string with at least
 * 1 character"). Clients like Continue.dev occasionally emit such blocks
 * on regenerate/cancel paths. This pre-pass normalizes the input so the
 * downstream translation never has to know about empty-content edge cases.
 *
 * Rules per role:
 *   - assistant: filter `{type:"text", text:trim()===""}` blocks from array
 *     content. If filtered array becomes empty AND the message has no
 *     `tool_calls`, the message is DROPPED. If it has `tool_calls`, the
 *     message is preserved (content normalized to `[]`).
 *   - user: empty/whitespace string → `"(empty message)"`. `null`/`undefined`
 *     → placeholder array. Empty array or array of only empty text →
 *     placeholder array. Mixed arrays drop empty text blocks but keep
 *     non-text blocks (e.g. images).
 *   - system / tool / other roles: pass through UNCHANGED.
 *
 * Purity guarantees:
 *   - Returns a new array (`result !== input`).
 *   - Original message objects are not mutated; clones are produced when a
 *     mutation is needed.
 *   - `sanitize(sanitize(x))` deep-equals `sanitize(x)` (idempotent).
 *
 * Observability:
 *   - Emits `transform.sanitize.mutated` at `warn` level EXACTLY ONCE per
 *     mutated message (not once per block). Payload:
 *     `{role, mutation_type, original_block_count}` where `mutation_type`
 *     is one of the values in `SANITIZE_MUTATION_TYPES`.
 */
export const SANITIZE_MUTATION_TYPES = {
  droppedEmptyAssistant: "dropped_empty_assistant",
  filteredEmptyTextBlocks: "filtered_empty_text_blocks",
  replacedEmptyUserString: "replaced_empty_user_string",
  replacedEmptyUserArray: "replaced_empty_user_array",
  replacedNullUserContent: "replaced_null_user_content",
} as const;

export const EMPTY_MESSAGE_PLACEHOLDER = "(empty message)";

function isEmptyTextBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  if (b.type !== "text") return false;
  const t = b.text;
  return typeof t !== "string" || t.trim().length === 0;
}

function isWhitespaceOnlyString(s: unknown): boolean {
  return typeof s === "string" && s.trim().length === 0;
}

function emitMutation(
  role: string,
  mutationType: string,
  originalBlockCount: number,
): void {
  emit("warn", "transform.sanitize.mutated", {
    role,
    mutation_type: mutationType,
    original_block_count: originalBlockCount,
  });
}

export function sanitizeOpenAIMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg.role as string;

    // Pass through unknown / system / tool roles untouched.
    if (role !== "assistant" && role !== "user") {
      out.push(msg);
      continue;
    }

    const content = msg.content;

    if (role === "assistant") {
      const hasToolCalls =
        Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0;

      // null/undefined content → normalize to []; drop iff no tool_calls.
      if (content === null || content === undefined) {
        if (!hasToolCalls) {
          emitMutation(
            role,
            SANITIZE_MUTATION_TYPES.droppedEmptyAssistant,
            0,
          );
          continue; // drop message
        }
        // Preserve message but normalize content to [].
        const cloned: Record<string, unknown> = { ...msg, content: [] };
        emitMutation(
          role,
          SANITIZE_MUTATION_TYPES.filteredEmptyTextBlocks,
          0,
        );
        out.push(cloned);
        continue;
      }

      if (Array.isArray(content)) {
        const arr = content as Array<Record<string, unknown>>;
        const originalCount = arr.length;
        const filtered = arr.filter((block) => !isEmptyTextBlock(block));
        const mutated = filtered.length !== originalCount;

        if (filtered.length === 0 && !hasToolCalls) {
          // Drop the message entirely.
          emitMutation(
            role,
            SANITIZE_MUTATION_TYPES.droppedEmptyAssistant,
            originalCount,
          );
          continue;
        }

        if (mutated) {
          const cloned: Record<string, unknown> = { ...msg, content: filtered };
          emitMutation(
            role,
            SANITIZE_MUTATION_TYPES.filteredEmptyTextBlocks,
            originalCount,
          );
          out.push(cloned);
        } else {
          // No change — pass through.
          out.push(msg);
        }
        continue;
      }

      // String or other content shape on assistant — pass through unchanged.
      out.push(msg);
      continue;
    }

    // role === "user"
    if (content === null || content === undefined) {
      const cloned: Record<string, unknown> = {
        ...msg,
        content: [{ type: "text", text: EMPTY_MESSAGE_PLACEHOLDER }],
      };
      emitMutation(
        role,
        SANITIZE_MUTATION_TYPES.replacedNullUserContent,
        0,
      );
      out.push(cloned);
      continue;
    }

    if (typeof content === "string") {
      if (isWhitespaceOnlyString(content)) {
        const cloned: Record<string, unknown> = {
          ...msg,
          content: EMPTY_MESSAGE_PLACEHOLDER,
        };
        emitMutation(
          role,
          SANITIZE_MUTATION_TYPES.replacedEmptyUserString,
          0,
        );
        out.push(cloned);
      } else {
        out.push(msg);
      }
      continue;
    }

    if (Array.isArray(content)) {
      const arr = content as Array<Record<string, unknown>>;
      const originalCount = arr.length;
      const filtered = arr.filter((block) => !isEmptyTextBlock(block));

      if (filtered.length === 0) {
        const cloned: Record<string, unknown> = {
          ...msg,
          content: [{ type: "text", text: EMPTY_MESSAGE_PLACEHOLDER }],
        };
        emitMutation(
          role,
          SANITIZE_MUTATION_TYPES.replacedEmptyUserArray,
          originalCount,
        );
        out.push(cloned);
        continue;
      }

      if (filtered.length !== originalCount) {
        const cloned: Record<string, unknown> = { ...msg, content: filtered };
        emitMutation(
          role,
          SANITIZE_MUTATION_TYPES.filteredEmptyTextBlocks,
          originalCount,
        );
        out.push(cloned);
      } else {
        out.push(msg);
      }
      continue;
    }

    // Any other content shape on user — pass through.
    out.push(msg);
  }

  return out;
}

export function openaiToAnthropic(body: Record<string, unknown>): TransformResult {
  // Per-request tool map. Built here, returned in TransformResult, and threaded
  // into the response transforms so the reverse lookup is never clobbered by a
  // concurrent request (issue #1).
  const toolMap = createToolMap();
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

  // Pre-pass: sanitize empty text blocks and empty user content BEFORE the
  // translation loop. Anthropic rejects empty text blocks ("Input should be
  // a valid string with at least 1 character"); some clients (Continue.dev)
  // emit them on regenerate/cancel paths. See sanitizeOpenAIMessages docs.
  const rawMessages = (body.messages as Array<Record<string, unknown>>) || [];
  const sanitizedMessages = sanitizeOpenAIMessages(rawMessages);

  for (const msg of sanitizedMessages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
    } else if (msg.role === "assistant" && msg.tool_calls) {
      const content: Array<Record<string, unknown>> = [];
      // Only emit a text block when there is REAL text. Anthropic rejects a
      // text block whose `text` is not a non-empty string (HTTP 400: "Input
      // should be a valid string with at least 1 character"). sanitizeOpenAI
      // Messages normalizes assistant `content: null` (with tool_calls) to an
      // empty array `[]`, which is truthy — the old `if (msg.content)` check
      // wrapped it as `{ type: "text", text: [] }` and triggered that 400.
      //   - non-empty string → single text block.
      //   - non-empty array  → translate vision/content blocks and spread them
      //     (mirrors the user-message branch below), dropping empty text.
      //   - empty string / empty array / null / undefined → push NOTHING.
      if (typeof msg.content === "string" && msg.content.length > 0) {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const blocks = toAnthropicContentBlocks(
          msg.content as Array<Record<string, unknown>>,
        );
        for (const block of blocks) {
          if (block.type === "text" && (typeof block.text !== "string" || block.text.length === 0)) {
            continue;
          }
          content.push(block);
        }
      }
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown>;
        let input = {};
        try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments as string) : fn.arguments || {}; } catch {}
        content.push({ type: "tool_use", id: tc.id, name: mapToolName(fn.name as string, toolMap), input });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      const last = messages[messages.length - 1];
      const result = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        // Array content (e.g. a tool returning [text, image]) is translated
        // through the vision helper so images survive as Anthropic-native
        // `image` blocks. String content keeps the legacy passthrough; any
        // other shape (object, etc.) falls back to JSON.stringify so we
        // never silently drop data.
        content: Array.isArray(msg.content)
          ? toAnthropicContentBlocks(msg.content as Array<Record<string, unknown>>)
          : typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      };
      if (last?.role === "user" && (last as unknown as Record<string, unknown>)._batch) {
        (last.content as Array<Record<string, unknown>>).push(result);
      } else {
        const entry = { role: "user", content: [result], _batch: true } as unknown as AnthropicMessage;
        messages.push(entry);
      }
    } else {
      // User (and any other non-system/non-assistant-tool/non-tool) messages.
      // Array content carries OpenAI vision blocks that must be translated to
      // Anthropic-native shapes BEFORE downstream passes (system-prompt
      // forwarding, cache_control) inspect the array.
      const content = Array.isArray(msg.content)
        ? toAnthropicContentBlocks(msg.content as Array<Record<string, unknown>>)
        : (msg.content as string);
      messages.push({ role: msg.role as string, content } as AnthropicMessage);
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

  // Whether to inject the "You are Claude Code…" identity block.
  // Precedence (highest first):
  //   body.clean_system === true   → force OFF (drop identity)        [per-request opt-out]
  //   body.clean_system === false  → force ON  (keep identity)        [per-request opt-in]
  //   body.clean_system unset      → global default, isClaudeCodeIdentityEnabled()
  //                                  (env CLAUDE_CODE_IDENTITY, default OFF)
  // The billing header (system[0]) is ALWAYS present regardless of this flag —
  // Anthropic requires it on OAuth requests for usage accounting.
  const includeIdentity =
    body.clean_system === true
      ? false
      : body.clean_system === false
        ? true
        : isClaudeCodeIdentityEnabled();

  const system: Array<Record<string, unknown>> = [
    { type: "text", text: computeBilling(firstText) },
  ];
  if (includeIdentity) {
    system.push({
      type: "text",
      text: CLAUDE_CODE_IDENTITY,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  }

  // `runtime_system` is a per-turn metadata channel for facts the model
  // should answer with authoritatively (model id, today's date, host
  // platform). Unlike a client `{role:"system"}` message — which we
  // collect and prepend to the first user message as an OAuth-400
  // mitigation — runtime_system goes into system[] DIRECTLY and stays
  // there: cache-free (so a new value lands every turn) and never
  // relocated to user content (so it stays scoped as metadata, not as
  // historical user input that the model echoes back).
  //
  // Wire order: [billing, claude-code-identity?, runtime_system]. The
  // billing header MUST stay at index 0 for OAuth quota accounting;
  // identity (when present) sits at index 1; runtime_system is appended
  // last so the model sees it as the most recent system signal.
  //
  // Malformed input (non-string) is ignored with a warn log — same
  // tolerant posture as the vision-block helper. Over-length input is
  // truncated to RUNTIME_SYSTEM_MAX_CHARS, not rejected: callers may be
  // composing the string from runtime data they can't fully control,
  // and a soft truncation degrades gracefully where a thrown error
  // would break the whole turn.
  const RUNTIME_SYSTEM_MAX_CHARS = 8000;
  const rawRuntime = (body as Record<string, unknown>).runtime_system;
  if (rawRuntime !== undefined) {
    if (typeof rawRuntime !== "string") {
      emit("warn", "transform.runtime_system.ignored", {
        reason: "not_a_string",
        actualType: Array.isArray(rawRuntime) ? "array" : typeof rawRuntime,
      });
    } else if (rawRuntime.length > 0) {
      let text = rawRuntime;
      if (text.length > RUNTIME_SYSTEM_MAX_CHARS) {
        emit("warn", "transform.runtime_system.truncated", {
          originalLength: text.length,
          truncatedTo: RUNTIME_SYSTEM_MAX_CHARS,
        });
        text = text.slice(0, RUNTIME_SYSTEM_MAX_CHARS);
      }
      system.push({ type: "text", text });
    }
  }

  addCacheControlToLastUserBlock(messages);

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
  // CRITICAL discovery (after byte-level capture of the real plugin +
  // OpenCode request — see scripts/bare-thinking-test.ts):
  //
  //   `thinking: { type: "enabled", budget_tokens: N }`   → REDACTED
  //       Anthropic's OAuth streaming endpoint responds with a thinking
  //       block shell (`thinking: ""` + signed ciphertext in
  //       `signature_delta`) and ZERO `thinking_delta` events. The
  //       chain-of-thought never reaches the client in plaintext. This
  //       is the "full CoT with cipher" contract; audit is impossible.
  //
  //   `thinking: { type: "adaptive", display: "summarized" }` → PLAINTEXT
  //       Anthropic streams real `thinking_delta` events containing a
  //       natural-language summary of the model's reasoning. This is
  //       the mode the official Claude Code client + the opencode-claude-auth
  //       plugin actually use (confirmed by intercepting OpenCode's
  //       outbound fetch). The "summarized" display keeps the plaintext
  //       contract; "full" also exists but with different billing/rate.
  //
  // Implementation consequences:
  //   - We NEVER emit `thinking.enabled` any more. The request goes out
  //     as `adaptive + summarized` whenever the model supports adaptive
  //     thinking, regardless of whether the client passed an effort.
  //   - `output_config.effort` is emitted ALONGSIDE `thinking.adaptive`
  //     (previously we treated them as mutually exclusive — that was
  //     wrong; the plugin sends both and it works). `effort` still maps
  //     1:1 from client-supplied `reasoning_effort`.
  //   - Structured-output mode still suppresses both (schema takes over).
  //
  // This preserves the observability use-case of this proxy: the audit
  // UI can render a readable plaintext reasoning summary per request.
  if (!isStructuredOutput && caps.adaptiveThinking) {
    result.thinking = { type: "adaptive", display: "summarized" };
    // Anthropic rejects `temperature` !== 1 (and any top_p/top_k) once
    // adaptive/extended thinking is enabled. Clients such as the hermes
    // vision tool send temperature: 0 for determinism; normalize to the
    // only values the upstream accepts here instead of 400-ing the request.
    result.temperature = 1;
    delete result.top_p;
    delete result.top_k;
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

  // output_config.effort now co-exists with thinking.adaptive (see the
  // thinking-mode block above). Previously we treated them as mutually
  // exclusive, which was a mis-read of the API contract — the reference
  // plugin sends both together and that is what the server expects.
  if (
    caps.outputEffort &&
    !isStructuredOutput &&
    effectiveEffort !== null
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
        name: mapToolName(fn.name as string, toolMap),
        description: (fn.description as string) || "",
        input_schema: fn.parameters || { type: "object", properties: {} },
      };
    });
    addCacheControlToLastTool(result.tools as Array<Record<string, unknown>>);
    // Mirror the reference plugin: when tools are declared, default
    // `tool_choice` to `{type: "auto"}` unless the caller supplied
    // one explicitly. The plugin always sends this and the server
    // accepts it as a no-op when no tool is actually invoked.
    if (!result.tool_choice) {
      result.tool_choice = { type: "auto" };
    }
  }

  emit("debug", "transform.request", {
    model,
    messageCount: repaired.length,
    toolsCount: (result.tools as unknown[] | undefined)?.length ?? 0,
    hasSystem: systemPrompt !== null,
    isStructuredOutput,
    isHaiku,
  });

  return { body: result, isStructuredOutput, toolMap };
}

function addCacheControlToLastUserBlock(messages: AnthropicMessage[]): void {
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
      const last = arr[arr.length - 1];
      if (last) {
        last.cache_control = { type: "ephemeral", ttl: "1h" };
      }
    }
    return;
  }
}

function addCacheControlToLastTool(tools: Array<Record<string, unknown>>): void {
  const last = tools[tools.length - 1];
  if (last) {
    last.cache_control = { type: "ephemeral", ttl: "1h" };
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
