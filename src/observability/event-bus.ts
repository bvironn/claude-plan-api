import type { TelemetryEvent } from "./types.ts";

type Subscriber = (event: TelemetryEvent) => void;

const subs = new Set<Subscriber>();

export function publish(e: TelemetryEvent): void {
  for (const s of subs) {
    try { s(e); } catch {}
  }
}

export function subscribe(s: Subscriber): () => void {
  subs.add(s);
  return () => subs.delete(s);
}
