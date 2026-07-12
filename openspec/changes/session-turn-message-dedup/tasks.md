# Tasks: Session Turn Message Dedup

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~300–340 |
| 400-line budget risk | Low–Medium |
| Chained PRs recommended | No (single PR within budget) |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast (auto-chain on budget exceeded only) |
| Chain strategy | stacked-to-main |

Detailed breakdown: `session-turns.ts` pure functions ~95 lines, `sessions.ts` export ~1 line, `s.$sessionId.tsx` wiring ~25 lines, `transcript-view.tsx` marker+suffix ~40 lines, `__tests__/ui-session-message-dedup.spec.ts` ~150 lines (15 tests across 3 describe blocks). The proposal's 180–260 estimate was too low by roughly the test file alone (~150 lines vs expected ~60–80). Acceptable margin: the single PR stays under 400 lines even with the fuller test coverage. No chain split required.

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low–Medium

### Stable identity confirmed

`request.traceId` (string) — unique per turn, already used as React key in the map render (`s.$sessionId.tsx:147`). The dedup Map is also keyed by traceId; origin turn reference is `originTurnIndex` + `originTraceId` in the `TurnDedup` type. Source: `RequestRecord.traceId` in `src/ui/src/lib/types.ts:16` + actual `key={turn.request.traceId}` usage.

### Design state (summarised from `design.md`)

- **`computeMessageDedup(turns)`** — pure function returning `Map<traceId, TurnDedup>`. Per-turn safety: turn 0 → `{kind:"full"}`; `len(i) < len(i-1)` → `{kind:"full"}`; any hash mismatch at `p < len(i-1)` → `{kind:"full"}`; else → `{kind:"deduped", sharedCount: len(i-1), originTurnIndex: i-1, originTraceId: turns[i-1].traceId}`. Fingerprint = `role + ":" + stringify(content)` hashed via djb2 (`hash()` from `sessions.ts`). Last turn recomputed each render via `useMemo` on `turns`.
- **`turnStaleTime(index, total)`** — pure: `index === total - 1` → `0` (last turn live); else → `Infinity` (prior turns immutable).
- **Fetch caching** — keep single `useQuery` + `Promise.all`; wrap each turn in `queryClient.ensureQueryData(["session-turn", id], …)` with per-turn `staleTime`. Add outer `refetchInterval`. This preserves `turnsQuery.data`/`isPending`/render `.map` — smallest diff while achieving per-turn cache control.
- **Marker UX** — one static muted marker per shared prefix: "N earlier messages already shown in Turn K" (not per-message, not clickable — sidesteps HTML interactive-nesting rule).
- **`TranscriptView`** — backward-compatible: optional `dedup` prop. When `dedup.kind === "deduped"`, render `<DedupMarker>` then `messages.slice(sharedCount)`. When `undefined` or `{kind:"full"}`, render all messages as before. Callers at `r.$traceId.tsx` pass no dedup → unchanged.

### Suggested Work Unit

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Pure dedup/cache functions + tests + UI wiring | Single PR | `bun test __tests__/ui-session-message-dedup.spec.ts` then `bun run tsc --noEmit` __AND independently__ `(cd src/ui && bun run typecheck)` (use `;` not `&&` — see `openspec/config.yaml` quality.command comment for why root tsc baseline errors must not short-circuit the UI check) | Open `/s/$sessionId` (real multi-turn session) — marker shows for repeated messages, mismatch falls back to full render, non-last turns don't refetch on poll, last turn keeps updating | Revert 4 files (session-turns.ts, sessions.ts, s.$sessionId.tsx, transcript-view.tsx) + delete test file |

---

## Phase 1: Types, Signatures, and Pure-Function Exports

- [x] 1.1 Export `hash()` from `src/ui/src/lib/sessions.ts` — currently `function hash(text: string): string` (line 105), change to `export function hash`. This is a one-line change but is REQUIRED: `computeMessageDedup` calls `hash()` for fingerprinting.

- [x] 1.2 Define types and function signatures in `src/ui/src/lib/session-turns.ts`. Add `TranscriptMessage` interface (reusable shape for parsed messages), `TurnDedup` union type (the `{kind:"full"}` / `{kind:"deduped"}` variants), `resolveTranscriptMessages(record)` (shared resolver used by both `TranscriptView` and `computeMessageDedup`), `computeMessageDedup(turns)` (returns `Map<string, TurnDedup>` — keyed by traceId), and `turnStaleTime(index, total)` (returns `number` — `0` or `Infinity`). Implement stub returns that satisfy the type checker but return naive defaults (e.g. `computeMessageDedup` returns `Map` with all `{kind:"full"}`, `turnStaleTime` returns `0`, `resolveTranscriptMessages` replicates current inline logic). Imports needed: `RequestRecord`, `AnthropicRequestBody`, `OpenAIChatRequestBody` from `./types`, `parseOrNull` from `./format`, `hash` from `./sessions`. Add doc comments matching the `computeExpandedTurns`/`toggleTurnInteraction` pattern.

