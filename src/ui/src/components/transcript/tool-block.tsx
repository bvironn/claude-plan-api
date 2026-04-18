import { ChevronDownIcon, WrenchIcon, ArrowRightIcon } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { truncate } from "@/lib/format"

// ---------------------------------------------------------------------------
// Tool use (assistant is invoking a tool)
// ---------------------------------------------------------------------------

export function ToolUseCard({
  name,
  input,
  id,
}: {
  name: string
  input: unknown
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2)
  const preview = truncate(inputStr.replace(/\s+/g, " "), 100)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-border bg-card flex flex-col rounded-lg border">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-t-lg px-3 py-2 hover:bg-transparent"
          >
            <WrenchIcon data-icon="inline-start" className="text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">{name}</span>
                <Badge variant="outline" className="font-normal">tool call</Badge>
              </div>
              {!open && (
                <span className="text-muted-foreground truncate font-mono text-xs">
                  {preview}
                </span>
              )}
            </div>
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-border border-t">
          <pre className="overflow-x-auto p-3 text-xs">
            <code>{inputStr}</code>
          </pre>
          {id && (
            <div className="text-muted-foreground border-border border-t px-3 py-1.5 font-mono text-[11px]">
              id: {id}
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

// ---------------------------------------------------------------------------
// Tool result (user lane, coming back from the tool)
// ---------------------------------------------------------------------------

export function ToolResultCard({
  content,
  toolUseId,
  isError,
}: {
  content: string
  toolUseId?: string
  isError?: boolean
}) {
  const [open, setOpen] = useState(false)
  const preview = truncate(content.replace(/\s+/g, " "), 100)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "flex flex-col rounded-lg border",
          isError
            ? "border-destructive/40 bg-destructive/5"
            : "border-border bg-card",
        )}
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-t-lg px-3 py-2 hover:bg-transparent"
          >
            <ArrowRightIcon data-icon="inline-start" className={cn("text-muted-foreground", isError && "text-destructive")} />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Tool result</span>
                {isError ? (
                  <Badge variant="destructive" className="font-normal">error</Badge>
                ) : (
                  <Badge variant="secondary" className="font-normal">ok</Badge>
                )}
              </div>
              {!open && (
                <span className="text-muted-foreground truncate font-mono text-xs">
                  {preview}
                </span>
              )}
            </div>
            <ChevronDownIcon
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-border border-t">
          <pre className="overflow-x-auto p-3 text-xs whitespace-pre-wrap">
            <code>{content}</code>
          </pre>
          {toolUseId && (
            <div className="text-muted-foreground border-border border-t px-3 py-1.5 font-mono text-[11px]">
              tool_use_id: {toolUseId}
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
