import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  KeyRoundIcon,
  ListIcon,
  MessagesSquareIcon,
} from "lucide-react"

import { listApiKeys, listRequests } from "@/lib/api"
import { deriveKeyMetrics, findApiKeyById } from "@/lib/keys-metrics"
import { formatRelativeTime, formatTokens } from "@/lib/format"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { RouteError } from "@/components/layout/route-error"

export const Route = createFileRoute("/keys/$keyId")({
  component: KeyDetailPage,
  errorComponent: RouteError,
})

function KeyDetailPage() {
  const { keyId } = Route.useParams()

  // Key metadata comes from the keys list (includes revoked keys). We resolve
  // the single key client-side; a missing match is the not-found state.
  const keysQuery = useQuery({
    queryKey: ["keys"],
    queryFn: listApiKeys,
  })

  // Scoped requests for THIS key drive every derived metric. The `apiKeyId`
  // filter is delivered by the key-usage-filter change (PR #22). We cap at 500
  // rows, matching the Sessions view's existing pattern.
  const numericId = Number(keyId)
  const requestsQuery = useQuery({
    queryKey: ["requests", "by-key", keyId],
    queryFn: () =>
      listRequests({ apiKeyId: numericId, limit: 500, order: "desc" }),
    enabled: Number.isInteger(numericId) && numericId >= 0,
  })

  const apiKey = useMemo(
    () => findApiKeyById(keysQuery.data?.keys ?? [], keyId),
    [keysQuery.data, keyId],
  )

  const metrics = useMemo(
    () => deriveKeyMetrics(requestsQuery.data?.requests ?? []),
    [requestsQuery.data],
  )

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      {/* Back + header strip */}
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/keys">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to keys
          </Link>
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <KeyRoundIcon className="text-muted-foreground size-4" />
        <h1 className="truncate text-lg font-semibold tracking-tight">
          Key detail
        </h1>
      </div>

      {keysQuery.isPending ? (
        <KeyDetailSkeleton />
      ) : keysQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load key</AlertTitle>
          <AlertDescription>
            {(keysQuery.error as Error).message}
          </AlertDescription>
        </Alert>
      ) : apiKey == null ? (
        <KeyNotFound keyId={keyId} />
      ) : (
        <>
          <MetadataCard
            prefix={apiKey.prefix}
            label={apiKey.label}
            revoked={apiKey.revoked_at != null}
            isAdmin={apiKey.is_admin === 1}
            createdAt={apiKey.created_at}
          />

          <DeepLinks keyId={apiKey.id} />

          {requestsQuery.isError ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Couldn't load usage</AlertTitle>
              <AlertDescription>
                {(requestsQuery.error as Error).message}
              </AlertDescription>
            </Alert>
          ) : requestsQuery.isPending ? (
            <MetricsSkeleton />
          ) : metrics.requestCount === 0 ? (
            <ZeroUsage />
          ) : (
            <>
              <MetricsCards metrics={metrics} />
              <PerModelTable metrics={metrics} />
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function MetadataCard({
  prefix,
  label,
  revoked,
  isAdmin,
  createdAt,
}: {
  prefix: string
  label: string
  revoked: boolean
  isAdmin: boolean
  createdAt: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono text-base">
          {prefix}
          {isAdmin && <Badge className="font-normal">Admin</Badge>}
          {revoked ? (
            <Badge variant="destructive" className="font-normal">
              Revoked
            </Badge>
          ) : (
            <Badge variant="secondary" className="font-normal">
              Active
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">
        Created {formatRelativeTime(createdAt)}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Deep-links to pre-filtered Requests / Sessions
// ---------------------------------------------------------------------------

function DeepLinks({ keyId }: { keyId: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link to="/" search={{ apiKeyId: keyId }}>
          <ListIcon data-icon="inline-start" />
          View requests
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link to="/sessions" search={{ apiKeyId: keyId }}>
          <MessagesSquareIcon data-icon="inline-start" />
          View sessions
        </Link>
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

function MetricsCards({
  metrics,
}: {
  metrics: ReturnType<typeof deriveKeyMetrics>
}) {
  const errorPct = `${(metrics.errorRate * 100).toFixed(1)}%`
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Requests" value={String(metrics.requestCount)} />
      <Stat label="Tokens in" value={formatTokens(metrics.tokensIn)} />
      <Stat label="Tokens out" value={formatTokens(metrics.tokensOut)} />
      <Stat label="Cache read" value={formatTokens(metrics.cacheReadTokens)} />
      <Stat
        label="Cache creation"
        value={formatTokens(metrics.cacheCreationTokens)}
      />
      <Stat label="Error rate" value={errorPct} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="font-mono text-lg font-semibold">{value}</span>
      </CardContent>
    </Card>
  )
}

function PerModelTable({
  metrics,
}: {
  metrics: ReturnType<typeof deriveKeyMetrics>
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold tracking-tight">
        Per-model breakdown
      </h2>
      <div className="border-border overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="w-[110px] text-right">Requests</TableHead>
              <TableHead className="w-[120px] text-right">Tokens in</TableHead>
              <TableHead className="w-[120px] text-right">Tokens out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {metrics.perModel.map((m) => (
              <TableRow key={m.model}>
                <TableCell className="font-mono text-xs">{m.model}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {m.count}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {formatTokens(m.tokensIn)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {formatTokens(m.tokensOut)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty / not-found / loading states
// ---------------------------------------------------------------------------

function ZeroUsage() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListIcon />
        </EmptyMedia>
        <EmptyTitle>No attributed requests yet</EmptyTitle>
        <EmptyDescription>
          This key hasn't made any recorded requests. Usage metrics will appear
          here once it does.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function KeyNotFound({ keyId }: { keyId: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Key not found</EmptyTitle>
          <EmptyDescription>
            No API key matches{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
              {keyId}
            </code>
            . It may have been deleted, or the link is wrong.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}

function KeyDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-28 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-36" />
      </div>
      <MetricsSkeleton />
    </div>
  )
}

function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  )
}
