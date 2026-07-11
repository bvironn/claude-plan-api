# Tasks: Dashboard Performance — Lazy Shiki Chunk + Refetch Tuning

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~60-90 (2 edited files + ~1 new test file) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Async shiki chunk + bounded refetch defaults, on `feat/dashboard-performance` off `master` | PR 1 | `bun test __tests__/dashboard-performance.spec.ts` | `bun run --cwd src/ui build` then inspect `src/ui/dist` chunk manifest for a shiki chunk separate from transcript-view | Revert edits to `markdown-view.tsx` and `main.tsx`; no schema/API/dep changes |

## Phase 1: RED — Structural Tests

- [x] 1.1 Create `__tests__/dashboard-performance.spec.ts`. Test: read `src/ui/src/components/transcript/markdown-view.tsx` text; assert no top-level `import ... from "shiki"` / `import type ... from "shiki"` line exists, and a dynamic `import("shiki")` call is present.
- [x] 1.2 Same file: assert the `SyntaxHighlighted` plain-text fallback block (`html === null` → `<pre><code>`) is still present in source — regression guard for the existing fallback behavior.
- [x] 1.3 Same file: read `src/ui/src/main.tsx` text; assert the `staleTime` literal parses as a number `>= 15000` and `<= 30000`, and `defaultPreloadStaleTime` parses as a number `> 0`.
- [x] 1.4 Same file: read `src/ui/src/routes/index.tsx` text; assert `refetchInterval: 5_000` is still present on the `requests` query (must stay green before and after Phase 2).
- [x] 1.5 Run `bun test __tests__/dashboard-performance.spec.ts`; confirm 1.1–1.3 fail (RED), 1.4 passes (baseline).

## Phase 2: GREEN — Implementation

- [x] 2.1 In `markdown-view.tsx`, delete the static `import type { Highlighter, BundledLanguage } from "shiki"` line.
- [x] 2.2 Replace all `Highlighter`/`BundledLanguage` type usages in the file (highlighter promise, `LANGS` array, cast sites) with local type aliases derived from `Awaited<ReturnType<typeof import("shiki").createHighlighter>>` and `import("shiki").BundledLanguage`.
- [x] 2.3 In `main.tsx`, raise `queryClient` `defaultOptions.queries.staleTime` from `5_000` to a bounded value (e.g. `20_000`).
- [x] 2.4 In `main.tsx`, set `router.defaultPreloadStaleTime` from `0` to a non-zero value matching 2.3.
- [x] 2.5 In `main.tsx`, review `refetchOnWindowFocus: true`; keep or adjust per redundant-fetch analysis and document the choice with an inline comment.
- [x] 2.6 Run `bun test __tests__/dashboard-performance.spec.ts`; confirm all assertions pass (GREEN).

## Phase 3: Verification

- [x] 3.1 Run `bun run --cwd src/ui typecheck`; confirm success with no `any` widening on the highlighter API.
- [x] 3.2 Run `bun run --cwd src/ui build`; inspect the emitted chunk manifest to confirm shiki resolves into a chunk separate from the transcript-view chunk.
- [x] 3.3 Run full `bun test` at repo root; confirm no regressions.

## Phase 4: Cleanup

- [x] 4.1 Remove any stale comments referencing the old static shiki import in `markdown-view.tsx`.
- [x] 4.2 Confirm `git diff --stat` stays well under the 400-line budget before opening the PR.

## Known Coverage Gap

Behavioral rendering scenarios (highlighted HTML replacing fallback, unmount-before-resolve safety) are not automated: this repo has no DOM/React test harness at root (`__tests__/` is DOM-free per existing convention) and adding one is out of scope. Phase 1.2 covers this as a structural regression guard only; manual verification recommended before merge.
