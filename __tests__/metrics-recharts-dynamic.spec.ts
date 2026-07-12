import { test, expect, describe } from "bun:test"

// Structural/source-text assertions only — this repo's __tests__/ is DOM-free by
// convention (see dashboard-performance.spec.ts, which guards the analogous
// async shiki chunk boundary the same way). Recharts (~364 KB) must live in its
// own async chunk, not the synchronous /metrics route chunk.

const metricsRoutePath = new URL("../src/ui/src/routes/metrics.tsx", import.meta.url)
const metricsChartsPath = new URL(
  "../src/ui/src/components/metrics/metrics-charts.tsx",
  import.meta.url,
)

// A top-level `import … from "recharts"` (value OR type) on its own line.
const staticRecharts = /^\s*import\s+(type\s+)?[^;]*from\s+["']recharts["']\s*;?\s*$/m
// The shadcn chart wrapper statically re-exports recharts, so a static import of
// it would fold recharts back into whatever chunk imports it.
const staticChartWrapper =
  /^\s*import\s+(type\s+)?[^;]*from\s+["']@\/components\/ui\/chart["']\s*;?\s*$/m

describe("finding #7: Recharts is code-split out of the /metrics route chunk", () => {
  test("metrics.tsx has no static recharts import", async () => {
    const source = await Bun.file(metricsRoutePath).text()
    expect(staticRecharts.test(source)).toBe(false)
  })

  test("metrics.tsx does not statically import the recharts-bundling chart wrapper", async () => {
    const source = await Bun.file(metricsRoutePath).text()
    expect(staticChartWrapper.test(source)).toBe(false)
  })

  test("metrics.tsx lazy-loads the charts via a dynamic import behind a Suspense fallback", async () => {
    const source = await Bun.file(metricsRoutePath).text()
    expect(source).toMatch(/import\(\s*["'][^"']*metrics-charts["']\s*\)/)
    expect(source).toContain("Suspense")
    expect(source).toMatch(/fallback=/)
  })

  test("the split-out metrics-charts module is where recharts is imported and the charts render", async () => {
    const source = await Bun.file(metricsChartsPath).text()
    expect(staticRecharts.test(source)).toBe(true)
    expect(source).toContain("BarChart")
    expect(source).toContain("ChartContainer")
  })
})
