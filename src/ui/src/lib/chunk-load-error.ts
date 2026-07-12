/**
 * Message patterns browsers and Vite's preload helper throw when a dynamic
 * `import()` fails to fetch its chunk — most commonly a stale chunk hash
 * after a redeploy, where the previously-built asset no longer exists on the
 * server. These are not a guess: Vite's own `vite:preloadError` window event
 * (see the "Load Error Handling" section of Vite's build guide) wraps exactly
 * this class of error, and "Failed to fetch dynamically imported module" is
 * the canonical Chromium/V8 message; Firefox's wording differs slightly.
 */
const CHUNK_LOAD_ERROR_PATTERN =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

/**
 * Detect whether `error` is a dynamic-import / chunk-load failure. React 19's
 * `lazy()` permanently caches a REJECTED promise, so retrying the SAME
 * `lazy()` reference (a soft `reset()`) can never recover from this — only a
 * full page reload re-evaluates the module graph against the new chunk
 * manifest. See RESIL-003.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_LOAD_ERROR_PATTERN.test(error.message);
}
