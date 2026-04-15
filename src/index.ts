import { readCredentials, ensureValidToken } from "./domain/credentials.ts";
import { startServer } from "./http/server.ts";
import { emit } from "./observability/logger.ts";
import { installGlobalHandlers } from "./observability/globals.ts";
import { initStorage } from "./observability/storage.ts";

installGlobalHandlers();
initStorage();
readCredentials();
const server = startServer();
emit("info", "app.started", { port: server.port });
setInterval(
  () => ensureValidToken().catch((err) => emit("error", "credentials.backgroundRefresh.failed", { error: String(err) })),
  60_000
);
