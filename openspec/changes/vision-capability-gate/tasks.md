# Tasks: Vision Capability Gate

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~180–220 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast |
| Chain strategy | N/A (single PR) |

**Decision needed before apply**: No  
**Chained PRs recommended**: No  
**Chain strategy**: N/A  
**400-line budget risk**: Low

### Rationale

This is an isolated, single-concern feature that touches 5–6 files and adds one guarding behavior. All changes are co-located within the model-capabilities and transform pipeline; no integration points beyond 3 existing route handlers. Tests are additive; no schema migrations or breaking changes. Estimated diff: ~180–220 lines (types, guards, error class, 3 catch blocks, ~20 test cases). Well within budget; no chained PR needed.

### Suggested Work Units

| Unit | Goal | Focused Test | Runtime Harness | Rollback Boundary |
|------|------|--------------|-----------------|-------------------|
| 1 | Core model capabilities + vision gate logic | `bun test transform-model-capabilities.spec.ts` | `SEEDED_REGISTRY` + image-block test suite | Revert `models.ts` + `openai-to-anthropic.ts` + `models.spec.ts` |
| 2 | Error handling & observability in routes | `bun test http-routes-{chat,completions,tokens}.spec.ts` | 3 route tests catching `CapabilityMismatchError` → 400 proxy_error | Revert all `routes/*.ts` + new route `.spec.ts` assertions |

---

## Phase 1: Foundation — Model Capabilities Surface

**Focus**: Expose vision capability data and verified state in the capability lookup.

- [x] 1.1 Extend `ModelCapabilities` interface in `src/domain/models.ts` (lines 20–24) to add `imageInput: boolean` and `verified: boolean`
- [x] 1.2 Update `DEFAULT_CAPABILITIES` in `src/domain/models.ts` (lines 86–90) to include `imageInput: false, verified: false`
- [x] 1.3 Modify `getModelCapabilities()` in `src/domain/models.ts` (lines 164–172) to:
  - Compute `const live = registry !== null` before entry lookup
  - Spread existing 3 fields + add `imageInput: entry.imageInput` and `verified: live`
  - Return `DEFAULT_CAPABILITIES` with `verified: false` when no entry found
- [x] 1.4 Write unit tests in `__tests__/transform-model-capabilities.spec.ts`:
  - Test live registry read returns `verified: true` + correct `imageInput`
  - Test fallback (no live entry) returns `verified: false, imageInput: false`
  - Test default when model absent returns `verified: false, imageInput: false`

---

## Phase 2: Core Implementation — Vision Gate & Error Handling

**Focus**: Add the tri-state capability gate and new error type.

- [x] 2.1 Create `CapabilityMismatchError` class in `src/transform/openai-to-anthropic.ts`:
  - Constructor signature: `(readonly model: string, readonly reason = "image_input_unsupported")`
  - `name = "CapabilityMismatchError"`
  - Export it
- [x] 2.2 Add helper `IMAGE_TYPES = Set(["image_url", "input_image", "image"])` in `src/transform/openai-to-anthropic.ts`
- [x] 2.3 Implement `assertImageCapability(model: string, messages: AnthropicMessage[])` guard in `src/transform/openai-to-anthropic.ts`:
  - Detect if any message contains an image block (check `content` array for block type in `IMAGE_TYPES`)
  - If no image, return early (no-op)
  - Call `getModelCapabilities(model)` to get `{imageInput, verified}`
  - If `imageInput === true`, return early (capability present)
  - Emit `transform.image_block_dropped` with `reason: "capability_mismatch"`, `model`, `verified`, at error level if `verified === true`, warn level if `verified === false`
  - If `verified === true`, throw `CapabilityMismatchError(model)`; otherwise silently forward (fail-open)
- [x] 2.4 Insert call to `assertImageCapability(model, sanitizedMessages)` in `openaiToAnthropic()` at line ~379 (after `sanitizeOpenAIMessages` call, before translation loop)
- [x] 2.5 Write unit tests in new `__tests__/transform-image-blocks.spec.ts`:
  - **RED**: Confirmed-negative image request is rejected (live registry, model present, `imageInput: false`, image block present) → throws `CapabilityMismatchError`
  - **RED**: Vision-capable request forwards (live registry, model present, `imageInput: true`, image block) → no throw, proceeds
  - **RED**: Unverified registry fails open (no live registry OR model absent, image block) → no throw, emits warn event, forwards
  - **RED**: Text-only request is no-op (no image block) → no throw, no gate action
  - **RED**: Verified rejection emits error-level event with `verified: true`
  - **RED**: Fail-open forward emits warn-level event with `verified: false`
  - **GREEN**: All above tests pass with `assertImageCapability` implementation

