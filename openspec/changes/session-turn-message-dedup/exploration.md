# Exploration: Session Turn Message Dedup (Last-Turn Body Duplication)

## Current State

Confirmed via source read (all line refs verified against current on-disk code):

- `RequestRecord.requestBody` / `upstreamRequestBody` (`src/ui/src/lib/types.ts:14-42`) store the FULL stringified JSON body of a `POST /v1/chat/completions` call, including a `messages: Array<{role, content}>` array (`AnthropicRequestBody.messages` / `OpenAIChatRequestBody.messages`, `types.ts:99-140`). `content` is `string | Array<Record<string, unknown>>` (blocks: text, tool_use, tool_result, thinking, image).
- `groupIntoConversations` (`src/ui/src/lib/sessions.ts:124`) groups requests into a `Conversation` whose `traceIds` is the chronological list of turn ids (1 turn = 1 `RequestRecord` = 1 POST call).
- `src/ui/src/lib/session-turns.ts`'s own doc comment already states the structural fact this change is built on: *"Each turn's transcript is a superset of the prior turn, so only the newest turn carries new information."*
- `s.$sessionId.tsx`'s `turnsQuery` (lines 65-75) still does `Promise.all(conversation.traceIds.map((id) => getRequest(id)...))` — it fetches the FULL `RequestRecord` (with bodies) for EVERY traceId, every time `conversation?.traceIds` gets a new array identity. That still happens on every `groupQuery` refetch (now a 30s `refetchInterval` per `session-query.ts`'s `SESSION_GROUPING_REFETCH_INTERVAL_MS`, reduced from the original 10s by `dashboard-performance-2`, but the underlying "refetch all N turns' full bodies regardless of need" behavior is unchanged — this is the same gap obs #933 flagged and deferred as "Approach 2", still unresolved today).
- Per the already-merged `session-turn-updates` change, turns `0..n-2` render collapsed (`Collapsible`/`CollapsibleContent`), unmounting their `TranscriptView` from the DOM. ONLY the last turn (`isLast=true`, no `Collapsible` wrapper) always renders expanded (`s.$sessionId.tsx:150-159`) — this always-expanded last turn is the target of the current exploration.
- `TranscriptView` (`src/ui/src/components/transcript/transcript-view.tsx:30-92`) already maps `messages` message-by-message: `messages.map((msg, i) => <MessageBubble .../>)` (line 67-71). This is a key enabler — a dedup/diff mechanism can slot into this exact map callsite without restructuring the render tree. `MessageBubble` (`message-bubble.tsx:113`) only knows how to render full content today; there is no "collapsed / already-shown-elsewhere" visual variant yet.
- No backend message-level id/hash exists. `src/observability/storage.ts`'s `insertRequest`/`updateRequest` (lines 348-451) persist `request_body` / `response_body` / `upstream_request_body` as opaque stringified JSON blobs — only whole-row FTS5 indexing exists, no per-message identity column. The by-id telemetry route (wired at `src/http/server.ts:111`, consumed via `getRequest(traceId)` in `api.ts:129-131`) takes no query params to slice a body server-side. So identity for dedup purposes has to be derived STRUCTURALLY on the client (array position + content), not looked up from an existing id.

## Confirmed growth-shape math

Standard multi-turn client behavior (OpenCode/Cline/etc., confirmed by the code comments above) resends the ENTIRE prior message history plus the new turn on every call:

- Turn 1 request: `messages = [user_1]`
- Turn 2 request: `messages = [user_1, assistant_1, user_2]`
- Turn 3 request: `messages = [user_1, assistant_1, user_2, assistant_2, user_3]`
- Turn N request: `messages = [user_1, assistant_1, ..., assistant_{N-1}, user_N]` → length `2N - 1`

