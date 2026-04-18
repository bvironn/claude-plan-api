/**
 * Parse a raw Anthropic-style SSE stream into an OpenAI-shape response.
 *
 * Why: when `POST /v1/chat/completions` is streaming, the gateway stores the
 * UPSTREAM SSE bytes in `responseBody` (event + data framing, not JSON). The
 * transcript view needs a usable message shape, so we reconstruct one here.
 *
 * We reconstruct:
 *   - choices[0].message.content           ← concat of all text_delta
 *   - choices[0].message.reasoning_content ← concat of all thinking_delta
 *   - choices[0].message.reasoning_details ← one entry per thinking block (w/ signature)
 *   - choices[0].message.tool_calls        ← one entry per tool_use content block
 *   - usage.prompt_tokens / completion_tokens from message_start + message_delta
 *   - finish_reason from message_delta.delta.stop_reason
 */

import type { OpenAIChatResponseBody } from "./types"

// ---------------------------------------------------------------------------
// Line-based SSE parser
// ---------------------------------------------------------------------------

type SSEEvent = { event?: string; data?: string }

function splitSSE(raw: string): SSEEvent[] {
  const out: SSEEvent[] = []
  // SSE frames are separated by a blank line ("\n\n"). Within a frame each
  // line starts with `field: value`. We only need the `event` and `data`
  // fields; other fields are ignored.
  const frames = raw.split(/\r?\n\r?\n/)
  for (const frame of frames) {
    if (!frame.trim()) continue
    const ev: SSEEvent = {}
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        ev.event = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        // Multi-line data fields concatenate with "\n"; Anthropic never splits
        // a data frame across lines in practice but we stay spec-compliant.
        const next = line.slice(5).trim()
        ev.data = ev.data === undefined ? next : ev.data + "\n" + next
      }
    }
    if (ev.data !== undefined) out.push(ev)
  }
  return out
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

interface ActiveBlock {
  type: "text" | "thinking" | "redacted_thinking" | "tool_use"
  text: string
  thinking: string
  signature: string
  data: string
  toolName: string
  toolId: string
  toolInputRaw: string
}

function newBlock(type: ActiveBlock["type"]): ActiveBlock {
  return {
    type,
    text: "",
    thinking: "",
    signature: "",
    data: "",
    toolName: "",
    toolId: "",
    toolInputRaw: "",
  }
}

