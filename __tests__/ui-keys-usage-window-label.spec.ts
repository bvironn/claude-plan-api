import { test, expect, describe } from "bun:test"

// Structural/source-text assertion only — this repo's __tests__/ is DOM-free
// by convention (see dashboard-performance.spec.ts and ui-api-keys.spec.ts's
// docstring: full interactive rendering of keys.tsx is out of scope for
// Phase 7 manual verification), so we assert on the compiled-away source
// rather than rendering the React component.

const keysRoutePath = new URL("../src/ui/src/routes/keys.tsx", import.meta.url)

// ---------------------------------------------------------------------------
// REL-002 — honest "Usage" column label
//
// getUsageByApiKey() (client wrapper, api.ts) calls the windowed
// /api/telemetry/usage endpoint with zero filters. Pre-Phase-3 this returned
// all-time totals; post-Phase-3 it silently returns a trailing-30-day rollup
// (Phase 3 finding #5, DEFAULT_USAGE_WINDOW_MS). The "Usage" column header,
// polled every 15s, gave operators no indication a window was applied — a
// truncated number could be mistaken for the true all-time total.
// ---------------------------------------------------------------------------

describe("keys.tsx: Usage column window disclosure (REL-002)", () => {
  test("the Usage column header is no longer the bare, ambiguous \"Usage\" string", async () => {
    const source = await Bun.file(keysRoutePath).text()
    // The old, misleading bare header: `<TableHead ...>Usage</TableHead>`.
    const bareHeaderPattern = /<TableHead[^>]*>\s*Usage\s*<\/TableHead>/
    expect(bareHeaderPattern.test(source)).toBe(false)
  })

  test("the Usage column header text discloses the applied window (e.g. last 30 days)", async () => {
    const source = await Bun.file(keysRoutePath).text()
    // Any TableHead whose text mentions "Usage" must also mention a window
    // qualifier (day-based wording) so operators can't mistake it for an
    // all-time total.
    const headerMatch = source.match(/<TableHead[^>]*>([^<]*Usage[^<]*)<\/TableHead>/)
    expect(headerMatch).not.toBeNull()
    const headerText = headerMatch![1]!
    expect(headerText).toMatch(/30[\s-]?d(ay)?s?/i)
  })
})
