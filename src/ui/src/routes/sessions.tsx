import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  ClockIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
} from "lucide-react"
import { useMemo } from "react"

import { listApiKeys, listRequests } from "@/lib/api"
import { groupIntoConversations, sortConversations, type ConversationSort } from "@/lib/sessions"
import { formatRelativeTime, formatTokens, truncate } from "@/lib/format"
import { dayEndUtcIso, dayStartUtcIso } from "@/lib/date-range"

import { ApiKeySelect } from "@/components/layout/api-key-select"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ModelBadge } from "@/components/layout/status-badge"
import { RouteError } from "@/components/layout/route-error"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

// Typed search params from URL — mirrors the Requests route so `/keys/$keyId`
// can deep-link here with `?apiKeyId=<id>` and pre-filter the session list.
type SessionsSearch = {
  apiKeyId?: number
  model?: string
  from?: string
  to?: string
  sort?: ConversationSort
}

// `from`/`to` must be a bare `YYYY-MM-DD` — anything else (malformed, empty,
// wrong shape) degrades to `undefined` rather than being passed through. An
// unvalidated string like `?from=abc` would otherwise flow straight into
// `listRequests` and silently produce a query that returns zero rows forever
// (indistinguishable from a legitimate empty result) instead of just being
// dropped.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function parseDateOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) return undefined

  // The regex only checks shape (`\d{4}-\d{2}-\d{2}`); it happily matches
  // calendar-invalid dates like `2026-02-30` or `2026-13-01`. Those then
  // silently roll over through `Date.UTC` (`2026-02-30` -> `2026-03-02`)
  // instead of being rejected, so the query would run against the WRONG day
  // rather than being dropped — defeating the point of validating at this
  // trust boundary. Round-trip through `Date.UTC` and reject anything that
  // doesn't come back exactly as parsed (standard rollover-detection idiom).
  const [year, month, day] = value.split("-").map(Number)
  const roundTrip = new Date(Date.UTC(year, month - 1, day))
  const isValidCalendarDate =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day

  return isValidCalendarDate ? value : undefined
}

export const Route = createFileRoute("/sessions")({
  component: SessionsPage,
  errorComponent: RouteError,
  validateSearch: (search): SessionsSearch => {
    const raw = Number(search.apiKeyId)
    const apiKeyId = Number.isInteger(raw) && raw >= 0 ? raw : undefined
    const model = typeof search.model === "string" && search.model.length > 0 ? search.model : undefined
    const from = parseDateOnly(search.from)
    const to = parseDateOnly(search.to)
    const sort = search.sort === "tokens" ? "tokens" : search.sort === "recent" ? "recent" : undefined
    return { apiKeyId, model, from, to, sort }
  },
})