## Phase 2: Write Tests (RED — TDD first)

All tests go in `__tests__/ui-session-message-dedup.spec.ts`. Follow the structure and conventions of `__tests__/ui-session-turn-collapse.spec.ts` exactly: `import { test, expect, describe } from "bun:test"`, pure-function import from `../src/ui/src/lib/session-turns`, one `describe` block per function, one `test` per scenario, no DOM/mocking.

### resolveTranscriptMessages tests

- [x] 2.1 Test: upstream-preferred — record has valid `upstreamRequestBody` with `messages` → returns those messages. (spec: Dedup MUST compare the same resolved arrays TranscriptView renders.)

- [x] 2.2 Test: client fallback (system-filtered) — record has no upstream body but has client `requestBody` with `messages` containing non-system roles → returns those messages with system entries filtered out. (design: `upstream.messages ?? clientReq?.messages?.filter(m => m.role !== "system")`)

- [x] 2.3 Test: empty/malformed — record with no parseable body fields → returns `[]` without throwing. (spec: zero-turn/loading must not throw.)

### computeMessageDedup tests

- [x] 2.4 Test: byte-exact prefix dedup — 3 turns where each is a prefix of the next. Turn 0 → `{kind:"full"}`; turn 1 → `{kind:"deduped"}` with `sharedCount` equal to turn 0's message count and `originTurnIndex` 0; turn 2 → `{kind:"deduped"}` with `sharedCount` equal to turn 1's message count and `originTurnIndex` 1. (spec scenario: Repeated prefix message renders as reference marker; Each unique message shown once across turn boxes.)

- [x] 2.5 Test: mismatch at index >0 → full — turn K diverges from K-1 at position `p > 0` → turn K is `{kind:"full"}`. (spec scenario: Divergent prefix renders full.)

- [x] 2.6 Test: mismatch at index 0 → full — turn 2's message[0] differs from turn 1's message[0] → entire turn 2 is `{kind:"full"}` with no partial dedup. (spec scenario: Divergence at index 0 renders entire turn full.)

- [x] 2.7 Test: prefix shrink (len(i) < len(i-1)) → full — turn 2 has fewer messages than turn 1 (anomaly) → turn 2 is `{kind:"full"}`. (design safety: `len(i) < len(i-1)` → full.)

- [x] 2.8 Test: turn 0 always full — turn 0 is always `{kind:"full"}` regardless of content. (design safety: `i == 0` → full.)

- [x] 2.9 Test: single-turn session — exactly one turn → Map has one entry with `{kind:"full"}`. (spec scenario: Single-turn session.)

- [x] 2.10 Test: zero-turn / empty input — empty `[]` → returns empty `Map`, no error. (spec scenario: Zero-turn or loading session.)

