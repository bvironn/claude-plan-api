/**
 * Content-negotiated response compression (spec `http-compression`, design
 * decision #1).
 *
 * A single tail gate `maybeCompress(req, res)` runs in `handleRequest` AFTER
 * `enforceApiKey` and route dispatch, so it can never bypass auth or alter
 * route matching. Exclusion is DECLARATIVE — the gate compresses only when ALL
 * of these hold:
 *
 *   1. the response has no existing `Content-Encoding` (never double-encode),
 *   2. the response is not a download/attachment (`Content-Disposition`) — those
 *      are streamed exports and MUST stay unbuffered, and
 *   3. the base `Content-Type` is in the text-like allowlist.
 *
 * Server-Sent-Events (`text/event-stream`) and CSV exports (`text/csv`) are
 * excluded by omission from the allowlist; the streaming JSON export is excluded
 * by its `Content-Disposition`. Fonts and images are already compressed and are
 * excluded by omission.
 *
 * Encoding preference is brotli → gzip → identity, driven by the request
 * `Accept-Encoding`. Any negotiable response sets `Vary: Accept-Encoding` so
 * shared caches key on that header, even when identity is chosen. Compression
 * uses only runtime builtins: `node:zlib` (brotli) and `Bun.gzipSync` (gzip).
 */

import { brotliCompressSync } from "node:zlib";
import { emit } from "../observability/logger.ts";

/**
 * Base (parameter-stripped) content types eligible for compression. Text-like
 * payloads only — never fonts or images, which are already compressed. Notably
 * ABSENT: `text/event-stream` (SSE) and `text/csv` (export), which must never
 * be compressed.
 */
const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/javascript",
  "text/html",
  "text/javascript",
  "text/css",
  "text/plain",
  "image/svg+xml",
]);

type Encoding = "br" | "gzip" | "identity";

/** Pick the strongest supported encoding the client advertises (br > gzip). */
function negotiateEncoding(acceptEncoding: string | null): Encoding {
  if (!acceptEncoding) return "identity";
  const tokens = acceptEncoding
    .toLowerCase()
    .split(",")
    .map((t) => t.trim().split(";")[0]!.trim());
  if (tokens.includes("br")) return "br";
  if (tokens.includes("gzip")) return "gzip";
  return "identity";
}

/** The `Content-Type` with any `; charset=…` parameter stripped, lowercased. */
function baseContentType(res: Response): string {
  const ct = res.headers.get("Content-Type");
  if (!ct) return "";
  return ct.split(";")[0]!.trim().toLowerCase();
}

/**
 * Whether the response is subject to encoding negotiation at all. Header-only —
 * it never touches the body, so a live/streamed response is never drained here.
 */
function isNegotiable(res: Response): boolean {
  if (res.headers.get("Content-Encoding")) return false; // already encoded
  if (res.headers.get("Content-Disposition")) return false; // download / streamed export
  return COMPRESSIBLE_TYPES.has(baseContentType(res));
}

/** Add `Accept-Encoding` to `Vary`, preserving any existing Vary tokens. */
function addVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", "Accept-Encoding");
    return;
  }
  const parts = existing.split(",").map((s) => s.trim());
  if (parts.some((p) => p.toLowerCase() === "accept-encoding")) return;
  headers.set("Vary", `${existing}, Accept-Encoding`);
}

/**
 * Compress `res` in place when eligible, returning either a new compressed
 * `Response` or the original `res` untouched. Buffered eligible bodies are read
 * fully into memory and re-emitted; excluded (SSE / export / already-encoded /
 * non-allowlisted) responses are returned by reference so their streams are
 * never buffered.
 */
export async function maybeCompress(req: Request, res: Response): Promise<Response> {
  if (!isNegotiable(res)) return res;

  const encoding = negotiateEncoding(req.headers.get("Accept-Encoding"));

  // Negotiable but nothing acceptable offered → identity. Still Vary so shared
  // caches don't serve this body to a client that DID ask for compression.
  if (encoding === "identity") {
    addVaryAcceptEncoding(res.headers);
    return res;
  }

  // Eligible + buffered: read the in-memory body and compress it. `isNegotiable`
  // already excluded streaming/attachment responses, so this never drains a
  // live stream.
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    // Body read itself failed — nothing recoverable to fall back to, but a
    // compression-layer failure must never mask itself as a 500. Surface the
    // original (now-drained) response rather than throwing.
    emit("warn", "http.compression.failed", {
      encoding,
      stage: "read",
      error: (err as Error).message,
    });
    return res;
  }

  // A compression failure (e.g. a corrupt buffer edge case in the native
  // brotli/gzip bindings) must never discard an already-successful upstream
  // response. Fall back to the original, uncompressed bytes instead of
  // letting the error propagate up into `handleRequest`'s outer catch, which
  // would turn a valid 200 into a generic 500.
  try {
    const compressed = encoding === "br" ? brotliCompressSync(raw) : Bun.gzipSync(raw);

    const headers = new Headers(res.headers);
    headers.set("Content-Encoding", encoding);
    addVaryAcceptEncoding(headers);
    // Stale for the compressed buffer — Bun recomputes Content-Length on send.
    headers.delete("Content-Length");

    return new Response(compressed, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (err) {
    emit("warn", "http.compression.failed", {
      encoding,
      stage: "compress",
      error: (err as Error).message,
    });
    // res.body was already drained by arrayBuffer() above, so reconstruct
    // the original uncompressed response from the bytes we already read
    // rather than returning the now-empty `res`.
    return new Response(raw, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
}
