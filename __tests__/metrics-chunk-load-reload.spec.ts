import { describe, it, expect } from "bun:test";
import { isChunkLoadError } from "../src/ui/src/lib/chunk-load-error.ts";

// ---------------------------------------------------------------------------
// RESIL-003 — React 19's `lazy()` permanently caches a rejected dynamic
// import. Once `import("@/components/metrics/metrics-charts")` in
// src/ui/src/routes/metrics.tsx fails once (e.g. a stale chunk hash after a
// redeploy), every subsequent render throws the SAME cached rejection. The
// route's existing soft retry (`reset()` + `router.invalidate()`, see
// RouteError) does not create a new `lazy()` reference and cannot recover —
// only a full page reload re-evaluates the module graph fresh.
//
// `isChunkLoadError` is the pure decision function the metrics route's error
// boundary uses to tell "this needs a hard reload" apart from any other
// error, which must still go through the existing soft-retry path. It is
// exercised directly here with real Error objects (not just source-text
// assertions) since that is the part of the fix with real behavioral risk.
//
// The message patterns match what Vite/browsers document for this failure —
// see Vite's `vite:preloadError` guide (docs/guide/build.md): "Failed to
// fetch dynamically imported module" is the canonical wrapped-error message.
//
// Wiring (which component is used as errorComponent, that it calls
// window.location.reload(), and that it still falls back to the shared
// RouteError for non-chunk-load errors) is asserted via source-text guards,
// following this repo's DOM-free __tests__/ convention (no React render
// harness is set up — see dashboard-performance.spec.ts).
// ---------------------------------------------------------------------------

describe("isChunkLoadError — chunk-load failure detection (RESIL-003)", () => {
  it("detects the browser/Vite dynamic-import fetch-failure message", () => {
    const err = new Error(
      "Failed to fetch dynamically imported module: https://example.com/assets/metrics-charts-abc123.js"
    );
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("detects Firefox's 'error loading dynamically imported module' variant", () => {
    const err = new Error("error loading dynamically imported module: https://example.com/y.js");
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("detects the 'importing a module script failed' variant", () => {
    const err = new Error("Importing a module script failed.");
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("does not misclassify an unrelated runtime error as a chunk-load failure", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(
      false
    );
    expect(isChunkLoadError(new TypeError("Network request failed"))).toBe(false);
    expect(isChunkLoadError(new Error("Unexpected token < in JSON at position 0"))).toBe(false);
  });

  it("is false for non-Error values (never throws on unexpected input)", () => {
    expect(isChunkLoadError("just a string")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: "Failed to fetch dynamically imported module" })).toBe(false);
  });
});

describe("metrics route wires a chunk-load-aware error boundary (RESIL-003)", () => {
  it("metrics.tsx uses MetricsRouteError (not the shared soft-retry-only RouteError) as its errorComponent", async () => {
    const source = await Bun.file(
      new URL("../src/ui/src/routes/metrics.tsx", import.meta.url)
    ).text();
    expect(source).toContain("MetricsRouteError");
    expect(source).toMatch(/errorComponent:\s*MetricsRouteError/);
  });

  it("MetricsRouteError hard-reloads for a chunk-load failure and otherwise defers to RouteError's soft retry", async () => {
    const source = await Bun.file(
      new URL("../src/ui/src/components/layout/metrics-route-error.tsx", import.meta.url)
    ).text();
    expect(source).toContain("isChunkLoadError");
    expect(source).toContain("window.location.reload()");
    // Non-chunk-load errors still render the shared RouteError unchanged —
    // its own reset()+invalidate() soft retry is untouched by this fix.
    expect(source).toMatch(/<RouteError\s+error={error}\s+reset={reset}\s*\/>/);
  });
});
