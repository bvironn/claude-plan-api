import {
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  GaugeIcon,
  HashIcon,
  ZapIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { CopyButton } from "@/components/layout/copy-button"
import type { RequestRecord } from "@/lib/types"
import {
  formatDuration,
  formatTokens,
  prettyJson,
  truncate,
} from "@/lib/format"
import { parseOrNull } from "@/lib/format"
import type { AnthropicRequestBody } from "@/lib/types"

export function TechnicalPanel({ request }: { request: RequestRecord }) {
  const upstream = parseOrNull<AnthropicRequestBody>(request.upstreamRequestBody)
  const thinking = upstream?.thinking
  const effort = upstream?.output_config?.effort
  const ctxMgmt = upstream?.context_management

  return (
    <div className="flex flex-col gap-4">
      {/* Metadata card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <GaugeIcon data-icon="inline-start" />
            Request metadata
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <MetaRow icon={<CpuIcon className="size-4" />} label="Model">
            <span className="font-mono text-xs">{request.model ?? "—"}</span>
          </MetaRow>

          <MetaRow icon={<ZapIcon className="size-4" />} label="Mode">
            <div className="flex flex-wrap gap-1">
              {request.isStream ? (
                <Badge variant="secondary">streaming</Badge>
              ) : (
                <Badge variant="outline">blocking</Badge>
              )}
              {thinking?.type && (
                <Badge variant="secondary">
                  thinking: {thinking.type}
                </Badge>
              )}
              {effort && (
                <Badge variant="secondary">effort: {effort}</Badge>
              )}
              {ctxMgmt && (
                <Badge variant="outline">context-management</Badge>
              )}
            </div>
          </MetaRow>

          <MetaRow icon={<ClockIcon className="size-4" />} label="Duration">
            <span className="font-mono text-xs">
              {formatDuration(request.duration)}
            </span>
          </MetaRow>

          <MetaRow icon={<CoinsIcon className="size-4" />} label="Tokens">
            <TokenBreakdown record={request} />
          </MetaRow>

          <MetaRow icon={<HashIcon className="size-4" />} label="Trace">
            <div className="flex items-center gap-1">
              <span className="font-mono text-xs break-all">
                {truncate(request.traceId, 20)}
              </span>
              <CopyButton value={request.traceId} label="Copy trace id" />
            </div>
          </MetaRow>
        </CardContent>
      </Card>

      {/* Raw JSON tabs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Raw bodies</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="upstream" className="w-full">
            <TabsList>
              <TabsTrigger value="client">Client</TabsTrigger>
              <TabsTrigger value="upstream">Upstream</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
            </TabsList>
            <TabsContent value="client" className="mt-2">
              <JsonBlock content={request.requestBody} />
            </TabsContent>
            <TabsContent value="upstream" className="mt-2">
              <JsonBlock content={request.upstreamRequestBody} />
            </TabsContent>
            <TabsContent value="response" className="mt-2">
              <JsonBlock content={request.responseBody} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="text-muted-foreground flex w-24 shrink-0 items-center gap-2 text-xs">
        {icon}
        {label}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function TokenBreakdown({ record }: { record: RequestRecord }) {
  const hasAny =
    record.inputTokens != null ||
    record.outputTokens != null ||
    record.cacheReadTokens != null ||
    record.cacheCreationTokens != null

  if (!hasAny) {
    return <span className="text-muted-foreground text-xs">—</span>
  }

  return (
    <div className="flex flex-col gap-0.5 font-mono text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">input ↓</span>
        <span>{formatTokens(record.inputTokens)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">output ↑</span>
        <span>{formatTokens(record.outputTokens)}</span>
      </div>
      {record.cacheReadTokens != null && record.cacheReadTokens > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">cache read</span>
          <span>{formatTokens(record.cacheReadTokens)}</span>
        </div>
      )}
      {record.cacheCreationTokens != null && record.cacheCreationTokens > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">cache write</span>
          <span>{formatTokens(record.cacheCreationTokens)}</span>
        </div>
      )}
    </div>
  )
}

function JsonBlock({ content }: { content: string | null }) {
  if (!content) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs">
        Not recorded
      </div>
    )
  }
  const pretty = prettyJson(content)
  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <CopyButton value={pretty} label="Copy JSON" size="icon" />
      </div>
      <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 pr-12 text-xs">
        <code>{pretty}</code>
      </pre>
    </div>
  )
}
