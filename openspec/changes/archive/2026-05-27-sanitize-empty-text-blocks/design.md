# Design: Sanitize Empty Text Blocks in OpenAI→Anthropic Transform

## Technical Approach

Introduce a pure pre-pass `sanitizeOpenAIMessages()` that normalizes incoming OpenAI-format messages **before** `openaiToAnthropic()` translates them into Anthropic's wire shape. The function runs once over the raw `body.messages` array and produces a new sanitized array; the existing for-loop then iterates the result. No changes to the role/tool translation logic — sanitization is strictly upstream of it.

The helper lives co-located in `src/transform/openai-to-anthropic.ts` (same file as its only caller) following the project's existing pattern: `repairToolPairs` is the only transform step in its own file because it operates on **Anthropic-shape** output and is also exported standalone. Sanitization, by contrast, operates on **OpenAI-shape input** and has exactly one consumer, so it stays inline.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Placement (before vs after loop) | **Before the for-loop** on raw `body.messages` | Inside the loop per message; after, on Anthropic messages | Sanitization is about OpenAI-shape invariants (`content` may be `string \| null \| array`, `tool_calls` lives on the msg). After translation, that shape is gone (assistant content is always an array, tool_calls are merged in). A pre-pass keeps the loop ignorant of empty-content edge cases. |
| File location | **Same file** (`openai-to-anthropic.ts`) | New file `sanitize-openai-messages.ts` | One consumer, ~30 LOC, tightly coupled to the transform's input contract. Splitting would invert the project's pattern (small inline helpers like `extractImageUrl`, `imageUrlToAnthropicSource`). |
| User placeholder | **`"(empty message)"`** as a single text block / string | Drop the user message; use `"(empty)"` | Dropping a user message corrupts turn alternation Anthropic requires. `"(empty message)"` is self-documenting in logs and replays; the proposal's `"(empty)"` is upgraded for clarity. |
| Assistant empty + no tool_calls | **Drop the message** | Replace with placeholder | An assistant turn with no text and no tool_calls carries no information; replaying a placeholder would inject fake model output into context. Dropping mirrors what `repairToolPairs` already does when a message's content array empties out. |
| Observability | **Single `warn` emit per mutated message** | Per-block emit; debug level | One mutation event per message is enough to detect real client bugs without flooding logs. `warn` matches the existing `transform.image_block_dropped` / `transform.runtime_system.ignored` pattern. |
| `content: null` / `undefined` | **Treat as empty → placeholder (user) or drop (assistant w/o tool_calls)** | Pass through; throw | Continue.dev sends `content: null` on some regenerate paths. Passing through hits the same Anthropic 400. Throwing breaks the request for a recoverable shape issue. |

## Data Flow

```
body.messages (raw OpenAI shape)
        │
        ▼
sanitizeOpenAIMessages()   ← new pre-pass (pure)
        │     │
        │     └── emit("warn", "transform.sanitize.mutated", …) per mutated msg
        ▼
sanitized messages
        │
        ▼
for-loop in openaiToAnthropic()  ← unchanged
        │
        ▼
repairToolPairs() → final Anthropic body
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/transform/openai-to-anthropic.ts` | Modify | Add `sanitizeOpenAIMessages()` helper (~30 LOC) and a single call at the top of `openaiToAnthropic()` before the for-loop. |
| `__tests__/transform-sanitize-empty-blocks.spec.ts` | Create | Adversarial suite (~200 LOC) covering Continue.dev fixtures, edge cases, property tests (purity, idempotency), negative tests, and a perf check. |

## Interfaces / Contracts

```ts
/**
 * Pre-pass over raw OpenAI-format messages that removes empty text content
 * blocks and replaces empty user content with a placeholder. Pure: input
 * array and its members are never mutated. Returns a new array even when no
 * sanitization fires (callers must not rely on reference equality).
 *
 * Emits one `warn` event per mutated message:
 *   transform.sanitize.mutated { role, mutation_type, original_block_count }
 *
 * mutation_type ∈ {
 *   "dropped_empty_assistant",         // assistant w/ no text + no tool_calls
 *   "filtered_empty_text_blocks",      // array content, some empty text blocks removed
 *   "replaced_empty_user_string",      // user content was "" or whitespace-only
 *   "replaced_empty_user_array",       // user content array empty after filtering
 *   "replaced_null_user_content"       // user content was null/undefined
 * }
 */
export function sanitizeOpenAIMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>>;
```

Rules (per role):

- **assistant**: if `Array.isArray(content)` → filter `{type:"text", text:trim()===""}`; if filtered array is empty AND no `tool_calls` → DROP message; else keep with filtered content. String/null content is left untouched (the existing loop folds string assistant content into `tool_calls` translation).
- **user**: if `content === null \|\| content === undefined` → `[{type:"text",text:"(empty message)"}]`. If `typeof content === "string"` and `content.trim() === ""` → replace with `"(empty message)"`. If `Array.isArray(content)` → filter empty text blocks; if array becomes empty → `[{type:"text",text:"(empty message)"}]`. Mixed image/text arrays keep image blocks intact.
- **system / tool / other**: pass through unchanged.

Single-char or punctuation-only content (`"y"`, `"."`) satisfies `trim().length > 0` and passes through. Tab/newline-only content (`"\t\n"`) is treated as empty.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit — happy path | Each `mutation_type` fires correctly | Per-rule tests with minimal fixtures |
| Unit — Continue.dev fixtures | Real captured payload shapes from telemetry | Embedded JSON fixtures, one per failure mode |
| Property — purity | Input array + members not mutated | Deep-clone input, run sanitize, deep-equal original |
| Property — idempotency | `sanitize(sanitize(x))` deep-equals `sanitize(x)` | Run twice over fuzzed inputs |
| Negative | `"y"`, `"."`, single-char meaningful text → unchanged | Assert reference-equal text content |
| Negative | Assistant `tool_calls` + empty text → kept (text filtered, msg retained) | Mixed payload assertion |
| Edge | `content: null`, `content: undefined`, `"\t\n"`, mixed image+text | One test each |
| Observability | `emit` called once per mutated message with correct payload | `spyOn(logger, "emit")` |
| Performance | 100 messages mixed content → <1ms | `performance.now()` delta assertion |

Test runner: `bun test` (project convention; see `transform-repair-tool-pairs.spec.ts`).

## Migration / Rollout

No migration required. Pure additive change behind no flag; either it fixes 400 errors immediately or it's reverted via the single-file rollback in the proposal. No schema, config, or data changes.

## Open Questions

None. All edge cases (null/undefined content, single-char messages, whitespace-only) are resolved in the rules table above.
