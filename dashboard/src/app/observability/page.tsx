"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadges } from "@/components/status-badges";
import { ThemeToggle } from "@/components/theme-toggle";
import { ExportMenu } from "@/components/export-menu";
import { EventsTable } from "@/components/events-table";
import { RequestsTable } from "@/components/requests-table";
import { SessionTimeline } from "@/components/session-timeline";
import { LiveStream } from "@/components/live-stream";
import { RequestsLine } from "@/components/charts/requests-line";
import { ErrorsByRoute } from "@/components/charts/errors-by-route";
import { DevicePie } from "@/components/charts/device-pie";
import { ClickHeatmap } from "@/components/charts/click-heatmap";
import { fetchMetrics, fetchLogs } from "@/lib/telemetry/client";
import type { Metrics } from "@/lib/telemetry/types";

const REFRESH_INTERVAL_MS = 10_000;

function parseBrowser(ua: string): string {
  if (!ua) return "Unknown";
  if (ua.includes("Chrome") && !ua.includes("Edg")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("Edg")) return "Edge";
  if (ua.includes("curl")) return "curl";
  return "Other";
}

export default function ObservabilityPage() {
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [metricsLoading, setMetricsLoading] = React.useState(true);
  const [clickPoints, setClickPoints] = React.useState<Array<{ x: number; y: number }>>([]);
  const [deviceData, setDeviceData] = React.useState<Array<{ name: string; value: number }>>([]);

  const loadMetrics = React.useCallback(async () => {
    try {
      const m = await fetchMetrics("1h");
      setMetrics(m);
    } catch {
      // silently ignore
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  const loadClicksAndDevices = React.useCallback(async () => {
    try {
      const resp = await fetchLogs({ event: "ui.click", limit: 500, order: "desc" });
      const pts = resp.events
        .map((e) => {
          const p = e.payload as Record<string, unknown> | undefined;
          if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
          return { x: p.x as number, y: p.y as number };
        })
        .filter((p): p is { x: number; y: number } => p !== null);
      setClickPoints(pts);

      // Device/browser breakdown from user_agent
      const allLogs = await fetchLogs({ limit: 500, order: "desc" });
      const browserCount: Record<string, number> = {};
      for (const ev of allLogs.events) {
        if (ev.user_agent) {
          const browser = parseBrowser(ev.user_agent);
          browserCount[browser] = (browserCount[browser] ?? 0) + 1;
        }
      }
      const deviceArr = Object.entries(browserCount)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6);
      setDeviceData(deviceArr);
    } catch {
      // silently ignore
    }
  }, []);

  React.useEffect(() => {
    void loadMetrics();
    void loadClicksAndDevices();
    const timer = setInterval(() => {
      void loadMetrics();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadMetrics, loadClicksAndDevices]);

  // Build requests-over-time from metrics
  const requestsOverTime = React.useMemo(() => {
    if (!metrics?.requests_over_time?.length) {
      // Synthetic fallback: show requests_by_status as single-point
      const total = Object.values(metrics?.requests_by_status ?? {}).reduce(
        (a: number, b: unknown) => a + (typeof b === "number" ? b : 0),
        0
      );
      return [{ time: "now", count: total }];
    }
    return metrics.requests_over_time;
  }, [metrics]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Observability</h1>
            <p className="text-sm text-muted-foreground">
              claude-plan-api telemetry dashboard
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <ExportMenu />
          </div>
        </div>

        {/* Status badges */}
        <StatusBadges metrics={metrics} loading={metricsLoading} />

        {/* Tabs */}
        <Tabs defaultValue="overview" className="flex flex-col gap-4">
          <TabsList className="w-fit">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="requests">Requests</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="live">Live</TabsTrigger>
          </TabsList>

          {/* Overview tab */}
          <TabsContent value="overview" className="mt-0">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <RequestsLine data={requestsOverTime} />
              <ErrorsByRoute
                data={
                  Array.isArray(metrics?.errors_by_route)
                    ? (metrics.errors_by_route as Array<{ route: string; count: number }>)
                    : metrics?.errors_by_route && typeof metrics.errors_by_route === "object"
                    ? Object.entries(metrics.errors_by_route as Record<string, unknown>).map(
                        ([route, count]) => ({ route, count: typeof count === "number" ? count : 0 })
                      )
                    : []
                }
              />
              <DevicePie data={deviceData} />
              <ClickHeatmap points={clickPoints} />
            </div>
          </TabsContent>

          {/* Logs tab */}
          <TabsContent value="logs" className="mt-0">
            <EventsTable />
          </TabsContent>

          {/* Requests tab */}
          <TabsContent value="requests" className="mt-0">
            <RequestsTable />
          </TabsContent>

          {/* Sessions tab */}
          <TabsContent value="sessions" className="mt-0">
            <SessionTimeline />
          </TabsContent>

          {/* Live tab */}
          <TabsContent value="live" className="mt-0">
            <LiveStream />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
