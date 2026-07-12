# Exploration: Vision capability gate (Issue #40)

## Current State

The gateway advertises per-model `image_input` capability via `GET /v1/models`
(`capabilities.image_input` in `src/http/routes/models.ts:80`), but nothing in
the request-transform pipeline reads that flag before forwarding vision
content upstream.

### Call path — where `toAnthropicContentBlocks()` is invoked

`toAnthropicContentBlocks()` (`src/transform/openai-to-anthropic.ts:74-101`)
is called **3 times**, all inside `openaiToAnthropic()`
(`src/transform/openai-to-anthropic.ts:347-...`), never directly from a route:

| Call site (line) | Branch |
|---|---|
| `openai-to-anthropic.ts:407` | assistant message with array content |
| `openai-to-anthropic.ts:435` | `role: "tool"` message with array content (tool_result) |
| `openai-to-anthropic.ts:452` | user message with array content (the primary vision path) |

`openaiToAnthropic()` itself is called from **3 route handlers**, all
dispatched from `src/http/server.ts`:

| Route | Handler | Call site |
|---|---|---|
| `POST /v1/chat/completions` | `handleChat` (`src/http/routes/chat.ts:39`) | `chat.ts:68` |
| `POST /v1/completions` (FIM) | `handleCompletions` (`src/http/routes/completions.ts:168`) | `completions.ts:206` |
| `POST /v1/tokens/count` | `handleTokensCount` (`src/http/routes/tokens.ts:20`) | `tokens.ts:37` |