function SessionsPage() {
  // Filters live in the URL (`?apiKeyId=&model=&from=&to=&sort=`) so they are
  // shareable and deep-linkable from `/keys/$keyId`. They're part of the query
  // key so changing any of them triggers a re-fetch; the filtered request set
  // feeds `groupIntoConversations` then `sortConversations`.
  const { apiKeyId, model, from, to, sort = "recent" } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  function updateSearch(next: Partial<SessionsSearch>) {
    void navigate({
      search: () => ({ apiKeyId, model, from, to, sort, ...next }),
      replace: true,
    })
  }

  const query = useQuery({
    queryKey: [
      "requests",
      "all-chat-completions",
      apiKeyId ?? "all",
      model ?? "all",
      from ?? "any",
      to ?? "any",
    ],
    queryFn: () =>
      listRequests({
        path: "/v1/chat/completions",
        apiKeyId,
        model,
        from: from ? dayStartUtcIso(from) : undefined,
        to: to ? dayEndUtcIso(to) : undefined,
        limit: 500,
        order: "desc",
      }),
    refetchInterval: 10_000,
  })

  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => listApiKeys(),
  })
  const apiKeys = keysQuery.data?.keys ?? []

  // Collect distinct models seen in the current result set for the filter
  // chips — mirrors `IndexPage`'s `knownModels` in routes/index.tsx, including
  // its known limitation: once a model is selected the chip list narrows to
  // just that model until it's cleared again.
  const knownModels = useMemo(() => {
    if (!query.data) return []
    const set = new Set<string>()
    for (const r of query.data.requests) if (r.model) set.add(r.model)
    return [...set].sort()
  }, [query.data])

  const conversations = useMemo(() => {
    if (!query.data) return []
    return sortConversations(groupIntoConversations(query.data.requests), sort)
  }, [query.data, sort])

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessagesSquareIcon data-icon="inline-start" />
          Sessions
        </h1>
        <p className="text-muted-foreground text-sm">
          Chat completions grouped into conversations by first user message.
          Consecutive turns within ~1 hour collapse into a single session — click
          to open the latest turn (contains the richest history).
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {apiKeys.length > 0 && (
          <ApiKeySelect
            apiKeys={apiKeys}
            value={apiKeyId}
            onChange={(next) => updateSearch({ apiKeyId: next })}
          />
        )}

        {knownModels.length > 0 && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={model ?? ""}
            onValueChange={(v) => updateSearch({ model: v === "" ? undefined : v })}
            aria-label="Model filter"
            className="flex-wrap"
          >
            {knownModels.map((m) => (
              <ToggleGroupItem key={m} value={m} className="font-mono text-xs">
                {m}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}

        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={from ?? ""}
            onChange={(e) => updateSearch({ from: e.target.value || undefined })}
            aria-label="From date"
            className="w-auto"
          />
          <span className="text-muted-foreground text-xs">to</span>
          <Input
            type="date"
            value={to ?? ""}
            onChange={(e) => updateSearch({ to: e.target.value || undefined })}
            aria-label="To date"
            className="w-auto"
          />
        </div>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={sort}
          onValueChange={(v) => {
            if (v === "recent" || v === "tokens") updateSearch({ sort: v })
          }}
          aria-label="Sort conversations"
        >
          <ToggleGroupItem value="recent">Most recent</ToggleGroupItem>
          <ToggleGroupItem value="tokens">Most tokens</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {query.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load sessions</AlertTitle>
          <AlertDescription>{(query.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {query.isPending ? (
        <SessionsSkeleton />
      ) : conversations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessagesSquareIcon />
            </EmptyMedia>
            <EmptyTitle>No conversations yet</EmptyTitle>
            <EmptyDescription>
              Send a chat completion and the first turn will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {conversations.map((c) => (
            <ConversationCard key={c.id} conv={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ConversationCard({ conv }: { conv: import("@/lib/sessions").Conversation }) {
  const durationMs = new Date(conv.lastActivityAt).getTime() - new Date(conv.startedAt).getTime()

  return (
    <Link
      to="/s/$sessionId"
      params={{ sessionId: conv.id }}
      className="block"
    >
      <Card className="hover:border-primary/60 h-full cursor-pointer transition-colors">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            <MessageSquareIcon className="text-muted-foreground inline size-4" /> {truncate(conv.preview, 120)}
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5 text-xs">
            <ClockIcon className="size-3" />
            {formatRelativeTime(conv.lastActivityAt)}
            {durationMs > 0 && (
              <span className="text-muted-foreground">· spans {formatDurationShort(durationMs)}</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-mono">
              {conv.turns} turn{conv.turns === 1 ? "" : "s"}
            </Badge>
            {conv.models.map((m) => (
              <ModelBadge key={m} model={m} />
            ))}
            {conv.hasError && (
              <Badge variant="destructive" className="font-normal">
                had errors
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex gap-3 text-xs">
            <span>
              <span className="font-mono">{formatTokens(conv.totalInputTokens)}</span> ↓
            </span>
            <span>
              <span className="font-mono">{formatTokens(conv.totalOutputTokens)}</span> ↑
            </span>
            <span className="text-muted-foreground/60 ml-auto font-mono">
              {conv.latestTraceId.slice(0, 8)}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function SessionsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-40 w-full" />
      ))}
    </div>
  )
}

/** Compact duration ("2h 14m", "34m", "12s"). */
function formatDurationShort(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}
