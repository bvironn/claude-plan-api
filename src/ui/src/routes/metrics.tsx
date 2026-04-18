import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  BarChart3Icon,
  ClockIcon,
  CoinsIcon,
  GaugeIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  TrendingUpIcon,
  XCircleIcon,
} from "lucide-react"
import { useState, useMemo } from "react"
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts"

import { getMetrics } from "@/lib/api"
import { formatDuration, formatTokens } from "@/lib/format"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

type WindowKey = "1m" | "5m" | "1h" | "24h"

const WINDOW_MS: Record<WindowKey, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
}

type MetricsSearch = { window?: WindowKey; paused?: boolean }

export const Route = createFileRoute("/metrics")({
  component: MetricsPage,
  validateSearch: (search): MetricsSearch => {
    const w = typeof search.window === "string" ? search.window : undefined
    const window = w === "1m" || w === "5m" || w === "1h" || w === "24h" ? w : undefined
    const paused = search.paused === true || search.paused === "true" ? true : undefined
    return { window, paused }
  },
})

function MetricsPage() {
  const search = Route.useSearch()
  const currentWindow = search.window ?? "5m"
  const windowMs = WINDOW_MS[currentWindow]

  const [autoRefresh, setAutoRefresh] = useState(!search.paused)

  const query = useQuery({
    queryKey: ["metrics", windowMs],
    queryFn: () => getMetrics(windowMs),
    refetchInterval: autoRefresh ? 10_000 : false,
    staleTime: 5_000,
  })

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BarChart3Icon data-icon="inline-start" />
            Metrics
          </h1>
          <p className="text-muted-foreground text-sm">
            Aggregated over the last{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{currentWindow}</code>.
            {autoRefresh ? " Auto-refresh every 10 s." : " Auto-refresh paused."}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={currentWindow}
            onValueChange={(v) => {
              if (v === "1m" || v === "5m" || v === "1h" || v === "24h") {
                window.history.replaceState(
                  null,
                  "",
                  `?window=${v}${search.paused ? "&paused=true" : ""}`,
                )
                // The TanStack Router typed search won't auto-update from
                // replaceState; force refetch via state swap.
                location.reload()
              }
            }}
          >
            <ToggleGroupItem value="1m" className="font-mono text-xs">1m</ToggleGroupItem>
            <ToggleGroupItem value="5m" className="font-mono text-xs">5m</ToggleGroupItem>
            <ToggleGroupItem value="1h" className="font-mono text-xs">1h</ToggleGroupItem>
            <ToggleGroupItem value="24h" className="font-mono text-xs">24h</ToggleGroupItem>
          </ToggleGroup>

          <Button
            variant={autoRefresh ? "outline" : "default"}
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? (
              <>
                <PauseIcon data-icon="inline-start" />
                Pause
              </>
            ) : (
              <>
                <PlayIcon data-icon="inline-start" />
                Resume
              </>
            )}
          </Button>

          <Button variant="ghost" size="sm" onClick={() => query.refetch()}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </header>

      {query.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load metrics</AlertTitle>
          <AlertDescription>{(query.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {query.isPending ? (
        <MetricsSkeleton />
      ) : query.data ? (
        <MetricsView data={query.data} />
      ) : null}
    </div>
  )
}

function MetricsView({ data }: { data: import("@/lib/types").Metrics }) {
  const empty = data.requests_total === 0

  return (
    <>
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={<TrendingUpIcon className="size-4" />}
          label="Requests"
          value={data.requests_total.toLocaleString()}
          sub={`${data.events_per_min}/min events`}
        />
        <StatCard
          icon={<ClockIcon className="size-4" />}
          label="p50 latency"
          value={formatDuration(data.latency_p50)}
          sub={`p95 ${formatDuration(data.latency_p95)}`}
        />
        <StatCard
          icon={<GaugeIcon className="size-4" />}
          label="p99 latency"
          value={formatDuration(data.latency_p99)}
        />
        <StatCard
          icon={<CoinsIcon className="size-4" />}
          label="Tokens ↓"
          value={formatTokens(data.tokens_in)}
          sub={`↑ ${formatTokens(data.tokens_out)}`}
        />
        <StatCard
          icon={<XCircleIcon className="size-4" />}
          label="Errors"
          value={data.active_errors.toLocaleString()}
          sub={empty ? "no traffic in window" : undefined}
          tone={data.active_errors > 0 ? "destructive" : "default"}
        />
      </div>

      {/* Status breakdown + errors by route */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StatusBreakdownChart counts={data.requests_by_status} />
        <ErrorsByRouteChart counts={data.errors_by_route} />
      </div>

      {/* Tokens breakdown */}
      <TokenBreakdownCard data={data} />

      {empty && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3Icon />
            </EmptyMedia>
            <EmptyTitle>No traffic in the selected window</EmptyTitle>
            <EmptyDescription>
              Trigger requests or widen the window.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  tone?: "default" | "destructive"
}) {
  return (
    <Card className={tone === "destructive" ? "border-destructive/50" : undefined}>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5 text-xs">
          {icon}
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-0.5">
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
      </CardContent>
    </Card>
  )
}

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

function TokenBreakdownCard({ data }: { data: import("@/lib/types").Metrics }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Tokens breakdown</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <TokenStat label="Input" value={data.tokens_in} />
        <TokenStat label="Output" value={data.tokens_out} />
        <TokenStat label="Cache read" value={data.cache_read_tokens} />
        <TokenStat label="Cache write" value={data.cache_creation_tokens} />
      </CardContent>
    </Card>
  )
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-lg font-medium">{formatTokens(value)}</span>
      <Badge variant="outline" className="w-fit font-mono text-[10px]">
        {value.toLocaleString()} tokens
      </Badge>
    </div>
  )
}

function MetricsSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-[260px] w-full" />
        <Skeleton className="h-[260px] w-full" />
      </div>
      <Skeleton className="h-28 w-full" />
    </>
  )
}
