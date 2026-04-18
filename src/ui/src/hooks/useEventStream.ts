import { useCallback, useEffect, useRef, useState } from "react"

import type { TelemetryEvent } from "@/lib/types"

type Status = "connecting" | "open" | "paused" | "reconnecting" | "closed"

interface Options {
  /** URL to open an EventSource on. Default: `/api/telemetry/stream`. */
  url?: string
  /** Max events retained in the ring buffer. Older ones are evicted. Default: 500. */
  bufferSize?: number
  /** Initial reconnect delay in ms. Doubles each failure up to maxReconnectDelayMs. */
  initialReconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export interface EventStream {
  /** Newest first. Length capped at bufferSize. */
  events: TelemetryEvent[]
  status: Status
  /** Reconnect count since mount. */
  reconnects: number
  /** While paused, new events accumulate into a side-buffer and are NOT appended to `events`. */
  paused: boolean
  /** Count of events in the pause-side-buffer waiting to be flushed. */
  pendingCount: number
  pause: () => void
  resume: () => void
  clear: () => void
}

/**
 * Subscribe to the gateway's SSE event stream.
 *
 * - Reverse-chronological buffer (newest first).
 * - Exponential-backoff reconnect (initial 3 s, max 30 s, doubling).
 * - Pause/resume with a side buffer so the UI can stop moving without
 *   dropping events.
 * - Cleans up the EventSource on unmount.
 */
export function useEventStream({
  url = "/api/telemetry/stream",
  bufferSize = 500,
  initialReconnectDelayMs = 3_000,
  maxReconnectDelayMs = 30_000,
}: Options = {}): EventStream {
  const [events, setEvents] = useState<TelemetryEvent[]>([])
  const [status, setStatus] = useState<Status>("connecting")
  const [reconnects, setReconnects] = useState(0)
  const [paused, setPaused] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const pendingRef = useRef<TelemetryEvent[]>([])
  const delayRef = useRef(initialReconnectDelayMs)
  const reconnectTimerRef = useRef<number | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const appendEvent = useCallback(
    (ev: TelemetryEvent) => {
      if (pausedRef.current) {
        pendingRef.current.unshift(ev)
        // Cap pending buffer too (belt-and-braces)
        if (pendingRef.current.length > bufferSize * 2) {
          pendingRef.current = pendingRef.current.slice(0, bufferSize * 2)
        }
        setPendingCount(pendingRef.current.length)
        return
      }
      setEvents((prev) => {
        const next = [ev, ...prev]
        return next.length > bufferSize ? next.slice(0, bufferSize) : next
      })
    },
    [bufferSize],
  )

  const pause = useCallback(() => setPaused(true), [])
  const resume = useCallback(() => {
    // Flush pending into main buffer, then clear pending.
    const flushed = pendingRef.current
    pendingRef.current = []
    setPendingCount(0)
    setPaused(false)
    if (flushed.length > 0) {
      setEvents((prev) => {
        const next = [...flushed, ...prev]
        return next.length > bufferSize ? next.slice(0, bufferSize) : next
      })
    }
  }, [bufferSize])

  const clear = useCallback(() => {
    setEvents([])
    pendingRef.current = []
    setPendingCount(0)
  }, [])

  useEffect(() => {
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      setStatus((s) => (s === "reconnecting" ? s : "connecting"))
      const es = new EventSource(url)
      esRef.current = es

      es.onopen = () => {
        if (cancelled) return
        setStatus("open")
        delayRef.current = initialReconnectDelayMs // reset backoff on a successful open
      }

      // The gateway emits events with a specific name (`event: telemetry`).
      // EventSource.onmessage ONLY fires for unnamed events — named events
      // need addEventListener. This is the single easiest bug to miss with
      // EventSource. See backend: src/observability/event-bus.ts and the
      // SSE formatter in routes/telemetry/stream.ts.
      const onTelemetry = (msg: MessageEvent) => {
        if (cancelled) return
        try {
          const parsed = JSON.parse(msg.data) as TelemetryEvent
          appendEvent(parsed)
        } catch {
          // Malformed payload — drop silently. (The backend emits valid JSON.)
        }
      }
      es.addEventListener("telemetry", onTelemetry)

      // Keep a plain onmessage handler too as a fallback: if the backend
      // ever emits unnamed events, we still capture them.
      es.onmessage = onTelemetry

      es.onerror = () => {
        if (cancelled) return
        // EventSource auto-reconnects, but we want explicit backoff + status.
        es.removeEventListener("telemetry", onTelemetry)
        es.close()
        esRef.current = null
        setStatus("reconnecting")
        setReconnects((n) => n + 1)
        const delay = delayRef.current
        delayRef.current = Math.min(delay * 2, maxReconnectDelayMs)
        reconnectTimerRef.current = window.setTimeout(connect, delay) as unknown as number
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      esRef.current?.close()
      esRef.current = null
      setStatus("closed")
    }
  }, [url, appendEvent, initialReconnectDelayMs, maxReconnectDelayMs])

  return {
    events,
    status,
    reconnects,
    paused,
    pendingCount,
    pause,
    resume,
    clear,
  }
}
