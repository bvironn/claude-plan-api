import { DownloadIcon, FileJsonIcon, FileTextIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { RequestByTraceResponse } from "@/lib/api"
import type {
  AnthropicRequestBody,
  OpenAIChatRequestBody,
  RequestRecord,
  TelemetryEvent,
} from "@/lib/types"
import { parseOrNull, prettyJson } from "@/lib/format"
import { parseResponseBody } from "@/lib/sse-parser"

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Export menu for `/r/:traceId`.
 *
 * Two formats:
 *   - JSON: a bundle of `{trace_id, request, upstream, response, events}`
 *     downloaded as `transcript-<traceId>.json`.
 *   - Markdown: a human-readable chat transcript produced by `toMarkdown`,
 *     downloaded as `transcript-<traceId>.md`. Headings per turn, fenced
 *     code blocks preserved.
 *
 * Both formats are produced client-side from the already-fetched record —
 * no extra backend round-trip.
 */
export function ExportMenu({
  record,
  events,
}: {
  record: RequestRecord
  events?: TelemetryEvent[]
}) {
  function doExportJson() {
    const bundle = {
      trace_id: record.traceId,
      request: parseOrNull(record.requestBody) ?? record.requestBody,
      upstream: parseOrNull(record.upstreamRequestBody) ?? record.upstreamRequestBody,
      response: parseOrNull(record.responseBody) ?? record.responseBody,
      events: events ?? [],
    }
    const body = JSON.stringify(bundle, null, 2)
    downloadBlob(body, `transcript-${record.traceId}.json`, "application/json")
    toast.success("Exported JSON bundle")
  }

  function doExportMarkdown() {
    const md = toMarkdown(record)
    downloadBlob(md, `transcript-${record.traceId}.md`, "text/markdown")
    toast.success("Exported Markdown transcript")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <DownloadIcon data-icon="inline-start" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={doExportJson}>
          <FileJsonIcon />
          <span>JSON bundle</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={doExportMarkdown}>
          <FileTextIcon />
          <span>Markdown transcript</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer revoke so Safari/Firefox have time to read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a `RequestRecord` as a chat-style markdown document.
 *
 * Shape:
 *   # Transcript {traceId}
 *   ... metadata block ...
 *
 *   ## System
 *   (each system block quoted)
 *
 *   ## User
 *   ...
 *
 *   ## Assistant
 *   ...
 *
 *   ## Tool call: Bash
 *   ```json
 *   { "command": "ls" }
 *   ```
 *
 * Code fences encountered inside content are preserved verbatim.
 */
export function toMarkdown(record: RequestRecord): string {
  const upstream = parseOrNull<AnthropicRequestBody>(record.upstreamRequestBody)
  const clientReq = parseOrNull<OpenAIChatRequestBody>(record.requestBody)
  const response = parseResponseBody(record.responseBody)

  const out: string[] = []

  out.push(`# Transcript \`${record.traceId}\``)
  out.push("")
  out.push(`- **Model**: ${record.model ?? "—"}`)
  out.push(`- **Timestamp**: ${record.timestamp}`)
  out.push(`- **Status**: ${record.status ?? "—"}`)
  out.push(`- **Duration**: ${record.duration ?? "—"} ms`)
  if (record.inputTokens != null || record.outputTokens != null) {
    out.push(
      `- **Tokens**: ${record.inputTokens ?? 0} in / ${record.outputTokens ?? 0} out`,
    )
  }
  out.push("")

  // System blocks (from upstream).
  const systemBlocks = upstream?.system ?? []
  if (systemBlocks.length > 0) {
    out.push("## System")
    out.push("")
    for (const block of systemBlocks) {
      const text = typeof block?.text === "string" ? block.text : JSON.stringify(block)
      out.push(blockquote(text))
      out.push("")
    }
  }

  // Messages (prefer upstream normalised shape, fall back to client messages).
  const messages =
    upstream?.messages ??
    (clientReq?.messages?.filter((m) => m.role !== "system") as
      | AnthropicRequestBody["messages"]
      | undefined) ??
    []

  for (const msg of messages) {
    const role = msg.role ?? "user"
    renderMessageMd(out, role, msg.content)
  }

  // Reasoning + final assistant response.
  const respMsg = response?.choices?.[0]?.message
  if (respMsg) {
    if (respMsg.reasoning_content && respMsg.reasoning_content.length > 0) {
      out.push("## Assistant · reasoning")
      out.push("")
      out.push(respMsg.reasoning_content)
      out.push("")
    }

    if (respMsg.content && respMsg.content.length > 0) {
      out.push("## Assistant")
      out.push("")
      out.push(respMsg.content)
      out.push("")
    }

    // OpenAI tool_calls → one section each.
    for (const tc of respMsg.tool_calls ?? []) {
      out.push(`## Tool call: \`${tc.function.name}\``)
      out.push("")
      let args = tc.function.arguments
      try {
        args = JSON.stringify(JSON.parse(args), null, 2)
      } catch {
        // leave as-is
      }
      out.push("```json")
      out.push(args)
      out.push("```")
      out.push("")
    }
  }

  return out.join("\n")
}

type AnthropicContentBlock = {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
  tool_use_id?: string
  [k: string]: unknown
}

/**
 * Append a single message (possibly multi-block) to the markdown buffer,
 * one heading per logical section (text / tool_use / tool_result / thinking).
 */
function renderMessageMd(
  out: string[],
  role: string,
  content: unknown,
) {
  const blocks = normaliseContent(content)
  const roleHeading = role.charAt(0).toUpperCase() + role.slice(1)

  // Simple string content → one heading + one block.
  if (blocks.length === 0) {
    out.push(`## ${roleHeading}`)
    out.push("")
    out.push("_(empty)_")
    out.push("")
    return
  }

  let textEmitted = false

  for (const block of blocks) {
    const type = block.type ?? "text"

    if (type === "text" || (type === undefined && typeof block.text === "string")) {
      if (!textEmitted) {
        out.push(`## ${roleHeading}`)
        out.push("")
        textEmitted = true
      }
      out.push(block.text ?? "")
      out.push("")
      continue
    }

    if (type === "thinking") {
      out.push(`## ${roleHeading} · thinking`)
      out.push("")
      out.push(block.thinking ?? "")
      out.push("")
      continue
    }

    if (type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool"
      out.push(`## ${roleHeading} · tool call: \`${name}\``)
      out.push("")
      out.push("```json")
      out.push(JSON.stringify(block.input ?? null, null, 2))
      out.push("```")
      out.push("")
      continue
    }

    if (type === "tool_result") {
      const toolId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : undefined
      const heading = toolId
        ? `## ${roleHeading} · tool result (\`${toolId}\`)`
        : `## ${roleHeading} · tool result`
      out.push(heading)
      out.push("")
      const inner = block.content
      if (typeof inner === "string") {
        out.push("```")
        out.push(inner)
        out.push("```")
      } else {
        out.push("```json")
        out.push(prettyJson(JSON.stringify(inner)))
        out.push("```")
      }
      out.push("")
      continue
    }

    // Unknown block — dump JSON so nothing is silently lost.
    out.push(`## ${roleHeading} · ${type}`)
    out.push("")
    out.push("```json")
    out.push(JSON.stringify(block, null, 2))
    out.push("```")
    out.push("")
  }
}

function normaliseContent(content: unknown): AnthropicContentBlock[] {
  if (content == null) return []
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }
  if (Array.isArray(content)) return content as AnthropicContentBlock[]
  return [{ type: "text", text: JSON.stringify(content, null, 2) }]
}

function blockquote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n")
}

// Re-export for the RequestByTraceResponse type dependency consumers.
export type { RequestByTraceResponse }
