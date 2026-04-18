import { Fragment, useState } from "react"
import { ChevronDownIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { splitContextPreamble } from "@/lib/format"
import { RoleAvatar, type Role } from "@/components/transcript/role-avatar"
import { ToolResultCard, ToolUseCard } from "@/components/transcript/tool-block"
import { MarkdownView } from "@/components/transcript/markdown-view"
import { ContextPreamble } from "@/components/transcript/context-preamble"

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  signature?: string
  name?: string
  input?: unknown
  id?: string
  tool_use_id?: string
  content?: string | Array<Record<string, unknown>>
  is_error?: boolean
  source?: Record<string, unknown>
  data?: string
  [key: string]: unknown
}

/**
 * Normalises any `content` shape that Claude / OpenAI might use into a list of
 * typed blocks. Handles: plain string, array of blocks, undefined.
 */
function normaliseContent(content: unknown): ContentBlock[] {
  if (content == null) return []
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }
  if (Array.isArray(content)) {
    return content as ContentBlock[]
  }
  // Unknown shape — stringify as a last resort so nothing gets silently dropped.
  return [{ type: "text", text: JSON.stringify(content, null, 2) }]
}

function extractText(block: ContentBlock): string {
  if (typeof block.text === "string") return block.text
  if (typeof block.content === "string") return block.content
  if (Array.isArray(block.content)) {
    const first = block.content.find(
      (c): c is { type: string; text?: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    return first?.text ?? ""
  }
  return ""
}

function isImageBlock(block: ContentBlock): boolean {
  return block.type === "image" || block.type === "image_url"
}

function renderImageBlock(block: ContentBlock, index: number): React.ReactNode {
  // Best-effort image rendering: supports {type:"image", source:{data, media_type}}
  // (Anthropic) and {type:"image_url", image_url:{url}} (OpenAI).
  const url =
    typeof block.image_url === "object" && block.image_url !== null
      ? (block.image_url as { url?: string }).url
      : block.source &&
          typeof block.source === "object" &&
          (block.source as { data?: string; media_type?: string }).data
        ? `data:${(block.source as { media_type?: string }).media_type ?? "image/png"};base64,${(block.source as { data?: string }).data}`
        : undefined

  if (!url) {
    return (
      <div key={index} className="text-muted-foreground text-xs italic">
        [image block — no URL]
      </div>
    )
  }

  return (
    <img
      key={index}
      src={url}
      alt="Inline image"
      className="border-border max-w-full rounded-md border"
    />
  )
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface MessageBubbleProps {
  role: Role
  content: unknown
  toolCalls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  toolCallId?: string
  name?: string
}

export function MessageBubble({ role, content, toolCalls, toolCallId, name }: MessageBubbleProps) {
  const blocks = normaliseContent(content)

  // Classify blocks to decide rendering.
  const textBlocks = blocks.filter((b) => b.type === "text" || (!b.type && typeof b.text === "string"))
  const toolUseBlocks = blocks.filter((b) => b.type === "tool_use")
  const toolResultBlocks = blocks.filter((b) => b.type === "tool_result")
  const thinkingBlocks = blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking")
  const imageBlocks = blocks.filter(isImageBlock)

  // Visual role overrides the semantic role when the message is PRIMARILY
  // tool I/O. Anthropic packs tool_result into role="user" and tool_use into
  // role="assistant", but for audit readability the operator cares about the
  // role of the CONTENT, not the protocol lane. Rules:
  //   - role=user with content = exclusively tool_result   → visual "tool"
  //   - role=assistant with only tool_use (no text)        → visual "tool"
  //   - otherwise                                          → visual matches role
  const onlyToolResults =
    role === "user" &&
    toolResultBlocks.length > 0 &&
    textBlocks.length === 0 &&
    imageBlocks.length === 0 &&
    thinkingBlocks.length === 0
  const onlyToolCalls =
    role === "assistant" &&
    textBlocks.length === 0 &&
    thinkingBlocks.length === 0 &&
    imageBlocks.length === 0 &&
    (toolUseBlocks.length > 0 || (toolCalls && toolCalls.length > 0))
  const visualRole: Role = onlyToolResults || onlyToolCalls ? "tool" : role

  const isUser = visualRole === "user"

  return (
    <div className="flex gap-3">
      <RoleAvatar role={visualRole} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="capitalize">{visualRole}</span>
          {name && (
            <Badge variant="outline" className="font-mono font-normal">
              {name}
            </Badge>
          )}
          {(onlyToolResults || onlyToolCalls) && (
            <Badge variant="outline" className="font-normal text-[10px]">
              role={role} · rendered as tool
            </Badge>
          )}
        </div>

        {/* Tool result (when role === "tool") */}
        {role === "tool" && toolCallId && textBlocks[0]?.text && (
          <ToolResultCard content={textBlocks[0].text} toolUseId={toolCallId} />
        )}

        {/* Role === tool but formatted as content blocks (Anthropic style) */}
        {toolResultBlocks.map((b, i) => (
          <ToolResultCard
            key={`tr-${i}`}
            content={extractText(b) || JSON.stringify(b.content)}
            toolUseId={b.tool_use_id as string | undefined}
            isError={b.is_error as boolean | undefined}
          />
        ))}

        {/* Text blocks (user/assistant plain text).
            For user messages, detect the injected CONTEXT_PREAMBLE and split
            it into a collapsible "Context" card + the real user question.
            This is a huge UX win for OpenCode/Cline-style invocations where
            the preamble is 10-50k chars of AGENTS.md noise and the user's
            actual question is a single short paragraph. */}
        {textBlocks.length > 0 && role !== "tool" && (
          <div className="flex flex-col gap-2">
            {textBlocks.map((b, i) => {
              const text = b.text ?? ""
              const split = isUser ? splitContextPreamble(text) : { userInput: text }

              return (
                <Fragment key={`t-${i}`}>
                  {split.context && <ContextPreamble content={split.context} />}
                  {split.userInput.length > 0 && (
                    <div
                      className={cn(
                        "rounded-lg px-3.5 py-2.5",
                        isUser
                          ? "bg-primary text-primary-foreground"
                          : "bg-card border-border border",
                      )}
                    >
                      <MarkdownView
                        content={split.userInput}
                        className={cn(
                          isUser && [
                            "text-primary-foreground",
                            "[&_code]:bg-primary-foreground/20",
                            "[&_a]:text-primary-foreground [&_a]:underline",
                          ],
                        )}
                      />
                    </div>
                  )}
                </Fragment>
              )
            })}
          </div>
        )}

        {/* Images */}
        {imageBlocks.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {imageBlocks.map((b, i) => renderImageBlock(b, i))}
          </div>
        )}

        {/* OpenAI-style tool_calls on assistant turns */}
        {toolCalls?.map((tc) => {
          let parsed: unknown = tc.function.arguments
          try {
            parsed = JSON.parse(tc.function.arguments)
          } catch {}
          return (
            <ToolUseCard
              key={tc.id}
              id={tc.id}
              name={tc.function.name}
              input={parsed}
            />
          )
        })}

        {/* Anthropic-style tool_use blocks inside content array */}
        {toolUseBlocks.map((b, i) => (
          <ToolUseCard
            key={`tu-${i}`}
            id={b.id as string | undefined}
            name={(b.name as string) ?? "tool"}
            input={b.input}
          />
        ))}

        {/* Thinking blocks inside content (rare — reasoning_content is preferred) */}
        {thinkingBlocks.map((b, i) => (
          <ThinkingInlineBlock key={`th-${i}`} block={b} />
        ))}
      </div>
    </div>
  )
}

function ThinkingInlineBlock({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false)
  const isRedacted = block.type === "redacted_thinking"
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-border/70 bg-muted/30 flex flex-col rounded-lg border border-dashed">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-t-lg px-3 py-2 hover:bg-transparent"
          >
            <div className="flex flex-1 items-center gap-2">
              <Badge variant="outline" className="font-normal">
                {isRedacted ? "redacted_thinking" : "thinking"}
              </Badge>
              {!isRedacted && block.thinking && (
                <span className="text-muted-foreground truncate font-mono text-xs">
                  {(block.thinking as string).slice(0, 80)}
                </span>
              )}
            </div>
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-4 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-border/70 border-t border-dashed p-3">
          {isRedacted ? (
            <div className="text-muted-foreground font-mono text-xs">
              Encrypted ({(block.data as string | undefined)?.length ?? 0} bytes of ciphertext)
            </div>
          ) : (
            <MarkdownView content={(block.thinking as string) ?? ""} />
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
