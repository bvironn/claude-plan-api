/**
 * Group chat-completion requests into logical "conversations" by inferring
 * the conversation identity from the first user message.
 *
 * Rationale:
 *   - The gateway records each `POST /v1/chat/completions` as a separate
 *     telemetry row. OpenCode / Cline / curl each send the ENTIRE message
 *     history on every turn.
 *   - Therefore: two requests with the same first-user-text AND close in
 *     time are almost certainly the same conversation.
 *   - The LAST request in a group contains the richest history — it's what
 *     the operator wants to open when they click "this conversation".
 */

import type { RequestRecord, OpenAIChatRequestBody, AnthropicRequestBody } from "./types"
import { parseOrNull, splitContextPreamble, CONTEXT_PREAMBLE_MARKER } from "./format"

export interface Conversation {
  /** Stable-ish id built from firstUserText hash + first timestamp. */
  id: string
  /** Truncated first user question (post-preamble strip). */
  preview: string
  /** Number of turns (== number of requests) captured in this group. */
  turns: number
  /** Models observed in this conversation. */
  models: string[]
  /** Earliest request timestamp. */
  startedAt: string
  /** Latest request timestamp. */
  lastActivityAt: string
  /** Sum of output tokens across turns. */
  totalOutputTokens: number
  /** Sum of input tokens across turns. */
  totalInputTokens: number
  /** Trace id of the LAST (richest) turn — where click-through lands. */
  latestTraceId: string
  /** All trace ids in chronological order. */
  traceIds: string[]
  /** Any error status in the conversation? */
  hasError: boolean
}

// ---------------------------------------------------------------------------
// First-user-text extraction
// ---------------------------------------------------------------------------

function firstUserTextFromRequest(record: RequestRecord): string | null {
  // Prefer upstream (post-transform) because it's what actually went to Anthropic.
  const upstream = parseOrNull<AnthropicRequestBody>(record.upstreamRequestBody)
  if (upstream?.messages) {
    const firstUser = upstream.messages.find((m) => m.role === "user")
    if (firstUser) {
      const raw = flattenContent(firstUser.content)
      // Strip the injected CONTEXT_PREAMBLE so two conversations with
      // different preambles but the same actual question don't collide.
      const { userInput } = splitContextPreamble(raw)
      return userInput || raw
    }
  }

  const clientReq = parseOrNull<OpenAIChatRequestBody>(record.requestBody)
  if (clientReq?.messages) {
    const firstUser = clientReq.messages.find((m) => m.role === "user")
    if (firstUser) {
      const raw = typeof firstUser.content === "string"
        ? firstUser.content
        : flattenContent(firstUser.content as unknown)
      const { userInput } = splitContextPreamble(raw)
      return userInput || raw
    }
  }

  return null
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block)
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>
        if (typeof b.text === "string") parts.push(b.text)
        else if (typeof b.content === "string") parts.push(b.content)
      }
    }
    return parts.join("\n")
  }
  return ""
}

// ---------------------------------------------------------------------------
// Stable-ish hash (djb2). Only used for grouping, collisions are tolerable.
// ---------------------------------------------------------------------------

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface GroupingOptions {
  /** Max minutes between two turns of the same conversation. Default: 60 min. */
  maxIdleMinutes?: number
  /** How many chars of the first user text form the conversation key. Default: 400. */
  keyLength?: number
}

export function groupIntoConversations(
  requests: RequestRecord[],
  opts: GroupingOptions = {},
): Conversation[] {
  const maxIdleMs = (opts.maxIdleMinutes ?? 60) * 60_000
  const keyLen = opts.keyLength ?? 400

  // Sort ASC so we build each conversation in chronological order.
  const sorted = [...requests].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )

  // Key: hashed(firstUserText). Value: the most recent Conversation we're
  // appending to; if a request's timestamp is more than maxIdleMs after the
  // current lastActivityAt, we open a new conversation with a new id.
  const byKey = new Map<string, Conversation>()
  const all: Conversation[] = []

  for (const r of sorted) {
    const firstText = firstUserTextFromRequest(r)
    if (!firstText) continue // non-chat or malformed — skip

    const key = hash(firstText.slice(0, keyLen))
    const existing = byKey.get(key)

    const ts = new Date(r.timestamp).getTime()
    const withinIdleWindow =
      existing && ts - new Date(existing.lastActivityAt).getTime() <= maxIdleMs

    if (existing && withinIdleWindow) {
      // Append to existing conversation.
      existing.turns += 1
      existing.lastActivityAt = r.timestamp
      existing.latestTraceId = r.traceId
      existing.traceIds.push(r.traceId)
      if (r.model && !existing.models.includes(r.model)) existing.models.push(r.model)
      existing.totalInputTokens += r.inputTokens ?? 0
      existing.totalOutputTokens += r.outputTokens ?? 0
      if (r.status != null && r.status >= 400) existing.hasError = true
    } else {
      // Start a new conversation group (new session, same first text).
      const conv: Conversation = {
        id: `${key}-${hash(r.traceId)}`,
        preview: firstText.slice(0, 200),
        turns: 1,
        models: r.model ? [r.model] : [],
        startedAt: r.timestamp,
        lastActivityAt: r.timestamp,
        totalInputTokens: r.inputTokens ?? 0,
        totalOutputTokens: r.outputTokens ?? 0,
        latestTraceId: r.traceId,
        traceIds: [r.traceId],
        hasError: r.status != null && r.status >= 400,
      }
      byKey.set(key, conv)
      all.push(conv)
    }
  }

  // Return sorted by most recent activity DESC (most recent first).
  return all.sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  )
}

// Re-export CONTEXT_PREAMBLE_MARKER in case callers want to trim their own displays.
export { CONTEXT_PREAMBLE_MARKER }
