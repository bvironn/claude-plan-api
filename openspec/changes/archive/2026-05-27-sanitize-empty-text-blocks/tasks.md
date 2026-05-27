# Tasks: Sanitize Empty Text Blocks in OpenAI→Anthropic Transform

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~280 (30 impl + 250 tests) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast |
| Chain strategy | n/a |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Sanitize pre-pass + adversarial test suite | PR 1 | Single PR; impl + tests + observability in one slice |

## Phase 1: Foundation (Test Fixtures First — RED)

- [x] 1.1 Create `__tests__/transform-sanitize-empty-blocks.spec.ts` skeleton with `describe("sanitizeOpenAIMessages")` and import (non-existent yet → compile RED).
- [x] 1.2 Add Continue.dev real-payload fixtures (request 8 and 9 captured bodies) as JSON consts at top of spec.
- [x] 1.3 Export `sanitizeOpenAIMessages` symbol declaration only (empty body throwing `Not implemented`) in `src/transform/openai-to-anthropic.ts` so tests can import.

## Phase 2: Spec-Mapped Tests (RED — one per scenario)

Each task = ONE failing test mapped to a spec scenario (`R{req}.{scenario}`).

- [x] 2.1 R1.1: assistant array with one `{type:"text",text:""}` → block removed, message kept.
- [x] 2.2 R1.2: assistant array with `{type:"text",text:"   \n\t"}` → block removed.
- [x] 2.3 R1.3: assistant `content:[{type:"text",text:""}]` + no `tool_calls` → message DROPPED from output array.
- [x] 2.4 R1.4: assistant `content:[{type:"text",text:""}]` + `tool_calls:[{...}]` → message PRESERVED (content becomes `[]`, tool_calls intact).
- [x] 2.5 R1.5: assistant array with `{type:"image",...}` only → passes through unchanged.
- [x] 2.6 R2.1: user `content:""` → replaced with `"(empty message)"`.
- [x] 2.7 R2.2: user `content:"\t\n  "` → replaced with `"(empty message)"`.
- [x] 2.8 R2.3: user `content:"hello"` → unchanged.
- [x] 2.9 R2.4: user `content:[]` → replaced with `[{type:"text",text:"(empty message)"}]`.
- [x] 2.10 R2.5: user `content:[{type:"text",text:""},{type:"text",text:"   "}]` → replaced with placeholder array.
- [x] 2.11 R2.6: user mixed `[{type:"text",text:""},{type:"image",...}]` → empty text dropped, image kept (no placeholder injected).
- [x] 2.12 R3.1: when a message is mutated → `logger.emit` called once with `("warn","transform.sanitize.mutated",{role,mutation_type,original_block_count})`.
- [x] 2.13 R3.2: when no mutation happens (already-clean payload) → `logger.emit` NOT called.
- [x] 2.14 R4.1: input array reference unchanged (`result !== input`).
- [x] 2.15 R4.2: deep-clone of input before sanitize; original objects deep-equal post-sanitize (purity).
- [x] 2.16 R4.3: structural equality when no mutation needed (`deepEqual(result, input)` shape-wise).
- [x] 2.17 R5.1: `sanitize(sanitize(x))` deep-equals `sanitize(x)` for all fixtures.

## Phase 3: Adversarial / Hard-Testing (RED — beyond spec)

