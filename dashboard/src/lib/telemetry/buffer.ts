"use client";

import { getSessionId } from "./session";

const DB_NAME = "telemetry";
const STORE_NAME = "events";
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_MAX = 50;
const FLUSH_ENDPOINT = "/api/proxy/telemetry";

let db: IDBDatabase | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { autoIncrement: true });
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(event: Record<string, unknown>): Promise<void> {
  if (typeof window === "undefined") return;
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const enriched = {
      ...event,
      sessionId: event.sessionId ?? getSessionId(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    const req = store.add(enriched);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // Auto-flush when batch fills up
    store.count().onsuccess = (e) => {
      const count = (e.target as IDBRequest<number>).result;
      if (count >= FLUSH_BATCH_MAX) {
        void flushBatch(FLUSH_BATCH_MAX);
      }
    };
  });
}

export async function flushBatch(max = FLUSH_BATCH_MAX): Promise<void> {
  if (typeof window === "undefined") return;
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const events: Array<{ key: IDBValidKey; value: Record<string, unknown> }> = [];

    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor && events.length < max) {
        events.push({ key: cursor.key, value: cursor.value as Record<string, unknown> });
        cursor.continue();
      } else {
        // Delete collected keys
        for (const { key } of events) {
          store.delete(key);
        }
        tx.oncomplete = async () => {
          if (events.length > 0) {
            await sendEvents(events.map((e) => e.value));
          }
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await fetch(FLUSH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telemetry-internal": "1",
      },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Silently fail — events are already removed from queue
  }
}

function sendBeaconFlush(): void {
  if (typeof window === "undefined" || !db) return;
  const database = db;
  const tx = database.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const events: Record<string, unknown>[] = [];
  const cursorReq = store.openCursor();
  cursorReq.onsuccess = (e) => {
    const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (cursor) {
      events.push(cursor.value as Record<string, unknown>);
      store.delete(cursor.key);
      cursor.continue();
    } else if (events.length > 0) {
      const blob = new Blob([JSON.stringify({ events })], {
        type: "application/json",
      });
      navigator.sendBeacon(FLUSH_ENDPOINT, blob);
    }
  };
}

export function start(): void {
  if (typeof window === "undefined") return;
  if (flushTimer) return; // Already started

  void openDB();

  flushTimer = setInterval(() => {
    void flushBatch(FLUSH_BATCH_MAX);
  }, FLUSH_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      sendBeaconFlush();
    }
  });

  window.addEventListener("pagehide", () => {
    sendBeaconFlush();
  });
}
