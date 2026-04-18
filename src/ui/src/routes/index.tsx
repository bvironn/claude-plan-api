import { createFileRoute } from "@tanstack/react-router"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ListIcon } from "lucide-react"

export const Route = createFileRoute("/")({
  component: IndexPage,
})

function IndexPage() {
  // Phase 1 placeholder — Phase 4 replaces this with the real request list.
  return (
    <div className="container mx-auto flex min-h-[60vh] items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListIcon />
          </EmptyMedia>
          <EmptyTitle>Requests list coming in Phase 4</EmptyTitle>
          <EmptyDescription>
            The UI scaffold is live. Next phase wires this page to{" "}
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs">GET /api/telemetry/requests</code>.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <p className="text-muted-foreground text-xs">
            Try the theme toggle in the header — persists across reloads, keyboard shortcut <kbd>d</kbd>.
          </p>
        </EmptyContent>
      </Empty>
    </div>
  )
}