---

## Phase 3: Route Integration — Error Catching & HTTP Response

**Focus**: Wire up error handling in the three route handlers.

- [x] 3.1 Update `handleChat()` in `src/http/routes/chat.ts` (lines 53–68, existing error-handling region):
  - Wrap `openaiToAnthropic()` call in try/catch
  - Catch `CapabilityMismatchError` → emit error event + return `Response.json({error:{message:"...",type:"proxy_error",code:400}},{status:400})`
  - Re-throw all other errors
- [x] 3.2 Update `handleCompletions()` in `src/http/routes/completions.ts` (lines ~206):
  - Same try/catch pattern as 3.1 for `openaiToAnthropic()` call
- [x] 3.3 Update `handleTokensCount()` in `src/http/routes/tokens.ts` (lines ~37):
  - Same try/catch pattern for `openaiToAnthropic()` call
- [x] 3.4 Ensure all three catch blocks emit at error level before returning 400
- [x] 3.5 Write route integration tests in existing test files (no new files):
  - **RED** in `__tests__/http-routes-chat.spec.ts`: POST /v1/chat/completions with confirmed-negative image → 400, type "proxy_error", code 400
  - **RED** in `__tests__/http-routes-completions.spec.ts`: POST /v1/completions with confirmed-negative image → 400, type "proxy_error", code 400
  - **RED** in `__tests__/http-routes-tokens.spec.ts`: POST /v1/tokens/count with confirmed-negative image → 400, type "proxy_error", code 400
  - **RED**: Same 3 routes with unverified image block → 200 OK (fail-open, no rejection)
  - **GREEN**: All route tests pass; existing 22 route tests remain green

---

## Phase 4: Observability & Verification

**Focus**: Extend observability payload and run full test suite.

- [x] 4.1 Confirm `transform.image_block_dropped` emit calls in `assertImageCapability()` include:
  - `reason: "capability_mismatch"`
  - `model: string`
  - `verified: boolean`
  - Preserve existing `urlPrefix: ""`
- [x] 4.2 Run full test suite: `bun test` (742 tests pass, 0 fail — suite grew since forecast)
- [x] 4.3 Run type-check: `bun run tsc --noEmit; (cd src/ui && bun run typecheck)` (UI typecheck passes; root tsc has only pre-existing errors in untouched files — zero new errors from this change)
- [x] 4.4 Verify no regression in existing `openaiToAnthropic()` callers/tests (all remain green)
- [x] 4.5 Add regression note to `src/transform/openai-to-anthropic.ts` documenting the throw location (single choke point) for future maintainers

---

## Implementation Notes

### RED→GREEN Order (Strict TDD)

Each task above with "RED/GREEN" labels MUST follow this order:

1. **RED**: Write failing test first (assert expected behavior that doesn't yet work)
2. **GREEN**: Implement minimal code to make test pass
3. **REFACTOR**: Clean up (if needed)

Example flow for task 2.5:
- Write test "confirmed-negative image request is rejected" (expects throw) → test fails ✗
- Implement `assertImageCapability()` logic → test passes ✓
- Repeat for remaining 5 test cases in 2.5

### Testing Infrastructure

Use existing conventions from `__tests__/transform-model-capabilities.spec.ts`:

- `__seedRegistryForTests()` to inject mock registry
- `spyOn(logger, "emit")` to assert observability events
- `beforeAll() / afterAll()` for registry teardown
- No express/jest/vitest — bun:test only (per CLAUDE.md)

### Rollback Boundary

Entire change is isolated: revert `models.ts`, `openai-to-anthropic.ts`, and 3 route `.ts` files + new `.spec.ts` files → transform defaults to pass-through, routes never see `CapabilityMismatchError`. No schema, no migrations, no persisted state.

### Known Risks

- None identified. Change is purely additive, fails open when registry unavailable, and does not alter existing successful-request paths.
