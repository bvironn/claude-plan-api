"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, AlertTriangle, Clock, Coins } from "lucide-react";
import type { Metrics } from "@/lib/telemetry/types";

interface StatusBadgesProps {
  metrics: Metrics | null;
  loading?: boolean;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  variant,
  loading,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  variant?: "default" | "error" | "warn";
  loading?: boolean;
}) {
  const colorMap = {
    default: "text-foreground",
    error: "text-destructive",
    warn: "text-yellow-500",
  };

  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-3 px-4">
        <Icon className={`h-5 w-5 ${colorMap[variant ?? "default"]}`} />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-5 w-16 mt-1" />
          ) : (
            <p className={`text-lg font-semibold leading-tight ${colorMap[variant ?? "default"]}`}>
              {value}
            </p>
          )}
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export function StatusBadges({ metrics, loading }: StatusBadgesProps) {
  const eventsPerMin = React.useMemo(() => {
    if (!metrics) return "—";
    if (metrics.events_per_min !== undefined) return metrics.events_per_min.toFixed(1);
    // Fallback: estimate from latency count
    const count = metrics.latency?.count ?? 0;
    return ((count / 60) * 1).toFixed(1);
  }, [metrics]);

  const activeErrors = metrics?.active_errors ?? metrics?.errors?.count ?? 0;
  const p95Raw = metrics?.latency_p95 ?? metrics?.latency?.p95;
  const p95 = p95Raw !== undefined ? `${Math.round(p95Raw)}ms` : "—";
  const tokensTotal =
    (metrics?.tokens_in ?? 0) +
    (metrics?.tokens_out ?? 0) +
    (metrics?.tokens?.total ?? 0);
  const tokens = metrics
    ? tokensTotal >= 1000
      ? `${(tokensTotal / 1000).toFixed(1)}k`
      : String(tokensTotal)
    : "—";
  const p95ForVariant = p95Raw ?? 0;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        icon={Activity}
        label="Events/min"
        value={loading ? "—" : eventsPerMin}
        loading={loading}
      />
      <StatCard
        icon={AlertTriangle}
        label="Active errors"
        value={loading ? "—" : String(activeErrors)}
        variant={activeErrors > 0 ? "error" : "default"}
        loading={loading}
      />
      <StatCard
        icon={Clock}
        label="p95 latency"
        value={loading ? "—" : p95}
        variant={
          p95ForVariant > 2000
            ? "error"
            : p95ForVariant > 1000
            ? "warn"
            : "default"
        }
        loading={loading}
      />
      <StatCard
        icon={Coins}
        label="Tokens"
        value={loading ? "—" : tokens}
        sub={
          metrics
            ? `in: ${metrics.tokens_in ?? metrics.tokens?.input ?? 0} / out: ${metrics.tokens_out ?? metrics.tokens?.output ?? 0}`
            : undefined
        }
        loading={loading}
      />
    </div>
  );
}
