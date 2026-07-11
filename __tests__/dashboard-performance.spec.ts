import { test, expect, describe } from "bun:test"

// Structural/source-text assertions only — this repo's __tests__/ is DOM-free
// by convention, so we assert on the compiled-away source rather than
// rendering React components. See openspec/changes/dashboard-performance for
// the behavioral scenarios these guard.

const markdownViewPath = new URL(
  "../src/ui/src/components/transcript/markdown-view.tsx",
  import.meta.url,
)
const mainPath = new URL("../src/ui/src/main.tsx", import.meta.url)
const indexRoutePath = new URL("../src/ui/src/routes/index.tsx", import.meta.url)

describe("dashboard-performance: async shiki chunk boundary", () => {
  test('markdown-view.tsx has no static "shiki" import, only a dynamic import("shiki")', async () => {
    const source = await Bun.file(markdownViewPath).text()
    const staticImportPattern = /^\s*import\s+(type\s+)?[^;]*from\s+["']shiki["']\s*;?\s*$/m
    expect(staticImportPattern.test(source)).toBe(false)
    expect(source).toContain('import("shiki")')
  })

  test("markdown-view.tsx still renders a <pre><code> plain-text fallback while the highlighter loads", async () => {
    const source = await Bun.file(markdownViewPath).text()
    expect(source).toContain("html === null")
    expect(source).toMatch(/<pre[^>]*>\s*<code>\{code\}<\/code>\s*<\/pre>/)
  })
})

describe("dashboard-performance: bounded query staleness defaults", () => {
  test("main.tsx sets a bounded global staleTime between 15s and 30s", async () => {
    const source = await Bun.file(mainPath).text()
    const match = source.match(/staleTime:\s*([\d_]+)/)
    expect(match).not.toBeNull()
    const staleTime = Number(match![1]!.replace(/_/g, ""))
    expect(staleTime).toBeGreaterThanOrEqual(15_000)
    expect(staleTime).toBeLessThanOrEqual(30_000)
  })

  test("main.tsx sets a non-zero router defaultPreloadStaleTime", async () => {
    const source = await Bun.file(mainPath).text()
    const match = source.match(/defaultPreloadStaleTime:\s*([\d_]+)/)
    expect(match).not.toBeNull()
    const preloadStaleTime = Number(match![1]!.replace(/_/g, ""))
    expect(preloadStaleTime).toBeGreaterThan(0)
  })
})

describe("dashboard-performance: index route live polling preserved", () => {
  test("routes/index.tsx keeps refetchInterval: 5_000 on the requests query", async () => {
    const source = await Bun.file(indexRoutePath).text()
    expect(source).toContain("refetchInterval: 5_000")
  })
})
