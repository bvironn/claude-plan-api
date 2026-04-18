import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Each test runs in an isolated tmp CWD so `src/ui/dist/` resolution lands in
// a sandbox we control. serveStatic resolves its dist root relative to
// process.cwd() lazily on first call, so we re-import the module in each
// test via `require.cache`-style invalidation? No — the module caches
// `distRoot` after the first call. Instead we rely on the fact that
// `distRoot` is computed on each call when null, and we reset it by
// clearing the module's internal cache. The simplest path: fresh
// `process.chdir` AND a fresh dynamic import per test.

let originalCwd: string
let tmpDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tmpDir = mkdtempSync(join(tmpdir(), "claude-plan-api-static-"))
  process.chdir(tmpDir)
})

afterEach(() => {
  process.chdir(originalCwd)
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

// Helper: write a believable dist tree into the current CWD.
function seedDist(opts: { indexHtml?: string; assets?: Record<string, string> } = {}) {
  const dist = join(tmpDir, "src", "ui", "dist")
  mkdirSync(join(dist, "assets"), { recursive: true })
  writeFileSync(
    join(dist, "index.html"),
    opts.indexHtml ?? "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  )
  for (const [name, body] of Object.entries(opts.assets ?? {})) {
    writeFileSync(join(dist, "assets", name), body)
  }
}

// Static module reads process.cwd() on every call so we can use a single
// import; no cache-busting needed.
import * as staticMod from "../src/http/static"

async function freshImport() {
  return staticMod
}

// ---------------------------------------------------------------------------
// serveStatic
// ---------------------------------------------------------------------------

describe("serveStatic — file resolution and headers", () => {
  it("REQ-1: GET / returns 200 with index.html body and no-cache", async () => {
    seedDist({ indexHtml: "<!doctype html>HELLO" })
    const { serveStatic } = await freshImport()

    const res = await serveStatic("/")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(res!.headers.get("content-type")).toContain("text/html")
    expect(res!.headers.get("cache-control")).toBe("no-cache")
    const body = await res!.text()
    expect(body).toContain("HELLO")
  })

  it("REQ-2: GET /assets/*.js returns 200 with text/javascript and immutable cache", async () => {
    seedDist({
      assets: { "app-abc123.js": "console.log('ok')" },
    })
    const { serveStatic } = await freshImport()

    const res = await serveStatic("/assets/app-abc123.js")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(res!.headers.get("content-type")).toContain("text/javascript")
    expect(res!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    const body = await res!.text()
    expect(body).toBe("console.log('ok')")
  })

  it("REQ-3: GET /assets/*.css returns text/css", async () => {
    seedDist({
      assets: { "app.css": "body{color:red}" },
    })
    const { serveStatic } = await freshImport()

    const res = await serveStatic("/assets/app.css")
    expect(res!.status).toBe(200)
    expect(res!.headers.get("content-type")).toContain("text/css")
  })

  it("REQ-4: GET /assets/*.woff2 returns font/woff2", async () => {
    seedDist({
      assets: { "geist.woff2": "fake-font-bytes" },
    })
    const { serveStatic } = await freshImport()

    const res = await serveStatic("/assets/geist.woff2")
    expect(res!.status).toBe(200)
    expect(res!.headers.get("content-type")).toBe("font/woff2")
  })

  it("REQ-5: GET /r/anything returns null (caller SPA-fallbacks)", async () => {
    seedDist()
    const { serveStatic } = await freshImport()

    // serveStatic only owns `/` and `/assets/*`. Client-side routes must
    // return null so the caller knows to SPA-fallback.
    expect(await serveStatic("/r/some-trace-id")).toBeNull()
    expect(await serveStatic("/live")).toBeNull()
    expect(await serveStatic("/metrics")).toBeNull()
  })

  it("REQ-6: GET /assets/<missing> returns 404 JSON (never SPA-fallback)", async () => {
    seedDist()
    const { serveStatic } = await freshImport()

    const res = await serveStatic("/assets/does-not-exist.js")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(404)
    expect(res!.headers.get("content-type")).toContain("application/json")
    const body = (await res!.json()) as { error: { message: string } }
    expect(body.error.message).toContain("Not found")
  })

  it("REQ-7: GET / when dist missing returns 503 with build hint", async () => {
    // No seedDist() call → no dist/ at all
    const { serveStatic } = await freshImport()

    const res = await serveStatic("/")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(503)
    const body = (await res!.json()) as { error: { message: string } }
    expect(body.error.message).toContain("bun run build")
  })

  it("REQ-8: path traversal guard — /assets/../etc/passwd returns null", async () => {
    seedDist()
    const { serveStatic } = await freshImport()

    // join("dist", "../etc/passwd") resolves to a path OUTSIDE dist; the
    // guard should refuse and return null rather than serving arbitrary fs.
    const res = await serveStatic("/assets/../../../etc/passwd")
    expect(res).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// serveSpaFallback
// ---------------------------------------------------------------------------

describe("serveSpaFallback — html for client routes", () => {
  it("REQ-9: returns dist/index.html with 200 and no-cache", async () => {
    seedDist({ indexHtml: "<!doctype html>SPA-SHELL" })
    const { serveSpaFallback } = await freshImport()

    const res = await serveSpaFallback()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("cache-control")).toBe("no-cache")
    const body = await res.text()
    expect(body).toContain("SPA-SHELL")
  })

  it("REQ-10: returns 503 when dist/index.html is missing", async () => {
    const { serveSpaFallback } = await freshImport()

    const res = await serveSpaFallback()
    expect(res.status).toBe(503)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("bun run build")
  })
})
