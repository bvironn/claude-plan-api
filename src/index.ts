import { readCredentials, ensureValidToken } from "./domain/credentials.ts";
import { refreshRegistry } from "./domain/models.ts";
import { startServer } from "./http/server.ts";
import { emit } from "./observability/logger.ts";
import { installGlobalHandlers } from "./observability/globals.ts";
import { initStorage } from "./observability/storage.ts";

installGlobalHandlers();
initStorage();
readCredentials();
const server = startServer();
emit("info", "app.started", { port: server.port });

// Eager-bootstrap the model registry in the background so the very first
// POST /v1/chat/completions after boot rarely sees an empty cache (which
// would force `resolveModel` to pass unknown claude-* ids through to
// upstream via the warn-log branch — still correct, but suboptimal).
// Fire-and-forget: refreshRegistry() already logs its own failures via
// `models.registry.refresh.fallback`, so the outer .catch only silences
// the unhandled-rejection noise.
refreshRegistry().catch(() => {});
const tokenRefreshInterval = setInterval(
  () => ensureValidToken().catch((err) => emit("error", "credentials.backgroundRefresh.failed", { error: String(err) })),
  60_000
);

// Graceful shutdown: stop accepting new connections, give in-flight requests
// up to 5 seconds to complete, then force-close. Prevents systemd from waiting
// the default 90s TimeoutStopSec when restarting the service.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  emit("info", "process.shutdown.start", { signal });
  clearInterval(tokenRefreshInterval);
  const forceTimer = setTimeout(() => {
    emit("warn", "process.shutdown.forceClose", { signal });
    server.stop(true);
    process.exit(0);
  }, 5_000);
  try {
    await server.stop();
    clearTimeout(forceTimer);
    emit("info", "process.shutdown.complete", { signal });
    process.exit(0);
  } catch (err) {
    clearTimeout(forceTimer);
    emit("error", "process.shutdown.error", { signal, error: String(err) });
    process.exit(1);
  }
};
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
