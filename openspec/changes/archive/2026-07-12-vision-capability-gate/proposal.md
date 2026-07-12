# Proposal: Vision Capability Gate (Issue #40)

## Intent

`GET /v1/models` advertises per-model `image_input`, but nothing in the request pipeline reads it before forwarding vision content upstream. A client sending an image to a non-vision model gets only Anthropic's raw 400 (`anthropic-client.ts:113`), with zero gateway context. Close the gap: make the gateway aware of `imageInput` and respond usefully — without breaking legitimate vision requests during the registry-fallback window.

## Scope

### In Scope
- Surface `imageInput` in `ModelCapabilities` + `getModelCapabilities()` + `DEFAULT_CAPABILITIES`.
- A single-choke-point vision gate inside `openaiToAnthropic()` covering all 3 transform routes.
- Tri-state behavior: **reject** confirmed-unsupported, **fail-open + warn** when unverified.
- New `transform.image_block_dropped` reason `capability_mismatch`.
- Tests extending `transform-model-capabilities.spec.ts` + `transform-image-blocks.spec.ts`.

### Out of Scope
- Fixing `makeFallback()`'s `imageInput:false` for vision-capable fallback entries (fail-open makes it moot; the hand-maintained-table regression is not worth it).
- `GET /v1/models` informational accuracy during fallback (pre-existing, separate).
- `pdfInput`/other capability gates.

## Capabilities

### New Capabilities
- `vision-capability-gate`: model-capability-aware handling of image blocks in the OpenAI→Anthropic transform — surface `imageInput`, reject confirmed-unsupported vision requests with a gateway error, degrade to warn-only when capability is unverified, emit `capability_mismatch`.

### Modified Capabilities
- None. (`transform-sanitization` is adjacent but its requirements do not change.)

## Key Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Fallback staleness | **Tri-state.** Reject ONLY on confirmed negative (registry live AND model present AND `imageInput:false`). Registry `null` (bootstrap/outage) OR model absent → **fail-open**: forward + warn. Never reject on fallback data. |
| 2 | Reject vs warn | **Staged.** Confirmed negative → hard reject (closes user-facing gap). Unverified → warn-only observability, forward as today (kills cold-start false positives). |
| 3 | Error shape | **`proxy_error`, 400, `code:400`** — precedent: anti-loop guard (`chat.ts:53-63`). This is a gateway *policy* reject on well-formed input, not malformed input, so NOT `invalid_request_error`. |
| 4 | Routes gated | **All 3, one choke point** in `openaiToAnthropic()`. chat = primary path; completions(FIM) = inert no-op (string-only); tokens/count = in scope (reuses real transform; must not silently miscount an image the model rejects). |
| 5 | Contract change | New typed `CapabilityMismatchError`; the 3 route handlers MUST catch it → `proxy_error` 400. Throw fires ONLY on confirmed-negative + image-present (a new state), so existing 22 callers/tests are unaffected. |
| 6 | Observability | `emit(level, "transform.image_block_dropped", { reason:"capability_mismatch", urlPrefix, model, verified })`. `verified:true`→`error`+reject; `verified:false`→`warn`+forward. Keeps existing keys, adds `model`+`verified`. |

## Approach

Add capability provenance so the gate distinguishes "confirmed unsupported" from "unverified" (design picks exact API — e.g. `getModelCapabilities` returns a `source: live|fallback` discriminator, or a `registryHasModel()` helper). `model` is already resolved first in `openaiToAnthropic()` (line 352), before the translation loop. When an image block is encountered: confirmed-negative → throw `CapabilityMismatchError`; unverified → forward + warn. Routes wrap the call in try/catch mapping the typed error to the `proxy_error` 400.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/models.ts` | Modified | Add `imageInput` to `ModelCapabilities`, `getModelCapabilities()`, `DEFAULT_CAPABILITIES`; expose capability provenance/liveness signal. |
| `src/transform/openai-to-anthropic.ts` | Modified | Gate in `openaiToAnthropic()`; thread `model` to image path; `CapabilityMismatchError`; new `capability_mismatch` emit. |
| `src/http/routes/chat.ts`, `completions.ts`, `tokens.ts` | Modified | try/catch around `openaiToAnthropic()` → `proxy_error` 400. |
| `__tests__/transform-{image-blocks,model-capabilities}.spec.ts` | Modified | New gate + provenance + observability cases. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cold-start/outage false-positive rejects | High if naive | Fail-open on unverified (Decision 1); reject only on live-confirmed negative. |
| `openaiToAnthropic()` throw breaks callers | Med | Typed error + narrow trigger; only the 3 routes catch; other callers never reach the state. |
| `tokens/count` over-strict for a count | Low | Deliberate for parity; same shape as chat (Decision 4). |
| Third error-shape variant added | Low | Reuse `proxy_error` precedent (Decision 3). |

## Rollback Plan

Change is additive and isolated. Revert the feature commit(s): remove the gate + `CapabilityMismatchError` throw from `openaiToAnthropic()`, drop the route try/catch blocks, and revert the `ModelCapabilities.imageInput` field. No schema, migration, or persisted state involved; transform reverts to pass-through and `getModelCapabilities` to its prior 3-field shape. Because reject fires only on the new confirmed-negative+image state, reverting cannot break previously-passing requests. A faster kill-switch (config flag to force fail-open globally) can be added in design if a staged rollout is preferred.

## Dependencies

- None external. Relies on existing live-registry data (`UpstreamModel.imageInput`, already populated in `normalize()`).

## Success Criteria

- [ ] `getModelCapabilities(model).imageInput` reflects live registry data; `DEFAULT_CAPABILITIES.imageInput === false`.
- [ ] Image → live-confirmed non-vision model returns `proxy_error` 400 with a clear message.
- [ ] Image → vision model or during registry-fallback/unknown-model window is forwarded (no false-positive reject).
- [ ] `transform.image_block_dropped` emits `reason:"capability_mismatch"` with `model` + `verified`, at `error` on reject and `warn` on forward.
- [ ] All 3 routes covered by the single gate; existing 422 tests still pass.
