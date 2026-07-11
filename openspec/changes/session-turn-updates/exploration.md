## Exploration: Session Turns — Collapsible-to-Last + Live Updates

### Issue (backlog #4, dashboard/keys)
"Turnos de sesiones no son colapsables — deberían mostrar siempre solo el último turno, actualizable en vivo."
(Session turns are not collapsible — they should always show only the latest turn, updatable live.)

### Current State

**Route**: `/s/$sessionId` → `SessionDetailPage` (`src/ui/src/routes/s.$sessionId.tsx:38`)

Data flow:
1. `groupQuery` — `useQuery({ queryFn: () => listRequests({ path: "/v1/chat/completions", limit: 500, order: "desc" }), refetchInterval: 10_000 })`. Fetches ALL chat-completion requests (poll every 10s), then `groupIntoConversations()` (`src/ui/src/lib/sessions.ts:117`) groups them client-side into `Conversation` objects keyed by a hash of the first user message, with a 60-minute idle-window cutoff. `sessionId` in the URL IS the conversation's synthetic id (`${key}-${hash(firstTraceId)}`).
2. `conversation` — the matching `Conversation` is found from the re-grouped list via `.find(g => g.id === sessionId)`.
3. `turnsQuery` — once `conversation` resolves, fetches the FULL `RequestRecord` (with bodies) for **every** `traceId` in `conversation.traceIds` via `Promise.all(conversation.traceIds.map(id => getRequest(id)))`. This is a **one-shot fetch, NOT polling** — `turnsQuery` has no `refetchInterval`. Its `queryKey` includes `conversation?.traceIds`, so it only re-runs when the array of trace ids itself changes identity (i.e., when `groupQuery`'s next 10s poll produces a `Conversation` object with a new/different `traceIds` array — a new `Conversation` object is built fresh every `groupIntoConversations()` call, so referential identity changes on every `groupQuery` refetch, which SHOULD cause `turnsQuery` to re-run every ~10s in practice, refetching every turn's full record each time).
4. Render — `turnsQuery.data.map((turn, i) => <TurnSection index={i} total={...} request={turn.request} />)`. **ALL turns render unconditionally, always expanded**, stacked vertically inside `<div className="flex flex-col gap-6">`. This is the literal bug: no collapse state exists at all — every turn's full `TranscriptView` (all messages, system blocks, reasoning, response) renders simultaneously, all the time.

**Turn rendering** (`TurnSection`, `s.$sessionId.tsx:181`): a sticky header badge (`Turn {i+1} / {total}`, status, timing, trace-id link) + `<TranscriptView record={request} />` (full transcript, unconditionally expanded — no `<Collapsible>` wrapper).

**Definition of "turn"**: 1 turn == 1 `RequestRecord` == 1 `POST /v1/chat/completions` call. `Conversation.turns` is literally the count of grouped requests (`src/ui/src/lib/sessions.ts:24,148,161`). Multi-turn chat clients (OpenCode, Claude Code, etc.) send the FULL running message history on every turn — so turn N's `TranscriptView` already contains turns 1..N-1 as prior messages in the same rendered transcript. This means **stacking all N turn cards is redundant by construction**: the last turn's transcript is a superset of every earlier turn's content (same first-user-question group, same or growing message array). Collapsing to "show only the latest turn" doesn't lose information — it removes literal duplication.

### Affected Areas

