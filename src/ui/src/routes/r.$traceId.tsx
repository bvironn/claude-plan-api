import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeftIcon, MessageSquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export const Route = createFileRoute("/r/$traceId")({
  component: TranscriptPage,
})

function TranscriptPage() {
  const { traceId } = Route.useParams()

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to list
          </Link>
        </Button>
      </div>

      <div className="flex min-h-[50vh] items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareIcon />
            </EmptyMedia>
            <EmptyTitle>Transcript viewer coming in Phase 5</EmptyTitle>
            <EmptyDescription>
              Trace <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{traceId}</code>{" "}
              will render as a chat with system prompts, tool calls, thinking
              blocks, and a technical side panel.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  )
}
