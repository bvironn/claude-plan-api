import { test, expect, describe } from "bun:test"

// DOM-free source-text guard (repo convention — see dashboard-performance.spec.ts).
// prettyJson(content) ran JSON.parse + JSON.stringify on EVERY render of
// JsonBlock; finding #8 requires it memoized on `content` so it only recomputes
// when the body actually changes.
const panelPath = new URL(
  "../src/ui/src/components/panels/technical-panel.tsx",
  import.meta.url,
)

describe("finding #8: prettyJson is memoized in the technical panel", () => {
  test("JsonBlock wraps prettyJson in a useMemo keyed on content", async () => {
    const source = await Bun.file(panelPath).text()
    expect(source).toMatch(
      /useMemo\(\s*\(\)\s*=>\s*prettyJson\(content\)\s*,\s*\[content\]\s*\)/,
    )
  })

  test("imports useMemo from react", async () => {
    const source = await Bun.file(panelPath).text()
    expect(source).toMatch(/import\s+\{[^}]*\buseMemo\b[^}]*\}\s+from\s+["']react["']/)
  })

  test("the memo runs before the early return so it obeys the rules of hooks", async () => {
    const source = await Bun.file(panelPath).text()
    const memoIdx = source.indexOf("useMemo(() => prettyJson(content)")
    const earlyReturnIdx = source.indexOf("Not recorded")
    expect(memoIdx).toBeGreaterThan(-1)
    expect(earlyReturnIdx).toBeGreaterThan(-1)
    expect(memoIdx).toBeLessThan(earlyReturnIdx)
  })
})
