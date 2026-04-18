import { ChevronDownIcon, FileTextIcon } from "lucide-react"
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

/**
 * Collapsed card that wraps the CONTEXT_PREAMBLE portion of the first user
 * message. Renders INSIDE the user bubble so the visual hierarchy is:
 *
 *   [avatar] User
 *     [Collapsed card "Context (NNN chars)"]
 *     [Actual user question]
 *
 * Operators usually want to see only the question and the LLM's answer; the
 * injected AGENTS.md / persona / tool catalogue is noise 95% of the time.
 */
export function ContextPreamble({ content }: { content: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-border/60 bg-muted/40 flex flex-col rounded-lg border border-dashed">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-full justify-start gap-2 rounded-t-lg px-2.5 py-1.5 hover:bg-transparent"
          >
            <FileTextIcon
              data-icon="inline-start"
              className="text-muted-foreground size-3.5"
            />
            <span className="text-muted-foreground text-xs font-medium">
              Context preamble
            </span>
            <Badge variant="outline" className="font-normal">
              {content.length.toLocaleString()} chars
            </Badge>
            <span className="text-muted-foreground flex-1 text-left text-xs">
              — injected agent context, collapsed by default
            </span>
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-3.5 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-border/60 border-t border-dashed p-3">
          <MarkdownView content={content} className="text-xs" />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