- [x] 2.11 Test: no input mutation — input `turns` array and its elements are not mutated by the function call. (matches existing collapse test's no-mutation guard.)

### turnStaleTime tests

- [x] 2.12 Test: last turn returns 0 — `turnStaleTime(2, 3)` → `0` (last index in 3-element array). (spec: Live Last-Turn Updates.)

- [x] 2.13 Test: prior turn returns Infinity — `turnStaleTime(0, 3)` → `Infinity` and `turnStaleTime(1, 3)` → `Infinity`. (spec: Immutable-Turn Fetch Caching.)

- [x] 2.14 Test: single-turn session — `turnStaleTime(0, 1)` → `0` (the only turn is also the last turn, must stay live). (spec: Single-turn session.)

- [x] 2.15 Test: zero-turns edge case — `turnStaleTime` is never called for zero turns (empty array → no map iteration), but guard against negative index: `turnStaleTime(-1, 0)` → `Infinity` (default to immutable for safety).

## Phase 3: Implement (GREEN) + Wire Components

- [x] 3.1 Implement `resolveTranscriptMessages(record)` — parse `upstreamRequestBody` (Anthropic shape), fall back to `requestBody` (OpenAI shape, system-filtered), return typed `TranscriptMessage[]`. All Phase 2 `resolveTranscriptMessages` tests pass.

- [x] 3.2 Implement `computeMessageDedup(turns)` — algorithm per design:
  1. For each turn, compute fingerprint array via `hash(role + ":" + JSON.stringify(content))`.
  2. For turn 0 → `{kind:"full"}`.
  3. For turn i:
     - If `messages[i].length < messages[i-1].length` → `{kind:"full"}` (shrink guard).
     - If any `fingerprints[i][p] !== fingerprints[i-1][p]` for `p < messages[i-1].length` → `{kind:"full"}` (mismatch guard).
     - Else → `{kind:"deduped", sharedCount: messages[i-1].length, originTurnIndex: i-1, originTraceId: turns[i-1].traceId}`.
  4. Return `Map<string, TurnDedup>` keyed by `traceId`.
  All Phase 2 `computeMessageDedup` tests pass.

- [x] 3.3 Implement `turnStaleTime(index, total)` — `index === total - 1 && total > 0` → `0`; else → `Infinity`. All Phase 2 `turnStaleTime` tests pass.

- [x] 3.4 Refactor `turnsQuery` in `s.$sessionId.tsx`:
  - Import `useQueryClient` from `@tanstack/react-query`.
  - Import `computeMessageDedup`, `turnStaleTime` from `@/lib/session-turns`.
  - Import `SESSION_GROUPING_REFETCH_INTERVAL_MS` from `@/lib/session-query`.
  - Add `const queryClient = useQueryClient()` in `SessionDetailPage`.
  - Change `turnsQuery`'s `queryFn` to map `traceIds` through `queryClient.ensureQueryData(["session-turn", id], { queryFn: () => getRequest(id).catch(() => null), staleTime: turnStaleTime(i, arr.length) })` preserving the existing null-filter pattern.
  - Add `refetchInterval: SESSION_GROUPING_REFETCH_INTERVAL_MS` to `turnsQuery` options.
  - Add `const dedupMap = useMemo(() => computeMessageDedup(turnsQuery.data?.map(t => t.request) ?? []), [turnsQuery.data])` — derives the per-turn dedup state.
  - Thread `dedup={dedupMap.get(turn.request.traceId)}` into each `TurnSection` render.

- [x] 3.5 Modify `TranscripView` in `transcript-view.tsx`:
  - Add optional `dedup` prop of type `TurnDedup`.
  - Import `resolveTranscriptMessages` from `@/lib/session-turns` (replaces inline message resolution).
  - Refactor the `useMemo` to call `resolveTranscriptMessages(record)` instead of parsing inline (shared resolver — no drift).
  - When `dedup?.kind === "deduped"`: render a compact static `<DedupMarker>` (e.g. `<p className="text-muted-foreground text-xs italic">N earlier messages already shown in Turn K</p>`) then `messages.slice(dedup.sharedCount)` rendered as today.
  - When `dedup?.kind === "full"` or `dedup === undefined`: render all messages as today (backward-compatible).

- [x] 3.6 Modify `TurnSection` in `s.$sessionId.tsx`:
  - Add optional `dedup?: TurnDedup` prop to the `TurnSection` function signature.
  - Pass `dedup` to both `<TranscriptView>` callsites (last-turn path and prior-turn path).

- [x] 3.7 Run all verification commands:
  - `bun test` — all tests pass (include the new dedup tests).
  - `bun run tsc --noEmit` — root project type-checks clean (any pre-existing errors outside this change's scope are documented).
  - `(cd src/ui && bun run typecheck)` — UI project type-checks clean (MANDATORY: use `;` not `&&` between the two commands — see `openspec/config.yaml` quality.command comment: root tsc has a documented pre-existing non-zero baseline that would short-circuit `&&` and silently skip the UI check).

## Phase 4: Verify + Archive

- [ ] 4.1 Edge-case confirmation (live browser / manual runtime — deferred to `sdd-verify` since task-apply executor cannot open a live browser):
  - Open a real multi-turn session with 3+ turns (at least one already-fetched prior turn). Confirm the always-expanded last turn renders a compact dedup marker for the shared prefix and only renders the new suffix in full.
  - Confirm that expanding a prior turn manually shows its full message set (no markers on prior turn since `computeMessageDedup` marks prior turns with `{kind:"deduped}"` only in the Map, but `TranscripView` on prior turns gets the correct dedup entry — turn 0 is always `full`, prior turns are `deduped` only against THEIR predecessor, meaning they render marker + suffix relative to the turn before them. Cross-check: prior turn 1 of 3 should have `dedup.kind === "deduped"` with `sharedCount` = length of turn 0, rendering marker + its own new messages. This is expected and correct per the uniform-dedup decision.)
  - Open a session with divergent prefix (edit/retry scenario). Confirm the divergent turn renders FULL content with NO markers.
  - Open a single-turn session. Confirm no marker rendered, full content shown.
  - Open a session and wait for a poll. Confirm non-last turns are NOT re-fetched (check browser network tab) and the last turn IS re-fetched.
  - Open a session where a new turn arrives (wait for poll). Confirm the previous last turn now stays cached and the new last turn updates live.

- [ ] 4.2 Archive per SDD close protocol — sync delta specs to archive, update change registry. _(Deferred — separate `sdd-archive` phase, runs after verify + PR.)_

## Verification Command Reference

The consolidated verify command for this change (before opening PR):

```sh
bun run tsc --noEmit; (cd src/ui && bun run typecheck)
```

Run each half independently and check BOTH outputs. Do NOT chain with `&&` — a pre-existing non-zero exit from root `tsc --noEmit` (documented in `openspec/config.yaml` quality.command) would short-circuit an `&&` chain and silently skip the UI typecheck. The dashboard-performance-2 incident (2026-07-11) demonstrated this failure mode in production.

## Out of Scope

- Re-opening `session-turn-updates` Phase 4 (verify/archive) — that stays a separate pre-existing loose end, not part of this change.
- Backend changes, LLM/upstream request path modifications, or message-index slicing endpoints — explicitly outside the spec boundary (Upstream Request Path Boundary).
