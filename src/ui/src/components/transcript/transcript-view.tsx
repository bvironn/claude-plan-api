import { Fragment, useMemo } from "react"

import { MessageBubble } from "@/components/transcript/message-bubble"
import { ReasoningBlock } from "@/components/transcript/reasoning-block"
import { SystemBlocks } from "@/components/transcript/system-blocks"
import type { AnthropicRequestBody, RequestRecord } from "@/lib/types"
import { parseOrNull } from "@/lib/format"
import { resolveTranscriptMessages, type TurnDedup } from "@/lib/session-turns"
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
 *
 * `dedup` (optional) — when the leading `sharedCount` messages of this turn
 * already rendered in an earlier turn, they collapse into ONE static marker and
 * only the new suffix renders. Omitted or `{kind:"full"}` → render every message
 * (backward-compatible for `r.$traceId.tsx` and other single-turn callers).
 */
export function TranscriptView({
  record,
  dedup,
}: {
  record: RequestRecord
  dedup?: TurnDedup
}) {
  const { systemBlocks, messages, responseMessage, reasoningText, reasoningDetails } = useMemo(() => {
    const upstream = parseOrNull<AnthropicRequestBody>(record.upstreamRequestBody)
    // parseResponseBody handles BOTH shapes: JSON (non-streaming) and raw
    // Anthropic SSE bytes (streaming). The gateway stores whatever came off
    // the upstream socket, so streaming requests have event/data framing.
    const response = parseResponseBody(record.responseBody)

    // System — prefer upstream (has the final shape), else empty
    const systemBlocks = (upstream?.system ?? []) as Array<{
      type?: string
      text?: string
    } & Record<string, unknown>>

    // Messages — resolved via the SAME shared helper `computeMessageDedup` uses,
    // so the diff and the render can never drift (design: shared resolver).
    const messages = resolveTranscriptMessages(record)

    // Response
    const responseMessage = response?.choices?.[0]?.message
    const reasoningText = (responseMessage?.reasoning_content as string | undefined) ?? undefined
    const reasoningDetails = responseMessage?.reasoning_details as
      | Array<Record<string, unknown>>
      | undefined

    return { systemBlocks, messages, responseMessage, reasoningText, reasoningDetails }
  }, [record])

  // Render dedup: when this turn's leading `sharedCount` messages already
  // appeared verbatim in the origin turn, collapse them into ONE static,
  // non-interactive marker and render only the new suffix. Any other verdict
  // (`full`/`undefined`) renders every message unchanged (backward-compatible).
  const isDeduped = dedup?.kind === "deduped"
  const sharedCount = isDeduped ? dedup.sharedCount : 0
  const visibleMessages = isDeduped ? messages.slice(sharedCount) : messages

  return (
    <div className="flex flex-col gap-4">
      {systemBlocks.length > 0 && <SystemBlocks blocks={systemBlocks} />}

      {isDeduped && (
        <p className="text-muted-foreground text-xs italic">
          {sharedCount} earlier message{sharedCount === 1 ? "" : "s"} already shown in Turn{" "}
          {dedup.originTurnIndex + 1}
        </p>
      )}

      {visibleMessages.map((msg, i) => (
        <Fragment key={i}>
          <MessageBubble role={msg.role as "user" | "assistant"} content={msg.content} />
        </Fragment>
      ))}

      {/* Render the reasoning block whenever upstream produced ANY thinking
          artifact — even an empty shell block with just a signature. The
          operator explicitly asked us NOT to hide this: a zero-char shell
          is signal in itself (the model opened a thinking block, then chose
          not to fill it, or the upstream stripped plaintext). Hiding that
          would mask the behaviour from audit. */}
      {(reasoningText !== undefined || (reasoningDetails && reasoningDetails.length > 0)) && (
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
