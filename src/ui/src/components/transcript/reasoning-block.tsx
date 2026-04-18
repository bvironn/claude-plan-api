import { BrainIcon, ChevronDownIcon } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { MarkdownView } from "@/components/transcript/markdown-view"

/**
 * Reasoning block (chain of thought) shown above the final assistant message.
 * Collapsed by default — audit tools prioritise the outcome; thinking is
 * "for when you need it".
 */
export function ReasoningBlock({
  text,
  details,
}: {
  text: string
  details?: Array<Record<string, unknown>>
}) {
  const [open, setOpen] = useState(false)
  const charCount = text.length
  const hasSignature = details?.some((d) => (d as { signature?: string }).signature)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-border/70 bg-muted/30 flex flex-col rounded-lg border border-dashed">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-t-lg px-3 py-2 hover:bg-transparent"
          >
            <BrainIcon data-icon="inline-start" className="text-muted-foreground" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-sm font-medium">Reasoning</span>
              <Badge variant="outline" className="font-normal">
                {charCount.toLocaleString()} chars
              </Badge>
              {hasSignature && (
                <Badge variant="outline" className="font-normal">
                  signed
                </Badge>
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
        <CollapsibleContent className="border-border/70 border-t border-dashed">
          <Tabs defaultValue="text" className="w-full">
            <TabsList className="mx-3 mt-3">
              <TabsTrigger value="text">Text</TabsTrigger>
              {details && details.length > 0 && (
                <TabsTrigger value="raw">
                  Raw blocks ({details.length})
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="text" className="p-3">
              <MarkdownView content={text} />
            </TabsContent>
            {details && details.length > 0 && (
              <TabsContent value="raw" className="p-3">
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code>{JSON.stringify(details, null, 2)}</code>
                </pre>
              </TabsContent>
            )}
          </Tabs>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
