import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangleIcon, PlayIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { RequestRecord } from "@/lib/types"
import { TranscriptView } from "@/components/transcript/transcript-view"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of a completed or in-flight replay. The parent (`/r/:traceId` route)
 * renders a second `<TranscriptView>` under the original whenever `record`
 * is present, passing `record` directly. Consumers do NOT need to know the
 * streaming protocol — they just render the ephemeral record as if it were
 * a real stored one.
 */
export interface ReplayRecord {
  /** Synthetic RequestRecord rebuilt from the streamed SSE bytes. */
  record: RequestRecord
  /** true while bytes are still arriving. */
  streaming: boolean
  /** true once the stream closed cleanly (or errored — `error` non-null). */
  finished: boolean
  /** Error text if the replay failed. */
  error: string | null
  /** ISO timestamp the replay started. */
  startedAt: string
}

export interface ReplayButtonProps {
  original: RequestRecord
  /**
   * Called whenever the replay state changes. Parent persists it and renders
   * a second transcript column beneath the original.
   */
  onReplay: (replay: ReplayRecord | null) => void
  /** If another replay is running somewhere else in the page, disable this one. */
  externalInFlight?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Replay button that lives in the transcript header.
 *
 * Click → Dialog confirm → on confirm, POSTs the original `requestBody` to
 * `/v1/chat/completions` with `Accept: text/event-stream`. The gateway streams
 * Anthropic-shaped SSE bytes back. We accumulate them into a synthetic
 * `RequestRecord.responseBody` and surface it via `onReplay` so the parent
 * can render a second `<TranscriptView>` column that updates live.
 *
 * While a replay is in flight the button disables, shows a `<Spinner>`, and
 * a tooltip reads "Replay in progress".
 */
export function ReplayButton({
  original,
  onReplay,
  externalInFlight,
}: ReplayButtonProps) {
  const [open, setOpen] = useState(false)
  const [inFlight, setInFlight] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Cancel any in-flight fetch when the component unmounts so we don't
  // dangle a fetch after navigation away from `/r/:traceId`.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const disabled = inFlight || externalInFlight || !original.requestBody

  const startReplay = useCallback(async () => {
    if (inFlight) {
      toast.error("Replay already in progress")
      return
    }
    if (!original.requestBody) {
      toast.error("No requestBody recorded — nothing to replay")
      return
    }
    setOpen(false)
    setInFlight(true)

    const controller = new AbortController()
    abortRef.current = controller

    const startedAt = new Date().toISOString()

    // Seed a synthetic record. `responseBody` grows as bytes arrive.
    const base: RequestRecord = {
      id: -1,
      traceId: `replay-${original.traceId}-${Date.now().toString(36)}`,
      timestamp: startedAt,
      method: "POST",
      path: "/v1/chat/completions",
      status: null,
      duration: null,
      model: original.model,
      isStream: true,
      inputTokens: undefined,
      outputTokens: undefined,
      requestBody: original.requestBody,
      upstreamRequestBody: original.upstreamRequestBody,
      responseBody: "",
      error: null,
    }

    let current: RequestRecord = base
    const emit = (patch: Partial<RequestRecord>, flags: { streaming: boolean; finished: boolean; error: string | null }) => {
      current = { ...current, ...patch }
      onReplay({
        record: current,
        streaming: flags.streaming,
        finished: flags.finished,
        error: flags.error,
        startedAt,
      })
    }

    emit({}, { streaming: true, finished: false, error: null })

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: original.requestBody,
        signal: controller.signal,
      })

      emit({ status: res.status }, { streaming: true, finished: false, error: null })

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "")
        const msg = `HTTP ${res.status}: ${text.slice(0, 200)}`
        emit(
          { responseBody: text, error: msg, status: res.status },
          { streaming: false, finished: true, error: msg },
        )
        setInFlight(false)
        abortRef.current = null
        toast.error("Replay failed")
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const startMs = performance.now()
      let acc = ""

      // Pump the stream. Each chunk appends to `responseBody`; the consumer
      // re-parses on every update (cheap — Anthropic SSE is small).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        emit({ responseBody: acc }, { streaming: true, finished: false, error: null })
      }
      acc += decoder.decode()
      const durationMs = Math.round(performance.now() - startMs)

      emit(
        { responseBody: acc, duration: durationMs },
        { streaming: false, finished: true, error: null },
      )
      toast.success("Replay complete")
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // Normal teardown — nothing to surface.
        return
      }
      const msg = (err as Error).message || "Replay failed"
      emit({ error: msg }, { streaming: false, finished: true, error: msg })
      toast.error(msg)
    } finally {
      setInFlight(false)
      abortRef.current = null
    }
  }, [inFlight, original, onReplay])

  return (
    <>
      {disabled ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Buttons with disabled don't fire pointer events, so the tooltip
                  is attached to a wrapper span to keep it reachable. */}
              <span tabIndex={0}>
                <Button variant="outline" size="sm" disabled>
                  {inFlight || externalInFlight ? (
                    <Spinner />
                  ) : (
                    <PlayIcon />
                  )}
                  Replay
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {inFlight || externalInFlight
                ? "Replay in progress"
                : "No requestBody recorded"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <PlayIcon data-icon="inline-start" />
              Replay
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangleIcon className="text-amber-500" />
                Replay this request?
              </DialogTitle>
              <DialogDescription>
                The gateway will re-send the original{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                  requestBody
                </code>{" "}
                to{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                  POST /v1/chat/completions
                </code>
                . This consumes quota and may have side effects if the prompt
                triggers tool calls. The original record will NOT be modified
                — the new response appears below it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button onClick={startReplay}>
                <PlayIcon data-icon="inline-start" />
                Run replay
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Small helper: renders the replay panel below the original transcript.
// ---------------------------------------------------------------------------

/**
 * Stateless panel rendered by the transcript page when a replay has started.
 * The page owns the `ReplayRecord | null` state and passes it down here.
 */
export function ReplayPanel({ replay }: { replay: ReplayRecord | null }) {
  if (!replay) return null
  return (
    <div className="border-border/70 bg-muted/20 flex flex-col gap-3 rounded-lg border border-dashed p-4">
      <div className="flex items-center gap-2 text-sm">
        {replay.streaming && <Spinner className="size-3.5" />}
        <span className="font-medium">
          {replay.streaming
            ? "Replay streaming…"
            : replay.error
              ? "Replay failed"
              : "Replay complete"}
        </span>
        <span className="text-muted-foreground text-xs">
          started {new Date(replay.startedAt).toLocaleTimeString()}
        </span>
      </div>
      {replay.error ? (
        <pre className="bg-destructive/10 text-destructive overflow-x-auto rounded-md p-3 text-xs">
          {replay.error}
        </pre>
      ) : (
        <TranscriptView record={replay.record} />
      )}
    </div>
  )
}