`POST /v1/completions` is FIM (fill-in-the-middle): `buildFimMessages()`
(`completions.ts:36-56`) only ever emits plain string content, so it cannot
carry vision blocks in practice — but it still funnels through
`openaiToAnthropic()`, so any gate placed inside the transform pipeline
naturally covers it too (as a no-op). `POST /v1/tokens/count` DOES reuse the
real transform (`tokens.ts:37`, comment: "Reuse the real transform so the
count mirrors the exact messages + system shape that /v1/chat/completions
would produce") — so a gate inside `openaiToAnthropic`/`toAnthropicContentBlocks`
would also apply to token counting, which is arguably correct (you don't want
to silently miscount an image the model would reject) but is a design
decision worth calling out explicitly in propose/design.

There is **no dedicated `/v1/messages` route** — this is an OpenAI-compatible
gateway; the wire-level entry points are `/v1/chat/completions`,
`/v1/completions`, and `/v1/tokens/count`, all of which funnel into
`openaiToAnthropic()`.

### Model resolution — is the resolved model available before translation?

Yes. `openaiToAnthropic()` resolves the model as the **very first
statement**:

```ts
// openai-to-anthropic.ts:352-354
const { id: model, effort: suffixEffort } = resolveModelVariant(
  (body.model as string) || "sonnet",
);
```

This runs (line 352) **before** the message-translation loop that calls
`toAnthropicContentBlocks()` (loop starts at line 380). So `model` (a fully
resolved catalog id) is in scope and available at every call site of
`toAnthropicContentBlocks()` inside the function — a capability check could be
inserted immediately after model resolution, before or interleaved with the
translation loop.

Notably, `getModelCapabilities(model)` is **already called** later in the
same function, at `openai-to-anthropic.ts:588`, but only for thinking/effort
gating (adaptiveThinking / contextManagement / outputEffort) — it runs AFTER
the translation loop has already converted and pushed image blocks, and its
result is never consulted for vision gating.

### `getModelCapabilities()` / `ModelCapabilities` / `UpstreamModel` / `imageInput` shape

```ts
// src/domain/models.ts:20-24 — ModelCapabilities is a NARROW projection
export interface ModelCapabilities {
  adaptiveThinking: boolean;
  contextManagement: boolean;
  outputEffort: boolean;
  // imageInput is NOT here — this is the gap.
}

// src/domain/models.ts:164-172
export function getModelCapabilities(model: string): ModelCapabilities {
  const entry = indexById(currentCatalog()).get(model);
  if (!entry) return DEFAULT_CAPABILITIES;   // all-false, unknown model
  return {
    adaptiveThinking: entry.adaptiveThinking,
    contextManagement: entry.contextManagement,
    outputEffort: entry.outputEffort,
    // imageInput dropped here even though `entry` (UpstreamModel) HAS it.
  };
}
```

`UpstreamModel` (`src/upstream/models-client.ts:18-49`) already carries
`imageInput: boolean` (line 37), populated in `normalize()`
(`models-client.ts:133`) from Anthropic's live response:
`imageInput: caps.image_input?.supported === true`. The data exists on the
registry entry — `getModelCapabilities()` simply never surfaces it. Adding
`imageInput` to `ModelCapabilities` and to the returned object is a ~3-line
change; `DEFAULT_CAPABILITIES` (`models.ts:86-90`) also needs an
`imageInput: false` default for the "model not in registry" branch.

The only current consumer of `entry.imageInput` is
`src/http/routes/models.ts:80` (`toEntry()` → `capabilities.image_input` in
the `GET /v1/models` JSON response) — purely informational, exactly as the
issue states.

### `makeFallback()` / static fallback catalog

```ts
// src/domain/models.ts:41-63
function makeFallback(partial: ...): UpstreamModel {
  return {
    createdAt: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    thinkingEnabled: false,
    imageInput: false,   // <-- hardcoded false, no per-model override anywhere
    pdfInput: false,
    ...
    ...partial,
  };
}
```

All **9 entries** in `FALLBACK_MODELS` (`models.ts:65-84`, including
`claude-sonnet-4-6` and `claude-opus-4-6` — both of which genuinely support
vision on the real Anthropic API) inherit `imageInput: false` from the
`makeFallback()` default and never override it. So the static fallback table
is **unconditionally vision-blind**, not just "conservative for models that
don't support vision" — it's wrong for every model in the table.

## Observability pattern — `transform.image_block_dropped`

Emitted at exactly 2 sites, both inside `toAnthropicContentBlocks()`:

```ts
// openai-to-anthropic.ts:82-85 — no extractable URL
emit("warn", "transform.image_block_dropped", { reason: "no_url", urlPrefix: "" });

// openai-to-anthropic.ts:87-92 — URL present but scheme not base64/http(s)
emit("warn", "transform.image_block_dropped", {
  reason: "unsupported_scheme",
  urlPrefix: url.slice(0, 60),
});
```

Shape: `emit(level, "transform.image_block_dropped", { reason: <string enum>, urlPrefix: <string> })`.
A new `reason: "capability_mismatch"` value fits this exact shape without
changing the event name or payload keys — consistent with the issue's ask
("distinct from `no_url` / `unsupported_scheme`"). Whether the new payload
should also carry `model` (useful for debugging which model triggered it,
absent from the other two reasons because they're model-agnostic) is a
propose/design decision, not a blocker.

## Error / rejection conventions elsewhere in the codebase

Two co-existing conventions for gateway-level HTTP rejections, both under
`{ error: { message, type?, code? } }`:

1. **Client-input validation** → `type: "invalid_request_error"`, `status: 400`, no `code` field:
   - Malformed JSON (`chat.ts:44-47`, `completions.ts:173-176`, `tokens.ts:25`)
   - Missing required field (`completions.ts:181-184`, `tokens.ts:29-32`)

2. **Gateway policy decision** (not malformed input, a business-rule reject) → `type: "proxy_error"`, `status: 400`, `code: 400` in the body too:
   ```ts
   // chat.ts:53-63 — the anti-loop guard, closest existing precedent
   const trailingErrors = detectTrailingToolErrors(messages);
   if (trailingErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
     emit("error", "chat.loopGuard", { trailingErrors, sessionId });
     return Response.json({
       error: {
         message: `Loop detected: ${trailingErrors} consecutive invalid tool errors. Check tool mapping in proxy.`,
         type: "proxy_error",
         code: 400,
       }
     }, { status: 400 });
   }
   // Runs BEFORE openaiToAnthropic() is called (line 68) — i.e. BEFORE
   // model resolution / message translation, at the very top of handleChat.
   ```
   This is the closest structural precedent for the issue's "reject early
   with a clear, gateway-level error" option: it's a pre-flight check that
   runs before the transform, inspects the raw request, emits an `emit("error", ...)`
   observability event, and returns a structured 400 — the exact pattern a
   capability-mismatch pre-flight would follow if implemented at the route
   level rather than inside `toAnthropicContentBlocks()`.

3. **Auth guard** (`src/guards/api-key.ts:65-93`) uses a narrower shape
   `{ error: { message, code } }` (no `type` field) for 401/403 — a third,
   inconsistent variant. Not a pattern to copy for this issue.

4. **Upstream passthrough** (`src/upstream/anthropic-client.ts:113,117`)
   forwards Anthropic's own error body/status verbatim
   (`{ error: { message: errorBody, type: "error", code: res.status } }`) —
   this is what currently happens today when a vision request silently
   reaches a non-vision model/account: whatever Anthropic's own 400 says
   surfaces, with zero gateway-added context, exactly the issue's complaint.

## Fallback-staleness tradeoff (bootstrap-window false-positive risk)

`src/domain/models.ts:1-14` documents two reasons the static fallback exists:
1. **Bootstrap window** — first `POST /v1/chat/completions` may arrive before
   any `GET /v1/models` call has populated `registry`.
2. **Upstream failure resilience** — `refreshRegistry()`
   (`models.ts:121-137`) catches fetch errors and falls back to
   `currentCatalog()` (`registry ?? FALLBACK_MODELS`).

`src/index.ts:21` fire-and-forget calls `refreshRegistry()` on boot to
narrow (not eliminate) the bootstrap window — the comment at
`index.ts:14-20` explicitly acknowledges this is best-effort.

**There is no tri-state "capabilities not yet loaded" signal exposed to
callers.** `registry` is either `null` (→ static fallback) or populated
(→ live data) — a plain binary. The `registry === null` / `registry !== null`
checks exist (`models.ts:131`, `:351`) but only inside `emit()` diagnostic
payloads (`models.registry.refresh.fallback`, `models.resolve.passthrough`)
— never exposed as part of `ModelCapabilities` or any public function
signature that a gate could branch on.

**Consequence for a naive gate**: if the new pre-flight check simply does
`if (!getModelCapabilities(model).imageInput) reject()`, then during the
bootstrap window (or any upstream outage) it will **reject legitimate vision
requests to `claude-sonnet-4-6` / `claude-opus-4-6`** — both of which support
vision in reality — because the static fallback table hardcodes
`imageInput: false` for every entry (see `makeFallback()` above). This is a
genuine false-positive risk, not a hypothetical: it happens on every cold
start and every upstream `/v1/models` outage, for the two most commonly used
models in the fallback table.

This is a design tradeoff for `sdd-propose` / `sdd-design` to resolve
explicitly, not something to silently code around. Options observed as
plausible from the existing patterns in this codebase:
- **(a)** Only hard-reject when `registry !== null` (i.e., live data confirms
  no support); during the fallback window, degrade to a `warn`-level
  `transform.image_block_dropped` (or a new event) instead of a hard 400 —
  mirrors the codebase's existing "resilience over strictness" bias
  (`refreshRegistry` degrades rather than throws; `resolveModel` passes
  unknown claude-* ids through with a warn rather than rejecting them, see
  `models.ts:340-354`).
- **(b)** Fix `makeFallback()` to declare `imageInput: true` for the fallback
  entries that are known-vision-capable today (sonnet-4-6, opus-4-6, and the
  other current-generation models) — accepting that this reintroduces a
  hand-maintained truth table the codebase has been actively moving away
  from (see `models-client.ts:1-10` comment: "replaces the historical
  hardcoded MODEL_CAPABILITIES table").
- **(c)** Accept the false-positive risk as-is and document it as a known
  narrow-window limitation, matching the issue's own framing ("would
  rejecting on `imageInput: false` during the fallback window cause false
  positives worth calling out as a design tradeoff" — issue explicitly
  anticipates this).

No existing code in this repository solves this tri-state problem elsewhere,
so there is no established convention to just reuse — this needs an explicit
decision in design, not silent inheritance of a pattern.

## Existing test conventions

`__tests__/transform-image-blocks.spec.ts` (`bun:test`, `describe`/`test`/`expect`):
tests `toAnthropicContentBlocks()` in isolation (pure-helper tests) AND
through `openaiToAnthropic()` end-to-end (asserting the translated blocks
land in the right place in the Anthropic body, including cache_control
interaction). No capability gating is exercised here today — confirms the
gap.

`__tests__/transform-model-capabilities.spec.ts` (`bun:test`,
`beforeAll`/`afterAll`/`spyOn`): the established pattern for testing
capability-gated behavior —
- `__seedRegistryForTests(models)` (`models.ts:394-400`, test-only export) to
  deterministically seed the registry without hitting the network, returns
  an undo function.
- `spyOn(logger, "emit")` to assert specific observability events fired with
  the right payload (see `PASS-THROUGH-01` test, lines 603-621).
- Direct assertions on `getModelCapabilities(...)` return shape (`REQ-7`
  test, lines 219-238).

A new capability-mismatch test suite would naturally extend
`transform-model-capabilities.spec.ts` (seed a model with `imageInput: false`,
send an image block, assert either the 400 rejection shape or the new
`transform.image_block_dropped` reason) and/or add cases to
`transform-image-blocks.spec.ts` if the check lives inside
`toAnthropicContentBlocks()` itself.

## Affected Areas

- `src/domain/models.ts` — `ModelCapabilities` interface (add `imageInput`),
  `getModelCapabilities()` (surface the field), `DEFAULT_CAPABILITIES`
  (add default), `makeFallback()` / `FALLBACK_MODELS` (bootstrap-staleness
  tradeoff — see above).
- `src/transform/openai-to-anthropic.ts` — `openaiToAnthropic()` (model
  already resolved at line 352-354, natural insertion point),
  `toAnthropicContentBlocks()` (currently the sole translation point,
  candidate location for the gate itself or for emitting the new dropped
  reason).
- `src/http/routes/chat.ts`, `src/http/routes/completions.ts`,
  `src/http/routes/tokens.ts` — all 3 call `openaiToAnthropic()`; a gate
  placed inside the transform automatically covers all 3 without per-route
  duplication. If the design instead chooses a route-level pre-flight
  (mirroring the anti-loop guard pattern in `chat.ts:53-63`), each route
  needs its own check, which duplicates logic 3x — worth weighing against
  the single-choke-point option in design.
- `__tests__/transform-image-blocks.spec.ts`,
  `__tests__/transform-model-capabilities.spec.ts` — test surfaces to
  extend.
- `src/http/routes/models.ts` — unaffected by the fix itself, but is the
  existing consumer of `imageInput`; useful as a reference for the JSON
  shape already exposed to clients.

## Approaches

1. **Gate inside `toAnthropicContentBlocks()` / `openaiToAnthropic()`** (single choke point)
   - Thread `model` (already resolved at line 352) into the translation
     path; check `getModelCapabilities(model).imageInput` before/while
     translating image blocks; either drop-with-new-reason (observability-only,
     matches "emit a structured warn/error event" option in the issue) or
     throw a typed error that `openaiToAnthropic()` callers catch and turn
     into a 400.
   - Pros: automatically covers all 3 routes (chat, completions, tokens/count)
     with zero duplication; keeps the vision-translation and
     capability-awareness logic co-located, which is where the existing
     `getModelCapabilities(model)` call already lives (line 588) for other
     capabilities.
   - Cons: `toAnthropicContentBlocks()` is a synchronous pure-ish helper
     today (no model context) — plumbing `model` through its signature is a
     breaking change to its existing call sites; `openaiToAnthropic()`
     currently never throws (it's used by 22 call sites across many tests
     per CodeGraph's blast-radius scan) — introducing a throw path changes
     its contract and every caller needs to handle it (or the function needs
     to return an error-shaped result instead of throwing).
   - Effort: Medium.

2. **Gate at the route level, mirroring the anti-loop guard pattern** (`chat.ts:53-63`)
   - Add a pre-flight check in each route handler (`handleChat`,
     `handleCompletions`, `handleTokensCount`) BEFORE calling
     `openaiToAnthropic()`: inspect `body.messages` for image blocks,
     resolve the model (would need to call `resolveModelVariant` a second
     time, redundantly, since `openaiToAnthropic()` currently does its own
     internal resolution), check `getModelCapabilities(model).imageInput`,
     and return the existing 400 `{ error: { message, type: "proxy_error", code: 400 } }`
     shape on mismatch.
   - Pros: follows an existing, tested precedent exactly (anti-loop guard);
     no changes to `openaiToAnthropic()`'s signature or contract; each route
     can decide independently whether rejection is even appropriate (e.g.
     `/v1/tokens/count` might reasonably want a softer response than
     `/v1/chat/completions`).
   - Cons: triplicates the model-resolution + capability-check logic across
     3 routes (or requires extracting a shared helper anyway, converging
     back toward approach 1's shared logic minus the co-location benefit);
     model gets resolved twice per request (once in the guard, once inside
     `openaiToAnthropic()`) unless `resolveModelVariant` result is threaded
     through, which the current function signatures don't support without
     changes.
   - Effort: Medium — similar total surface to approach 1, different
     tradeoffs.

3. **Warn-only (observability-first, no hard rejection)**
   - Only implement the "emit a structured warn/error observability event"
     half of the issue's Expected Behavior, without the "reject early" half.
     Add the new `transform.image_block_dropped` reason
     (`capability_mismatch`) but still forward the image (or still drop it
     silently as today) — no client-facing 400 changes.
   - Pros: zero risk of new false-positive rejections during the
     fallback-staleness window (see tradeoff above); smallest possible
     change; matches the issue's OR framing ("either... or...").
   - Cons: does not fully close the gap the issue describes — a client still
     gets an unhelpful upstream-surfaced error with no gateway-added
     context, just now with a matching internal log line an operator (not
     the client) can find. Likely insufficient given the issue explicitly
     frames the consequence as user-facing ("gets no clear, actionable error
     from the gateway itself").
   - Effort: Low.

## Recommendation

Approach 1 (gate inside the transform pipeline) is architecturally the best
fit — it matches how every other capability gate in this codebase already
works (`getModelCapabilities(model)` is already consulted once, in the same
function, for thinking/effort/context-management; adding image capability to
that same call keeps all model-capability logic in one place instead of
spreading it across 3 route files). However, the exact mechanism (drop vs.
throw, and how `openaiToAnthropic()`'s currently-non-throwing contract should
change) needs to be decided in `sdd-design`, not here — this is read-only
exploration. The fallback-staleness tradeoff (option a/b/c above) is the
single most consequential open decision and should be resolved explicitly in
propose/design rather than defaulted silently, since a wrong default turns
into user-facing false-positive rejections on every cold start.

## Risks

- **False positives during bootstrap/outage window**: hard-rejecting on
  `imageInput: false` without accounting for `registry === null` will break
  vision requests to `claude-sonnet-4-6`/`claude-opus-4-6` on every cold
  start and every upstream `/v1/models` outage (see Fallback-staleness
  section). This is the highest-severity risk and must be an explicit design
  decision, not an oversight.
- **`openaiToAnthropic()` contract change**: it currently never throws
  (22 call sites across the codebase per CodeGraph's blast-radius scan,
  many exercised by tests) — introducing a throw-on-capability-mismatch path
  changes that contract for every caller, including `handleTokensCount`
  which has its own separate try/catch error-shaping convention
  (`tokens.ts:53-68`) distinct from `chat.ts`/`completions.ts`.
  `openaiToAnthropic` returning an error-shaped result (rather than throwing)
  may be safer but is a bigger API-shape change.
- **`/v1/tokens/count` scope ambiguity**: the issue frames the fix around
  "POST /v1/messages (or the OpenAI-compatible chat/completions routes)" —
  it does not explicitly mention token counting. Since `handleTokensCount`
  reuses the exact same transform, a shared gate will affect it too;
  whether that's desired needs explicit confirmation in propose/design.
- **Two competing error-shape conventions** (`invalid_request_error` vs.
  `proxy_error`) already coexist in this codebase without a documented rule
  for when to use which — picking the wrong one for this new rejection adds
  a third undocumented variant instead of aligning with one.

## Ready for Proposal

Yes. The codebase investigation is complete: call sites, capability shape,
observability pattern, error conventions, and the fallback-staleness
tradeoff are all documented above with concrete file/line references. The
orchestrator should proceed to `sdd-propose`, and propose/design should make
an explicit, stated decision on:
1. Reject vs. warn-only (or both, gated by a flag) — the issue allows either.
2. How to handle the bootstrap/fallback-staleness false-positive risk
   (options a/b/c above).
3. Whether `/v1/tokens/count` is in scope.
4. Which error-shape convention (`invalid_request_error` vs `proxy_error`)
   the new rejection uses, if rejection is chosen.
</content>