export function parseAnthropicSSEResponse(raw: string): OpenAIChatResponseBody | null {
  if (!raw || !raw.includes("event:")) return null

  const events = splitSSE(raw)
  if (events.length === 0) return null

  let messageId: string | undefined
  let model: string | undefined
  let finishReason: string | undefined

  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cacheReadTokens: number | undefined
  let cacheCreationTokens: number | undefined

  const contentTextChunks: string[] = []
  const reasoningChunks: string[] = []
  const reasoningDetails: Array<Record<string, unknown>> = []
  const toolCalls: NonNullable<OpenAIChatResponseBody["choices"][number]["message"]["tool_calls"]> = []

  // Track blocks by index so deltas land in the right bucket.
  const byIndex = new Map<number, ActiveBlock>()

  for (const { event, data } of events) {
    if (!data) continue
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(data)
    } catch {
      continue // ignore malformed frames
    }
    const type = (payload.type as string) ?? event

    switch (type) {
      case "message_start": {
        const msg = payload.message as Record<string, unknown> | undefined
        if (msg) {
          messageId = msg.id as string | undefined
          model = msg.model as string | undefined
          const usage = msg.usage as Record<string, number> | undefined
          if (usage) {
            inputTokens = usage.input_tokens
            cacheReadTokens = usage.cache_read_input_tokens
            cacheCreationTokens = usage.cache_creation_input_tokens
          }
        }
        break
      }

      case "content_block_start": {
        const idx = (payload.index as number) ?? 0
        const cb = payload.content_block as Record<string, unknown> | undefined
        const cbType = (cb?.type as string) ?? "text"

        if (cbType === "text") {
          const block = newBlock("text")
          if (typeof cb?.text === "string") block.text = cb.text
          byIndex.set(idx, block)
        } else if (cbType === "thinking") {
          const block = newBlock("thinking")
          if (typeof cb?.thinking === "string") block.thinking = cb.thinking
          if (typeof cb?.signature === "string") block.signature = cb.signature
          byIndex.set(idx, block)
        } else if (cbType === "redacted_thinking") {
          const block = newBlock("redacted_thinking")
          if (typeof cb?.data === "string") block.data = cb.data
          byIndex.set(idx, block)
        } else if (cbType === "tool_use") {
          const block = newBlock("tool_use")
          block.toolName = (cb?.name as string) ?? "tool"
          block.toolId = (cb?.id as string) ?? `call_${idx}`
          byIndex.set(idx, block)
        }
        break
      }

      case "content_block_delta": {
        const idx = (payload.index as number) ?? 0
        const delta = payload.delta as Record<string, unknown> | undefined
        const dType = delta?.type as string | undefined
        const block = byIndex.get(idx)
        if (!block || !delta) break

        if (dType === "text_delta" && typeof delta.text === "string") {
          block.text += delta.text
        } else if (dType === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking += delta.thinking
        } else if (dType === "signature_delta" && typeof delta.signature === "string") {
          block.signature += delta.signature
        } else if (dType === "input_json_delta" && typeof delta.partial_json === "string") {
          block.toolInputRaw += delta.partial_json
        }
        break
      }

      case "content_block_stop": {
        const idx = (payload.index as number) ?? 0
        const block = byIndex.get(idx)
        if (!block) break

        if (block.type === "text" && block.text) {
          contentTextChunks.push(block.text)
        } else if (block.type === "thinking") {
          if (block.thinking) reasoningChunks.push(block.thinking)
          reasoningDetails.push({
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          })
        } else if (block.type === "redacted_thinking") {
          reasoningDetails.push({
            type: "redacted_thinking",
            data: block.data,
          })
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.toolId,
            type: "function",
            function: {
              name: block.toolName,
              arguments: block.toolInputRaw || "{}",
            },
          })
        }
        break
      }

      case "message_delta": {
        const delta = payload.delta as Record<string, unknown> | undefined
        if (delta && typeof delta.stop_reason === "string") {
          finishReason = delta.stop_reason
        }
        const usage = payload.usage as Record<string, number> | undefined
        if (usage) {
          outputTokens = usage.output_tokens ?? outputTokens
        }
        break
      }

      default:
        // ping, message_stop, error, etc. — nothing to reconstruct
        break
    }
  }

  const content = contentTextChunks.join("") || null
  const reasoning = reasoningChunks.join("\n\n")

  const message: OpenAIChatResponseBody["choices"][number]["message"] = {
    role: "assistant",
    content,
  }
  if (reasoning.length > 0) {
    message.reasoning_content = reasoning
  }
  if (reasoningDetails.length > 0) {
    message.reasoning_details = reasoningDetails
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return {
    id: messageId ?? `reconstructed-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
      ...(cacheReadTokens !== undefined || cacheCreationTokens !== undefined
        ? { completion_tokens_details: undefined as never }
        : {}),
    } as OpenAIChatResponseBody["usage"],
  }
}

/**
 * Try JSON first (non-streaming response), fall back to SSE parse (streaming).
 * Returns null if both fail.
 */
export function parseResponseBody(
  raw: string | null | undefined,
): OpenAIChatResponseBody | null {
  if (!raw) return null
  // Non-streaming: it's JSON straight away.
  try {
    const parsed = JSON.parse(raw) as OpenAIChatResponseBody
    if (parsed && "choices" in parsed) return parsed
  } catch {
    // fall through
  }
  // Streaming: parse the SSE frames.
  return parseAnthropicSSEResponse(raw)
}
