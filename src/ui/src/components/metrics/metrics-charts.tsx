import { useMemo } from "react"
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts"

import type { Metrics } from "@/lib/types"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

// ---------------------------------------------------------------------------
// Recharts-backed charts for the /metrics page.
//
// These are split into their own module so the entire recharts dependency
// (~364 KB — including the shadcn chart wrapper in `@/components/ui/chart`,
// which statically re-exports recharts) is pulled in through the single lazy
// `import()` in metrics.tsx. That keeps recharts OUT of the synchronous
// /metrics route chunk; it downloads only once the metrics view actually
// renders, behind a Suspense fallback.
// ---------------------------------------------------------------------------

const statusChartConfig: ChartConfig = {
  count: { label: "Requests", color: "var(--chart-1)" },
}

function StatusBreakdownChart({ counts }: { counts: Record<number, number> }) {
  const data = useMemo(() => {
    const entries = Object.entries(counts).map(([status, count]) => ({
      status: `${status}`,
      count,
    }))
    entries.sort((a, b) => a.status.localeCompare(b.status))
    return entries
  }, [counts])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Requests by status</CardTitle>
        <CardDescription>HTTP status codes aggregated in the window</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">No data</div>
        ) : (
          <ChartContainer config={statusChartConfig} className="h-[200px] w-full">
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="status" tickLine={false} axisLine={false} />
              <YAxis width={40} tickLine={false} axisLine={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

const errorsChartConfig: ChartConfig = {
  count: { label: "Errors", color: "var(--chart-5)" },
}

function ErrorsByRouteChart({ counts }: { counts: Record<string, number> }) {
  const data = useMemo(() => {
    return Object.entries(counts).map(([route, count]) => ({ route, count }))
  }, [counts])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">5xx errors by route</CardTitle>
        <CardDescription>Paths that returned server errors in the window</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            No server errors in the window
          </div>
        ) : (
          <ChartContainer config={errorsChartConfig} className="h-[200px] w-full">
            <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="route" width={120} tickLine={false} axisLine={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

/** The two /metrics charts, rendered as one grid. Default export so metrics.tsx
 *  can pull the whole recharts bundle through a single `React.lazy(import())`. */
export default function MetricsCharts({ data }: { data: Metrics }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <StatusBreakdownChart counts={data.requests_by_status} />
      <ErrorsByRouteChart counts={data.errors_by_route} />
    </div>
  )
}
