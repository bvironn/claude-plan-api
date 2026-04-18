import { ChevronDownIcon, ShieldIcon } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { MarkdownView } from "@/components/transcript/markdown-view"
import { truncate } from "@/lib/format"

// Classification helper: assigns a human-readable label to each system block.
function classifyBlock(text: string): string {
  if (text.startsWith("x-anthropic-billing-header:")) return "billing"
  if (text.startsWith("You are Claude Code")) return "claude-code-identity"
  if (text.startsWith("The content below is additional context")) return "client-preamble"
  if (text.toLowerCase().startsWith("you are")) return "client-persona"
  return "other"
}

/**
 * System blocks from upstream request `system[]` array. Renders as a
 * collapsed card at the top of the transcript. Each block gets a badge
 * identifying its role so the operator can at-a-glance see what's in the
 * system prompt without expanding.
 */
export function SystemBlocks({
  blocks,
}: {
  blocks: Array<{ type?: string; text?: string } & Record<string, unknown>>
}) {
  const [open, setOpen] = useState(false)
  if (!blocks || blocks.length === 0) return null

  const classifications = blocks.map((b) => classifyBlock((b.text as string) ?? ""))

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-border bg-muted/30 flex flex-col rounded-lg border">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-t-lg px-3 py-2 hover:bg-transparent"
          >
            <ShieldIcon data-icon="inline-start" className="text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium">System</span>
              <span className="text-muted-foreground text-xs">
                ({blocks.length} block{blocks.length === 1 ? "" : "s"})
              </span>
              <div className="flex flex-wrap gap-1">
                {classifications.map((c, i) => (
                  <Badge key={i} variant="outline" className="font-normal">
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-border flex flex-col gap-2 border-t p-3">
          {blocks.map((b, i) => (
            <SystemBlockCard key={i} index={i} text={(b.text as string) ?? ""} classification={classifications[i]!} />
          ))}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function SystemBlockCard({
  index,
  text,
  classification,
}: {
  index: number
  text: string
  classification: string
}) {
  const isShort = text.length < 300
  const [expanded, setExpanded] = useState(isShort)
  const displayed = expanded ? text : truncate(text, 240)

  return (
    <div className="border-border bg-background flex flex-col gap-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            [{index}] {classification}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {text.length.toLocaleString()} chars
          </span>
        </div>
        {!isShort && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Collapse" : "Expand"}
          </Button>
        )}
      </div>
      <MarkdownView content={displayed} className="text-xs" />
    </div>
  )
}
