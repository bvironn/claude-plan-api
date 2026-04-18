/**
 * Static asset serving for the built UI at `src/ui/dist/`.
 *
 * The gateway serves the UI from the same origin and port as the API so
 * the SPA can hit same-origin `/api/*` and `/v1/*` without CORS. Call
 * `serveStatic` from the HTTP router BEFORE the final 404 branch.
 *
 * Path handling:
 *   - GET /                 → dist/index.html
 *   - GET /assets/<file>    → dist/assets/<file>  (immutable cache)
 *   - SPA fallback          → dist/index.html     (for client-side routes)
 *
 * Missing-build behaviour: if `dist/index.html` does not exist, serveStatic
 * returns a 503 JSON response with a clear "run bun run build" message for
 * the `/` and SPA-fallback paths. Asset requests that miss return 404.
 */

import { join } from "node:path"

// MIME map by extension. Extensible — keep to the handful that matter for a
// Vite-built bundle. Unknown extensions fall back to octet-stream so nothing
// accidentally gets inline-rendered as text.
const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
}

// Resolve the dist root from the current working directory on every call.
// The service runs from the repo root (systemd `WorkingDirectory=`), and in
// tests we swap `process.cwd()` per-spec to isolate fixtures. Cost of one
// `path.join()` per request is negligible.
function getDistRoot(): string {
  return join(process.cwd(), "src", "ui", "dist")
}

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot === -1) return "application/octet-stream"
  const ext = path.slice(dot).toLowerCase()
  return MIME[ext] ?? "application/octet-stream"
}

function cacheControlFor(urlPath: string): string {
  // Hash-based Vite assets never change for a given filename → aggressive immutable cache.
  // The index.html bootstrap must always revalidate so a new deploy is seen immediately.
  if (urlPath.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable"
  }
  return "no-cache"
}

/**
 * Serve a file under `src/ui/dist/` matching `urlPath`. Returns:
 *   - a 200 Response with the file if the path resolves within dist/
 *   - a 503 Response if the build output is missing (only for html-serving paths)
 *   - null if the path does not correspond to a real file (caller decides how to respond)
 *
 * `urlPath` must be the URL pathname (with a leading slash). The function
 * prevents directory traversal by resolving the absolute path and asserting
 * it stays under `distRoot`.
 */
export async function serveStatic(urlPath: string): Promise<Response | null> {
  const root = getDistRoot()
  const indexPath = join(root, "index.html")

  // Map the URL to a filesystem path relative to dist/.
  //   /          → dist/index.html
  //   /assets/x  → dist/assets/x
  //   /r/:id     → null here; caller decides whether to SPA-fallback
  let relative: string
  if (urlPath === "/" || urlPath === "") {
    relative = "index.html"
  } else if (urlPath.startsWith("/assets/")) {
    relative = urlPath.slice(1) // drop leading slash
  } else {
    // Not an asset and not root → caller should handle (SPA fallback or 404)
    return null
  }

  // Defensive path-traversal guard: absolute resolved path must start with root.
  const filePath = join(root, relative)
  if (!filePath.startsWith(root)) {
    return null
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    // Asset miss returns 404 directly so the caller doesn't SPA-fallback
    // binary requests that should 404 (e.g. /assets/missing.js).
    if (urlPath.startsWith("/assets/")) {
      return new Response(
        JSON.stringify({ error: { message: `Not found: ${urlPath}` } }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    // Root path miss → the build hasn't been produced. Explicit 503 with a
    // clear operator-facing message so the fix is obvious.
    if (urlPath === "/" || urlPath === "") {
      const buildMissing = !(await Bun.file(indexPath).exists())
      if (buildMissing) {
        return new Response(
          JSON.stringify({
            error: {
              message: "UI not built. Run: cd src/ui && bun run build",
              code: 503,
            },
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        )
      }
    }

    return null
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": cacheControlFor(urlPath),
    },
  })
}

/**
 * SPA fallback: serve `dist/index.html` for any GET path that is not an API
 * route and is not a real static asset. TanStack Router on the client handles
 * the actual route mapping. Returns 503 if the build is missing.
 */
export async function serveSpaFallback(): Promise<Response> {
  const root = getDistRoot()
  const indexPath = join(root, "index.html")
  const index = Bun.file(indexPath)

  if (!(await index.exists())) {
    return new Response(
      JSON.stringify({
        error: {
          message: "UI not built. Run: cd src/ui && bun run build",
          code: 503,
        },
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    )
  }

  return new Response(index, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  })
}
