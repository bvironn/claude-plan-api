import { test, expect, afterEach } from "bun:test";
import { getTelemetryDbPath } from "../src/config.ts";

// getTelemetryDbPath is the SINGLE source of truth for where the telemetry/keys
// SQLite store lives. Both the server (initStorage) and the CLI scripts
// (create-api-key, purge-telemetry) MUST resolve the path through it, otherwise
// a CLI run in a plain shell writes to a different DB than the running service
// (the split-brain that made a freshly-created key never authenticate).

const prev = Bun.env.TELEMETRY_DB_PATH;
afterEach(() => {
  if (prev === undefined) delete (Bun.env as Record<string, string | undefined>).TELEMETRY_DB_PATH;
  else Bun.env.TELEMETRY_DB_PATH = prev;
});

test("returns TELEMETRY_DB_PATH verbatim when set", () => {
  Bun.env.TELEMETRY_DB_PATH = "/var/lib/claude-plan-api/telemetry.db";
  expect(getTelemetryDbPath()).toBe("/var/lib/claude-plan-api/telemetry.db");
});

test("falls back to logs/telemetry.db when unset or blank", () => {
  delete (Bun.env as Record<string, string | undefined>).TELEMETRY_DB_PATH;
  expect(getTelemetryDbPath()).toBe("logs/telemetry.db");
  Bun.env.TELEMETRY_DB_PATH = "   ";
  expect(getTelemetryDbPath()).toBe("logs/telemetry.db");
});
