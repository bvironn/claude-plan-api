"use client";

import type { TelemetryEvent } from "./types";

export type SSECallback = (event: TelemetryEvent) => void;

const SSE_URL = "/api/proxy/telemetry/stream";
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

export class TelemetrySSE {
  private es: EventSource | null = null;
  private callbacks: SSECallback[] = [];
  private reconnectDelay = RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor() {}

  subscribe(cb: SSECallback): () => void {
    this.callbacks.push(cb);
    if (!this.es) this.connect();
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== cb);
      if (this.callbacks.length === 0) this.disconnect();
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.es = new EventSource(SSE_URL);

    this.es.addEventListener("telemetry", (e: MessageEvent) => {
      this.reconnectDelay = RECONNECT_DELAY_MS; // reset on success
      try {
        const data = JSON.parse(e.data) as TelemetryEvent;
        for (const cb of this.callbacks) cb(data);
      } catch {
        // ignore parse errors
      }
    });

    this.es.onerror = () => {
      this.es?.close();
      this.es = null;
      if (!this.stopped && this.callbacks.length > 0) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectDelay = Math.min(
            this.reconnectDelay * 2,
            MAX_RECONNECT_DELAY_MS
          );
          this.connect();
        }, this.reconnectDelay);
      }
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.es?.close();
    this.es = null;
  }

  reconnect(): void {
    this.stopped = false;
    this.es?.close();
    this.es = null;
    this.connect();
  }
}

let sseInstance: TelemetrySSE | null = null;

export function getSSE(): TelemetrySSE {
  if (!sseInstance) sseInstance = new TelemetrySSE();
  return sseInstance;
}
