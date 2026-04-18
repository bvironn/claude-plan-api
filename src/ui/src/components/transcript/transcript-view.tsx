import { Fragment, useMemo } from "react"

import { MessageBubble } from "@/components/transcript/message-bubble"
import { ReasoningBlock } from "@/components/transcript/reasoning-block"
import { SystemBlocks } from "@/components/transcript/system-blocks"
import type {
  AnthropicRequestBody,
  OpenAIChatRequestBody,
  RequestRecord,
} from "@/lib/types"
import { parseOrNull } from "@/lib/format"
import { parseResponseBody } from "@/lib/sse-parser"

/**
 * Transcript view — renders a full `POST /v1/chat/completions` cycle as a
 * chat-like sequence. Composition:
 *
 *   1. System blocks (from upstream.system[])   — collapsed at top
 *   2. Message history (from client requestBody.messages or upstream.messages)
 *   3. Reasoning block (if response has reasoning_content)
 *   4. Assistant final message (from responseBody.choices[0].message)
 *
 * Data source precedence:
 *   - System blocks: upstreamRequestBody (what actually went to Anthropic;
 *     includes billing header + identity that the client never sent).
 *   - Messages: upstreamRequestBody.messages (same reason — normalised shape
 *     with the client's forwarded prompt as a prefix on the first user msg).
 *   - Response: responseBody (OpenAI shape, since the client sees this).
 */
/**
 * Returns true iff either (a) reasoning text is non-empty, or (b) at least
 * one reasoning detail has real content (thinking string or redacted data).
 * Filters out the "empty shell" case upstream sometimes emits.
 */
function hasReasoningContent(
  text: string | undefined,
  details: Array<Record<string, unknown>> | undefined,
): boolean {
  if (text && text.trim().length > 0) return true
  if (!details || details.length === 0) return false
  for (const d of details) {
    const thinking = d.thinking
    if (typeof thinking === "string" && thinking.length > 0) return true
    const data = d.data
    if (typeof data === "string" && data.length > 0) return true
  }
  return false
}

export function TranscriptView({ record }: { record: RequestRecord }) {
  const { systemBlocks, messages, responseMessage, reasoningText, reasoningDetails } = useMemo(() => {
    const upstream = parseOrNull<AnthropicRequestBody>(record.upstreamRequestBody)
    const clientReq = parseOrNull<OpenAIChatRequestBody>(record.requestBody)
    // parseResponseBody handles BOTH shapes: JSON (non-streaming) and raw
    // Anthropic SSE bytes (streaming). The gateway stores whatever came off
    // the upstream socket, so streaming requests have event/data framing.
    const response = parseResponseBody(record.responseBody)

    // System — prefer upstream (has the final shape), else empty
    const systemBlocks = (upstream?.system ?? []) as Array<{
      type?: string
      text?: string
    } & Record<string, unknown>>

    // Messages — prefer upstream normalised shape, else fall back to client input
    const messages =
      upstream?.messages ??
      (clientReq?.messages?.filter((m) => m.role !== "system") as
        | AnthropicRequestBody["messages"]
        | undefined) ??
      []

    // Response
    const responseMessage = response?.choices?.[0]?.message
    const reasoningText = (responseMessage?.reasoning_content as string | undefined) ?? undefined
    const reasoningDetails = responseMessage?.reasoning_details as
      | Array<Record<string, unknown>>
      | undefined

    return { systemBlocks, messages, responseMessage, reasoningText, reasoningDetails }
  }, [record])

  return (
    <div className="flex flex-col gap-4">
      {systemBlocks.length > 0 && <SystemBlocks blocks={systemBlocks} />}

      {messages.map((msg, i) => (
        <Fragment key={i}>
          <MessageBubble role={msg.role as "user" | "assistant"} content={msg.content} />
        </Fragment>
      ))}

      {/* Only render the reasoning block if it actually carries signal:
          non-empty text OR any raw block with real content (thinking string
          OR redacted_thinking data). Upstream adaptive-thinking often emits
          a zero-length shell block + signature when it decides not to think —
          rendering that shows the operator "Reasoning (0 chars)" which is
          noise. */}
      {hasReasoningContent(reasoningText, reasoningDetails) && (
        <ReasoningBlock text={reasoningText ?? ""} details={reasoningDetails} />
      )}

      {responseMessage && (
        <MessageBubble
          role="assistant"
          content={responseMessage.content}
          toolCalls={responseMessage.tool_calls}
        />
      )}
    </div>
  )
}
