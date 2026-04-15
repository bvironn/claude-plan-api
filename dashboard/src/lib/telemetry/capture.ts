"use client";

import { enqueue } from "./buffer";
import { getSessionId, newTraceId } from "./session";

let initialized = false;
let maxScrollPct = 0;
let pageEnterTime = 0;

function buildSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = Array.from(el.classList)
    .slice(0, 3)
    .map((c) => `.${c}`)
    .join("");
  return `${tag}${id}${classes}`;
}

export function capture(event: string, payload: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  void enqueue({
    event,
    level: "info",
    timestamp: new Date().toISOString(),
    sessionId: getSessionId(),
    payload,
  });
}

function installClickCapture(): void {
  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const target = e.target as Element;
      capture("ui.click", {
        selector: buildSelector(target),
        text: target.textContent?.slice(0, 80)?.trim(),
        x: e.clientX,
        y: e.clientY,
        button: e.button,
        pageUrl: location.pathname,
      });
    },
    { capture: true, passive: true }
  );
}

function patchHistory(): void {
  const orig = {
    pushState: history.pushState.bind(history),
    replaceState: history.replaceState.bind(history),
  };

  history.pushState = function (...args) {
    orig.pushState(...args);
    capture("ui.nav", { type: "pushState", url: args[2] });
  };

  history.replaceState = function (...args) {
    orig.replaceState(...args);
    capture("ui.nav", { type: "replaceState", url: args[2] });
  };

  window.addEventListener("popstate", () => {
    capture("ui.nav", { type: "popstate", url: location.pathname });
  });
}

function installFetchCapture(): void {
  const origFetch = window.fetch.bind(window);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).fetch = async (...args: Parameters<typeof fetch>) => {
    const url =
      typeof args[0] === "string"
        ? args[0]
        : args[0] instanceof URL
        ? args[0].toString()
        : (args[0] as Request).url;
    const method = (
      (args[1] as RequestInit | undefined)?.method ||
      (args[0] instanceof Request ? args[0].method : undefined) ||
      "GET"
    ).toUpperCase();

    // Skip internal telemetry calls to avoid infinite loops
    const headers = (args[1] as RequestInit | undefined)?.headers;
    const isInternal =
      headers instanceof Headers
        ? headers.get("x-telemetry-internal") === "1"
        : typeof headers === "object" && headers !== null
        ? (headers as Record<string, string>)["x-telemetry-internal"] === "1"
        : false;
    if (isInternal) return origFetch(...args);

    const start = performance.now();
    const traceId = newTraceId();
    capture("net.fetch.start", { url, method, traceId });
    try {
      const res = await origFetch(...args);
      capture("net.fetch.end", {
        url,
        method,
        traceId,
        status: res.status,
        duration: performance.now() - start,
      });
      return res;
    } catch (err) {
      capture("net.fetch.error", {
        url,
        method,
        traceId,
        error: String(err),
        duration: performance.now() - start,
      });
      throw err;
    }
  };
}

function installXHRCapture(): void {
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null
  ) {
    (this as XMLHttpRequest & { _tel?: Record<string, unknown> })._tel = {
      method: method.toUpperCase(),
      url: String(url),
      traceId: newTraceId(),
    };
    return origOpen.call(this, method, url, async ?? true, user, password);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const self = this as XMLHttpRequest & { _tel?: Record<string, unknown> };
    if (self._tel) {
      const start = performance.now();
      capture("net.xhr.start", self._tel);
      this.addEventListener("loadend", () => {
        capture("net.xhr.end", {
          ...self._tel,
          status: this.status,
          duration: performance.now() - start,
        });
      });
    }
    return origSend.call(this, body);
  };
}

function installErrorCapture(): void {
  window.onerror = (message, source, lineno, colno, error) => {
    capture("js.error", {
      message: String(message),
      source,
      lineno,
      colno,
      stack: error?.stack,
    });
  };

  window.onunhandledrejection = (e: PromiseRejectionEvent) => {
    capture("js.unhandledRejection", {
      reason: String(e.reason),
      stack: e.reason instanceof Error ? e.reason.stack : undefined,
    });
  };
}

function installWebVitals(): void {
  // web-vitals v5 removed onFID (replaced by onINP)
  import("web-vitals").then(({ onCLS, onFCP, onLCP, onINP, onTTFB }) => {
    onCLS((m) => capture("web-vitals.CLS", { value: m.value, rating: m.rating }));
    onFCP((m) => capture("web-vitals.FCP", { value: m.value, rating: m.rating }));
    onLCP((m) => capture("web-vitals.LCP", { value: m.value, rating: m.rating }));
    onINP((m) => capture("web-vitals.INP", { value: m.value, rating: m.rating }));
    onTTFB((m) => capture("web-vitals.TTFB", { value: m.value, rating: m.rating }));
  }).catch(() => {
    // web-vitals load failure is non-critical
  });
}

function installScrollTracking(): void {
  window.addEventListener(
    "scroll",
    () => {
      const scrolled = window.scrollY + window.innerHeight;
      const total = document.documentElement.scrollHeight;
      const pct = Math.round((scrolled / total) * 100);
      if (pct > maxScrollPct) {
        maxScrollPct = pct;
      }
    },
    { passive: true }
  );
}

function installVisibilityTracking(): void {
  pageEnterTime = Date.now();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      capture("page.hidden", {
        url: location.pathname,
        timeOnPageMs: Date.now() - pageEnterTime,
        maxScrollPct,
      });
    } else {
      pageEnterTime = Date.now();
    }
  });

  window.addEventListener("focus", () => {
    capture("window.focus", { url: location.pathname });
  });

  window.addEventListener("blur", () => {
    capture("window.blur", { url: location.pathname });
  });

  window.addEventListener("pagehide", () => {
    capture("page.exit", {
      url: location.pathname,
      timeOnPageMs: Date.now() - pageEnterTime,
      maxScrollPct,
    });
  });
}

export function start(): void {
  if (typeof window === "undefined") return;
  if (initialized) return;
  initialized = true;

  installClickCapture();
  patchHistory();
  installFetchCapture();
  installXHRCapture();
  installErrorCapture();
  installWebVitals();
  installScrollTracking();
  installVisibilityTracking();

  capture("session.start", {
    url: location.pathname,
    referrer: document.referrer,
    userAgent: navigator.userAgent,
  });
}
