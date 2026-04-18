import { createFileRoute } from "@tanstack/react-router"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ActivityIcon } from "lucide-react"

export const Route = createFileRoute("/live")({
  component: LivePage,
})

function LivePage() {
  return (
    <div className="container mx-auto flex min-h-[60vh] items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>Live stream coming in Phase 6</EmptyTitle>
          <EmptyDescription>
            Subscribes to{" "}
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs">GET /api/telemetry/stream</code>{" "}
            via EventSource with auto-reconnect.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}
