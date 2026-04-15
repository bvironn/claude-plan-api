import { emit } from "./logger.ts";

function isLoggerSelfFailure(err: Error | undefined): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  const stack = err.stack ?? "";
  // EPIPE/EBADF on pino's own streams must not be re-logged via emit(),
  // otherwise the failure cascades into an infinite uncaughtException loop.
  if (msg.includes("EPIPE") || msg.includes("EBADF")) return true;
  if (stack.includes("pino/lib/multistream") || stack.includes("pino-roll")) return true;
  return false;
}

export function installGlobalHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    if (isLoggerSelfFailure(reason as Error)) {
      process.stderr.write(`[uncaught-suppressed:rejection] ${(reason as Error)?.message}\n`);
      return;
    }
    emit("fatal", "process.unhandledRejection", {
      reason: String(reason),
      stack: (reason as Error)?.stack,
    });
  });

  process.on("uncaughtException", (err: Error) => {
    if (isLoggerSelfFailure(err)) {
      process.stderr.write(`[uncaught-suppressed:exception] ${err.message}\n`);
      return;
    }
    emit("fatal", "process.uncaughtException", {
      error: err.message,
      stack: err.stack,
    });
  });

  process.on("SIGTERM", () => {
    emit("info", "process.shutdown", { signal: "SIGTERM" });
  });

  process.on("SIGINT", () => {
    emit("info", "process.shutdown", { signal: "SIGINT" });
  });
}
