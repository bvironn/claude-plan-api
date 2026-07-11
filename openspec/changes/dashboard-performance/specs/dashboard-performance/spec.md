# Dashboard Performance Specification

## Purpose

Perceived-load requirements for the dashboard: syntax highlighting must not block the transcript route's initial synchronous bundle, and background data refetching must avoid redundant network calls while preserving the request list's live polling.

## Requirements

### Requirement: Async Shiki Chunk Boundary

The transcript markdown renderer MUST NOT statically import the `shiki` module or any of its type-only exports at the top level of `markdown-view.tsx`. Shiki MUST only be reachable through a dynamic `import("shiki")` call, so Vite emits it as a separate async chunk not bundled into the transcript route's synchronous chunk.

#### Scenario: No static shiki import in source

- GIVEN the file `src/ui/src/components/transcript/markdown-view.tsx`
- WHEN its import statements are inspected
- THEN there is no top-level `import ... from "shiki"` or `import type ... from "shiki"` statement
- AND the only reference to the `shiki` module is inside a dynamic `import("shiki")` expression

#### Scenario: Type safety preserved without a static import

- GIVEN shiki types are needed for the highlighter instance and bundled language values
- WHEN the project is type-checked with `tsc`
- THEN type-checking succeeds using types derived from the dynamic `import("shiki")` (e.g. inline `import("shiki").Highlighter`), with no `any` widening introduced for the highlighter API

### Requirement: Plain-Text Fallback During Highlight Load

While the shiki highlighter is loading or has not yet produced highlighted HTML for a code block, the renderer MUST show the raw code as plain preformatted text instead of blocking or showing nothing.

#### Scenario: Fallback rendered before highlighter resolves

- GIVEN a fenced code block is rendered by `SyntaxHighlighted`
- WHEN the shiki highlighter promise has not yet resolved
- THEN the component renders a `<pre><code>` element containing the raw, unhighlighted code
- AND no error is thrown and no blank output is shown

#### Scenario: Highlighted output replaces fallback once ready

- GIVEN the plain-text fallback is showing for a code block
- WHEN the shiki highlighter resolves and produces highlighted HTML for that code/lang pair
- THEN the rendered output is replaced with the highlighted HTML
- AND unmounting the component before resolution does not throw or update state on the unmounted instance

### Requirement: Bounded Query Staleness Defaults

The application's global React Query defaults MUST set `staleTime` to a value between 15,000ms and 30,000ms inclusive, and MUST set the router's `defaultPreloadStaleTime` to a non-zero value, so that route preloads and background queries do not force redundant fetches on every focus/navigation.

#### Scenario: Global staleTime is bounded

- GIVEN the `QueryClient` constructed in `src/ui/src/main.tsx`
- WHEN its `defaultOptions.queries.staleTime` is inspected
- THEN the value is a number `>= 15_000` and `<= 30_000`

#### Scenario: Router preload staleTime is non-zero

- GIVEN the router constructed in `src/ui/src/main.tsx`
- WHEN its `defaultPreloadStaleTime` option is inspected
- THEN the value is a number greater than `0`

### Requirement: Index Route Live Polling Preserved

The request list route (`/`) MUST continue to refetch its `requests` query every 5,000ms regardless of the global staleTime change, so the live list keeps updating while a user is on the page.

#### Scenario: Index route keeps its 5s refetch interval

- GIVEN the `useQuery` call for the `requests` query key in `src/ui/src/routes/index.tsx`
- WHEN its options are inspected
- THEN `refetchInterval` is exactly `5_000`

#### Scenario: Global staleTime change does not remove the interval

- GIVEN the global `staleTime` has been raised to a bounded value per the Bounded Query Staleness Defaults requirement
- WHEN the index route mounts
- THEN `refetchInterval: 5_000` is still present on the `requests` query options, unaffected by the global staleTime