- [x] 3.1 Negative: single-char meaningful text `"y"`, `"."`, `"1"` → preserved verbatim, NO mutation event.
- [x] 3.2 Negative: assistant `tool_calls` present + empty text block + image block → text filtered, image + tool_calls preserved, message kept.
- [x] 3.3 Edge: user `content: null` → replaced with `[{type:"text",text:"(empty message)"}]` + emits `replaced_null_user_content`.
- [x] 3.4 Edge: user `content: undefined` (property present, value undefined) → same as null.
- [x] 3.5 Edge: assistant `content: null` + no `tool_calls` → message dropped.
- [x] 3.6 Edge: assistant `content: null` + `tool_calls:[...]` → message preserved, content normalized to `[]`.
- [x] 3.7 Edge: deeply nested — message with 10 text blocks (5 empty, 5 real) → exactly the 5 real remain, order preserved.
- [x] 3.8 Edge: `system` / `tool` role with empty content → passed through UNCHANGED (sanitizer scope is user/assistant only).
- [x] 3.9 Property — purity: random fixture array deep-cloned, sanitized, original deep-equal to clone (run 20 random shapes).
- [x] 3.10 Property — idempotency: random fixture, `sanitize(sanitize(x))` deep-equals `sanitize(x)` (run 20 random shapes).
- [x] 3.11 Continue.dev fixture: request-8 captured body → full array transforms without throwing; resulting messages pass Anthropic-shape preconditions (no empty text blocks, no whitespace-only strings).
- [x] 3.12 Continue.dev fixture: request-9 captured body → same as 3.11.
- [x] 3.13 Performance: 100 mixed messages sanitized in `<25ms` via `performance.now()` delta (loose bound for system jitter; warmed JIT; cold runs are sub-1ms locally).
- [x] 3.14 Observability spy: spy on `logger.emit`; verify EXACTLY one call per mutated message (not per block) across a multi-mutation payload.
- [x] 3.15 Observability payload shape: assert `mutation_type` is one of the documented enum values; `original_block_count` is a number ≥ 0.

## Phase 4: Implementation (GREEN — make tests pass)

- [x] 4.1 Implement `sanitizeOpenAIMessages(messages)` body in `src/transform/openai-to-anthropic.ts`: build a new array; per message dispatch on `role` (assistant | user | other → pass-through).
- [x] 4.2 Assistant branch: handle `content` as array (filter empty text blocks), null/undefined (normalize to `[]`); drop iff filtered empty AND no `tool_calls`; emit `dropped_empty_assistant` or `filtered_empty_text_blocks`.
- [x] 4.3 User branch: handle string (empty/whitespace → `"(empty message)"`), null/undefined → placeholder array, array (filter empty text; if empty → placeholder array; mixed → keep non-text); emit matching mutation_type.
- [x] 4.4 Wire single `logger.emit("warn","transform.sanitize.mutated",{role,mutation_type,original_block_count})` per mutated message (accumulate per-message, fire once at end of message processing).
- [x] 4.5 Call `sanitizeOpenAIMessages(body.messages)` at the entry of `openaiToAnthropic()`, before the existing for-loop. Use the result as the iteration source.
- [x] 4.6 Run `bun test __tests__/transform-sanitize-empty-blocks.spec.ts` — all Phase 2 + Phase 3 tasks must GREEN.

## Phase 5: Integration & Regression (GREEN — verify no regression)

- [x] 5.1 Run full `bun test` — verify existing `openai-to-anthropic` tests still pass. Baseline 220 pass / 2 fail (env-only) → after: 254 pass / 2 fail (same env-only). Net: +34 new tests, 0 regressions.
- [x] 5.2 Run `bun run tsc --noEmit` — no NEW tsc errors. 3 pre-existing errors in `domain-account-profile.spec.ts` and `src/domain/account.ts` (`hasExtraUsageEnabled` missing) remain unchanged and are unrelated to this change.
- [x] 5.3 Smoke: integration tests in spec call `openaiToAnthropic()` with Continue.dev request-8 and request-9 bodies and assert upstream `messages[]` has zero empty text blocks (covered by the two integration tests at the bottom of the spec file).

## Phase 6: Cleanup (REFACTOR)

- [x] 6.1 Extract `mutation_type` enum to a local `const` for typo safety; update tests to import it. (Exported as `SANITIZE_MUTATION_TYPES`; tests import and use it.)
- [x] 6.2 Add JSDoc to `sanitizeOpenAIMessages` documenting rules, mutation_type values, and purity guarantee.
- [x] 6.3 Verify no `console.log` / `debugger` left in the spec file.