- `src/ui/src/routes/s.$sessionId.tsx` — `SessionDetailPage` (turns render loop, lines 118-134) and `TurnSection` (lines 181-216). Primary edit site for collapse-to-last-turn behavior.
- `src/ui/src/lib/sessions.ts` — `groupIntoConversations()`/`Conversation` — defines what a "turn" is; no changes needed for the collapse UX itself, but `conversation.latestTraceId` (line 36) already identifies the "last (richest) turn" and is unused by `SessionDetailPage` today (it re-derives the full list via `turnsQuery` instead of fetching just the latest turn).
- `src/ui/src/components/ui/collapsible.tsx` — existing Radix wrapper (`Collapsible`/`CollapsibleTrigger`/`CollapsibleContent`), already used 5x elsewhere (`reasoning-block.tsx`, `system-blocks.tsx`, `message-bubble.tsx`'s `ThinkingInlineBlock`, `context-preamble.tsx`) — established project pattern to reuse for collapsing older turns.
- `src/ui/src/hooks/useEventStream.ts` — SSE hook. **NOT currently wired into the Sessions or session-detail views** (only `src/ui/src/routes/live.tsx` uses it). Relevant only if "live updates" for the last turn is implemented via SSE instead of polling.
- `src/ui/src/routes/sessions.tsx` — list view (`SessionsPage`), already polls every 10s and correctly shows `conv.turns` count; not directly in scope but the copy at line 88-90 ("click to open the latest turn") already describes the intended UX this issue wants to formalize.
- `src/guards/api-key.ts` (`enforceApiKey`, `isGated`) + `.env` (`REQUIRE_API_KEY=true`) — relevant only if the "live updates" approach chosen for the last turn ends up being SSE-based (see gotcha below); irrelevant if it stays polling-based (current pattern, already Bearer-authenticated via `authHeaders()` in `getJson()`).

### Key Finding: "Live updates" for session turns is ALREADY polling-based, NOT SSE — the known SSE/auth gotcha does NOT block this issue

This is the most important finding for scoping the proposal.

- `useEventStream` (browser `EventSource` on `GET /api/telemetry/stream`) is used **exactly once** in the whole UI: `src/ui/src/routes/live.tsx` (`LivePage`, the raw event-log page, not sessions). `grep` confirms no other caller.
- `SessionDetailPage` and `SessionsPage` do NOT use `useEventStream` or `EventSource` at all. They use TanStack Query's `refetchInterval: 10_000` (plain authenticated `fetch` via `getJson()` → `authHeaders()` attaches `Authorization: Bearer <key>` correctly, confirmed in `src/ui/src/lib/api.ts:20-23`).
- Conclusion: **the previously-discovered SSE/Bearer-header gotcha (Engram #838, `src/ui/src/hooks/useEventStream.ts` can't attach `Authorization` to `EventSource`, causing 401 under `REQUIRE_API_KEY=true`) affects ONLY `/live`, and has NO bearing on session-turn live updates**, because sessions never used SSE in the first place. It is a real, live, still-unfixed gap in this codebase (`REQUIRE_API_KEY=true` is set in `.env` today) — but it is **out of scope** for this change unless the proposal deliberately chooses to introduce SSE for turn updates (see Approach 3 below), in which case it becomes directly relevant and must either be fixed alongside or the SSE approach must be rejected in favor of polling.
- Today's "live-ness" of session turns is real but coarse: `groupQuery` and (indirectly, via query-key churn) `turnsQuery` both effectively refresh every 10s. It works, is Bearer-authenticated correctly, but re-fetches the FULL body of every turn's `RequestRecord` every poll — wasteful once turns are made collapsible (no reason to keep re-fetching bodies for turns the user can't even see).

### What's Broken vs. What's a UI/UX Gap

| Symptom | Root cause | Category |
|---|---|---|
| All turns show fully expanded, no collapse | `TurnSection` render loop has zero collapse state; no `<Collapsible>` wrapper (unlike reasoning/system blocks elsewhere in the same codebase) | **UI/UX gap** — straightforward fix, established pattern (`Collapsible`) exists to copy |
| "Should always show only the last turn" | By design today, session detail always fetches+renders every turn's full record even though turn N's transcript is a superset of turn N-1's (multi-turn clients resend full history) | **UI/UX gap + wasted fetch** — fixable by defaulting to collapsed-except-last, or by not even fetching bodies for non-latest turns |
| "Updatable in vivo" (live) | Polling already exists (`refetchInterval: 10_000` on both queries) and works correctly with Bearer auth | **Not broken** — already live, just coarse-grained (whole-conversation refetch, not incremental) |
| SSE auth gotcha (Engram #838) | `EventSource` can't set `Authorization` header; `REQUIRE_API_KEY=true` is live in `.env` | **Real, separate, pre-existing gap** — confirmed unfixed, but isolated to `/live` today; only becomes in-scope if this change chooses an SSE-based approach |

### Approaches

1. **Collapse older turns behind `<Collapsible>`, keep polling as-is (Recommended baseline)**
   Wrap turns `0..n-2` in the existing `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent` pattern (default `open=false`), always render the last turn (`index === total - 1`) expanded and un-collapsible. Keep `turnsQuery`'s current `refetchInterval`-driven-by-query-key-churn polling (or explicitly add `refetchInterval: 10_000` to `turnsQuery` itself instead of relying on `groupQuery`'s query-key churn, which is implicit and fragile).
   - Pros: Reuses an established, already-tested-elsewhere UI primitive (0 new dependencies); minimal surface area; no backend changes; no interaction with the SSE gotcha at all; directly satisfies both halves of the issue ("collapsible" + "still live" since polling already works).
   - Cons: Still fetches full bodies for every turn every ~10s even though most are collapsed (wasteful bandwidth/DB reads for long conversations); "live" stays coarse (whole-turn-list refetch, not incremental).
   - Effort: Low.

2. **Collapse older turns AND stop fetching full bodies for non-latest turns**
   Same collapse UX as (1), but change `turnsQuery` to only fetch full `RequestRecord` (with bodies) for `conversation.latestTraceId`; for earlier turns, only fetch lightweight metadata already available from `groupQuery`'s `RequestRecord` list (status, timing, tokens — no bodies) and lazy-fetch the full body via `getRequest()` only when the user expands an older turn's `<Collapsible>`.
   - Pros: Meaningfully reduces payload size/DB load for conversations with many turns (matches the "why fetch what you don't render" principle already used elsewhere, e.g. `staleTime: 30_000` comments in `r.$traceId.tsx`); scales better for long sessions.
   - Cons: More invasive — requires restructuring `turnsQuery` from one bulk `Promise.all` into a "fetch latest eagerly, fetch older lazily on expand" pattern; more testing surface (loading/error states per collapsed turn); larger diff.
   - Effort: Medium.

3. **Add true incremental live updates via SSE for the latest turn (in-progress streaming turn)**
   Instead of/in addition to polling, subscribe to `/api/telemetry/stream` (or a new scoped stream) so the LAST turn's transcript updates token-by-token while a request is in flight, similar to how `ReplayButton`/`ReplayPanel` already stream a REPLAYED request via a raw authenticated `fetch()` + `res.body.getReader()` (NOT `EventSource` — `replay-button.tsx:146-186` proves the codebase already has a precedent for streaming via `fetch()` + manual reader, which correctly carries `authHeaders()` unlike `EventSource`).
   - Pros: Genuinely "live" in the sense of watching an in-flight response stream in, not just a 10s-later refresh; reuses the SAME auth-safe streaming pattern the Replay feature already established (`fetch()` + reader, not `EventSource`) — meaning this approach can sidestep the known `EventSource`/Bearer gotcha entirely instead of inheriting it.
   - Cons: Significantly more complex — requires either a new backend endpoint that streams a single in-flight `RequestRecord`'s progress (doesn't exist today; `updateRequest()` only writes to SQLite at stream end, per `src/transform/streaming.ts:298-342`, so there's no existing per-chunk broadcast to hook into for a specific trace id) or reusing the general `/api/telemetry/stream` (which DOES emit per-chunk events today but is exactly the endpoint blocked by the `EventSource`/Bearer gotcha — so this sub-path WOULD pull the gotcha into scope and require fixing it first, e.g. via a short-lived query-param stream token). Large scope increase for what the issue literally asks for (which is about turn visibility/collapsing, not token-by-token streaming).
   - Effort: High. Only worth considering if the proposal phase decides "live" must mean sub-second/in-flight, not "refreshes automatically."

### Recommendation

**Approach 1** (collapse via existing `Collapsible` pattern, keep the current 10s-polling live-refresh) directly and minimally satisfies the issue as literally worded: "always show only the last turn" (collapse older ones, last stays expanded) + "actualizable en vivo" (already true via polling, which correctly carries Bearer auth and is unaffected by the SSE gotcha). Approach 2 is a reasonable low-risk follow-on if the proposal phase wants to also address the "fetches every turn's full body every 10s" inefficiency, but is not required to satisfy the stated issue. Approach 3 should be explicitly rejected or deferred in the proposal — it answers a different, bigger question ("do we want token-by-token streaming in the dashboard") that goes beyond what backlog issue #4 asks for, and would drag in the SSE/auth gotcha as a hard blocker.

### Open Questions for Proposal Phase

1. Should ALL non-last turns default to collapsed, or only turns beyond some threshold (e.g. show last 2 expanded, collapse the rest)? The issue text says "always show only the last turn," suggesting all-but-last collapsed by default.
2. Should the collapsed turn header still show enough at-a-glance info (status, token count, timestamp) to be useful without expanding — `TurnSection`'s existing sticky header already has this; when collapsed it likely becomes the `CollapsibleTrigger` row.
3. Should `turnsQuery`'s implicit polling-via-query-key-churn be made explicit (`refetchInterval: 10_000` added directly to `turnsQuery`) as part of this change, since the current mechanism (relying on `groupQuery`'s refetch producing a new `traceIds` array identity) is correct but non-obvious and undocumented?
4. Out of scope for this change but worth a follow-up ticket: fix the `EventSource`/Bearer-header gap for `/live` (Engram #838) using the same "authenticated `fetch()` + reader" pattern `ReplayButton` already proves works, OR a short-lived stream token. Should this be filed as a separate backlog item now so it isn't lost?
5. Should collapsed turns keep their full `RequestRecord` (with bodies) in memory/fetched, or should Approach 2's lazy-fetch-on-expand be pulled into THIS change's scope rather than deferred? Depends on whether long conversations (dozens of turns) are a real, observed pain point today.

### Ready for Proposal
Yes. The issue is well-scoped and low-risk (Approach 1). The SSE/auth gotcha is confirmed real but confirmed NOT in the critical path for this specific issue — it should be surfaced to the user as a known separate gap (already documented once in `keys.tsx` comments and Engram #838) rather than bundled into this change, unless the proposal phase explicitly chooses Approach 3.
</content>