Turn N's `messages` array therefore has turn (N-1)'s `messages` array as an EXACT prefix (same content, order, and length `2(N-1)-1`), followed by exactly 2 new entries: `assistant_{N-1}` (the prior turn's own reply, echoed back by the client as history) and `user_N` (the new question). This is confirmed structurally by `session-turns.ts`'s own docstring ("superset of the prior turn") and by the `messages` array shape consumed in `transcript-view.tsx`.

Assuming a roughly uniform per-turn payload size `C` (a simplification, but the same one implied by the problem statement, and it correctly captures the SHAPE of the growth, not an exact real-world multiplier):

- Turn k's own body size ≈ `(2k - 1) * C`
- Cumulative bytes rendered/fetched summed over turns `1..N` = `Σ(2k-1)*C` for `k=1..N` = `N² * C` (the sum of the first N odd numbers is exactly `N²`)

**Conclusion**: the O(n²) claim is confirmed as EXACT (not merely asymptotic) under the uniform-turn-size simplification — cumulative volume grows with `N²`. This shows up in two distinct, separable ways today:

1. **Network** (pre-existing, NOT this change's primary target): `turnsQuery`'s `Promise.all` fetches ALL N turns' full bodies on every refetch, not just the last. A single poll of an N-turn session already downloads `O(N²)` total bytes, independent of collapse state. Flagged in the `session-turn-updates` exploration as deferred "Approach 2"; still unaddressed.
2. **Render/display** (this change's actual scope): the always-expanded last turn's own body is `O(N)` in size at any single point in time, but turns `1..N-1`'s literal message text is duplicated INSIDE turn N's rendered box, even though that same text already appeared in full inside its own (now-collapsed) box earlier on the page. Watched over a session's lifetime (turn count growing one at a time), the cumulative rendered character volume is `O(N²)`.

## Affected Areas

- `src/ui/src/components/transcript/transcript-view.tsx` — the `messages.map(...)` callsite; the natural insertion point for message-level dedup/diff logic.
- `src/ui/src/routes/s.$sessionId.tsx` — `turnsQuery`; needs to make the previous turn's `messages` (or the full turn list) available to whichever turn is rendering, so diffing has something to compare against.
- `src/ui/src/lib/session-turns.ts` — natural home for a new PURE function (parallel to `computeExpandedTurns`) computing the "new-content-only" boundary per turn — keeps the existing side-effect-free / unit-testable pattern this project already established for collapse logic.
- `src/ui/src/lib/types.ts` — `AnthropicRequestBody.messages` / `OpenAIChatRequestBody.messages` shapes confirmed as literal ordered arrays of `{role, content}` — no type changes needed, just consumed.
- `src/ui/src/components/transcript/message-bubble.tsx` — would need a new compact "referenced / already shown" visual variant if per-message dedup markers are rendered inline (today it only renders full content).
- `src/http/routes/telemetry/*` and `src/observability/storage.ts` — ONLY in scope if a partial-fetch/backend-slicing approach (Approach 3) is chosen; otherwise untouched.
- Explicitly OUT of scope: the upstream/LLM request path (`src/http/routes/chat.ts`, `src/transform/streaming.ts`) — the full running history MUST keep being sent to the model exactly as today. Also out of scope: the collapse/`Collapsible` mechanism itself from `session-turn-updates`, which is not being changed by this work.

## Approaches

1. **Client-side message-level diff, render-only (recommended MVP)** — For any turn rendered in full (the always-expanded last turn, or any prior turn the user manually expands), compute the common message-array prefix against the immediately-preceding turn's messages (already present in memory — `turnsQuery.data` already holds every turn's full body via the existing `Promise.all(getRequest(...))` fetch, no new network call needed for the diff itself). Render messages in the shared prefix as a compact "already shown in turn K" marker instead of a full `MessageBubble`; render only the genuinely new suffix (typically the last 2 messages) in full.
   - Pros: No backend changes. Slots naturally into `TranscriptView`'s existing `messages.map()`. Purely additive/derived state, matching the "pure function + unit tests" pattern already established by `session-turns.ts`. Directly solves the DOM/render duplication the user explicitly called out. Low risk when a safe fallback is enforced (see Risks). Can reuse the existing content-hash pattern (`hash()` djb2, `sessions.ts:105-111`) for a cheap equality check instead of deep-equal on every render.
   - Cons: Does NOT reduce network bytes — `turnsQuery` still fetches every turn's full body on every refetch (a separate, pre-existing issue). Only reduces render/DOM cost and visual noise, not payload transferred.
   - Effort: Low–Medium.

2. **Approach 1 + turn-level fetch caching (also reduces network)** — In addition to (1), stop treating `turnsQuery` as one combined array-fetch that refetches everything whenever `traceIds` changes identity. Completed `RequestRecord` rows are immutable (a finished POST call's body never changes after the response is written — confirmed via `storage.ts`'s `insertRequest`/`updateRequest`, which only mutate a row while its own trace is in flight). Switch to a per-turn query (e.g. `useQueries`, one query per `traceId`) with `staleTime: Infinity` for any turn whose response is already terminal, and normal refetch behavior only for the current in-flight/last turn. Combined with (1)'s diffing, this avoids re-downloading the O(n²) duplicated bytes on every poll too, not just re-rendering them.
   - Pros: Solves BOTH the render duplication (via 1) and the pre-existing network duplication (the deferred "Approach 2" from `session-turn-updates`); relies only on existing data/immutability guarantees, no backend change.
   - Cons: Larger diff — restructures `turnsQuery` from one combined query into N independent queries; needs care around per-turn loading/error states and cache-key stability; still doesn't reduce bytes for the very FIRST fetch of a long session (only avoids re-fetching them on subsequent polls).
   - Effort: Medium.

3. **Backend partial-fetch / message-index slicing endpoint** — Add a query param (e.g. `?afterMessageIndex=N`) to the by-id telemetry endpoint so the client can request only the NEW messages beyond an index it already has, requiring the backend to parse+slice `request_body`/`upstream_request_body` server-side before returning.
   - Pros: True byte-level savings even on FIRST load of a long session; fully closes the "don't re-fetch bytes already fetched" half of the desired end state.
   - Cons: Touches `src/http/routes/telemetry/*` and possibly `storage.ts` (server-side JSON parsing/slicing, a capability not needed anywhere else today); higher risk (new backend surface, needs its own tests); larger scope — likely needs its own change/PR rather than fitting inside a single ~400-line review budget alongside (1); no existing per-message id/hash to slice on other than array-position semantics, which is fragile if client message shapes vary turn-to-turn.
   - Effort: High.

## Recommendation

Ship **Approach 1** (client-side, render-only dedup) as the MVP for this change, structured as a pure function in `session-turns.ts` (mirroring `computeExpandedTurns`) so it stays unit-testable and side-effect-free, consistent with this project's established pattern. **Approach 2** (turn-level fetch caching) is a natural, low-risk follow-up — either fold into the same change if it fits the 400-line budget, or propose immediately after as its own change, since it directly resolves the pre-existing network gap `session-turn-updates` explicitly deferred and this is the first change to actually need it. **Approach 3** (backend slicing) should be explicitly deferred/rejected for now: materially higher risk/effort, needs new backend surface with its own tests, and (1)+(2) together already solve BOTH the render and (mostly) the network manifestations of the problem without touching the backend or the upstream/LLM request path at all.

## Risks

- **Diff-safety / never drop content**: a structural (position-based) diff is only valid when turn N's prefix is byte-identical to turn N-1's full `messages` array. Client retries, message edits, or (rare) non-deterministic upstream/client reordering could break the "exact prefix" assumption. Required safe fallback: if the prefix comparison fails at ANY position, treat the entire turn as having no dedup-able prefix and render it in full — dedup must be provably safe or fall back to full rendering; it must never silently hide/drop a message that isn't a proven duplicate.
- **Equality-check cost**: naive deep-equal on every message on every render could be expensive for large content blocks (base64 images, large tool outputs). Recommend reusing the existing `hash()` (djb2) pattern from `sessions.ts` for a cheap content fingerprint comparison instead of full deep-equal.
- **Network savings deferred**: if only Approach 1 ships, the pre-existing O(n²) network over-fetch (all N turns' full bodies re-fetched on every ~30s poll) remains unresolved — this must be explicitly flagged to the user/PM as a known, separate follow-up, not silently left implicit.
- **Pre-existing loose end**: `session-turn-updates`'s `tasks.md` Phase 4 (4.1 manual verify, 4.2 archive) is still unchecked/open. This is a SEPARATE, pre-existing incomplete change, out of scope for `session-turn-message-dedup` — noted here only so it isn't confused with this change's own scope.

## Open Questions for Proposal

1. Visual treatment for a "referenced / already-shown" message inside the last turn's transcript: (a) an inline compact marker per deduped message (e.g. "↑ same as turn 3" chip in place of the full `MessageBubble`), (b) a single collapsed "N earlier messages (same as turns 1-3)" summary block instead of one marker per message, or (c) reuse the existing turn-badge/`Collapsible` visual language from `session-turn-updates` for consistency? This needs a product/UX decision, not just an engineering one.
2. Should a deduped marker be clickable to jump/scroll to the turn where the message first appeared (cross-link), or is a static "already shown" label sufficient for v1?
3. Should Approach 2 (turn-level fetch caching / avoid re-fetching completed turns) be pulled into this same change, or proposed as its own follow-up change? This affects the 400-line review-budget forecast for `sdd-tasks`.
4. Where exactly should the diff boundary be computed — inside `TranscriptView` itself (given both the current and previous turn's `RequestRecord`), or hoisted into `session-turns.ts` as a pure function fed by `s.$sessionId.tsx` (matching the existing `computeExpandedTurns` pattern)? Recommend the latter, for testability parity with the collapse logic.
5. Does this dedup treatment need to also apply to any manually-expanded PRIOR turn (not just the always-expanded last turn), given a user could expand turn 2 of 5 and it would also contain turn 1's messages as a duplicated prefix? The problem statement's primary target is the last turn, but the same duplication exists in any expanded prior turn.

## Ready for Proposal

Yes. The current state, growth-shape math, and diffability of the `messages` array are all confirmed against real source (not assumed). Approach 1 is well-scoped, low-risk, and directly addresses the stated problem without touching the upstream/LLM request path. Approach 2 is a clear, low-risk next step. Approach 3 should be explicitly deferred in the proposal.
