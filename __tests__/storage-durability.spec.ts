import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initStorage,
  closeStorage,
  insertApiKey,
  listApiKeys,
} from "../src/observability/storage.ts";

// Durability regression tests for the WAL-persistence bug: in WAL journal mode,
// committed rows live in the `-wal` sidecar until a checkpoint folds them into
// the main `.db` file. The app never closed the DB on shutdown, so the durable
// file stayed near-empty and all data depended on the transient `-wal`/`-shm`
// files surviving — a redeploy that cleans the gitignored `logs/` dir, or any
// backup/copy of just `telemetry.db`, wiped everything.

const tmpDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cpa-durability-"));
  tmpDirs.push(dir);
  return join(dir, "telemetry.db");
}

const KEY = {
  prefix: "aaaa1111",
  key_hash: "hash-durability-1",
  label: "durability",
  created_at: "2026-01-01T00:00:00Z",
  is_admin: 0,
} as const;

afterEach(() => {
  // Return the module to an isolated in-memory DB so later suites are unaffected.
  initStorage(":memory:");
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("storage durability — WAL is checkpointed into the durable file", () => {
  it("closeStorage folds the WAL in so data survives loss of the -wal/-shm sidecars", () => {
    const dbPath = tempDbPath();
    initStorage(dbPath);
    insertApiKey({ ...KEY });

    // Graceful shutdown MUST checkpoint the WAL into the durable file.
    closeStorage();

    // Simulate a redeploy / `git clean` that removes the transient sidecars.
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });

    // Reopening only the main `.db` file must still show the row.
    initStorage(dbPath);
    expect(listApiKeys().map((k) => k.prefix)).toEqual(["aaaa1111"]);
  });

  it("a copy of the main .db is empty before a checkpoint but populated after closeStorage (reproduces the loss)", () => {
    const dbPath = tempDbPath();
    initStorage(dbPath);
    insertApiKey({ ...KEY });

    // Before any checkpoint: a deploy/backup that grabs only telemetry.db sees
    // nothing — in WAL mode even the CREATE TABLE lives in the -wal sidecar, so
    // the durable file has not one row and not even the schema yet.
    const beforeCopy = dbPath + ".before";
    copyFileSync(dbPath, beforeCopy);
    const before = new Database(beforeCopy, { readonly: true });
    const schemaRows = before
      .query("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='api_keys'")
      .get() as { c: number };
    expect(schemaRows.c).toBe(0);
    before.close();

    // After a graceful close: the durable file itself carries the data.
    closeStorage();
    const afterCopy = dbPath + ".after";
    copyFileSync(dbPath, afterCopy);
    const after = new Database(afterCopy, { readonly: true });
    expect((after.query("SELECT count(*) AS c FROM api_keys").get() as { c: number }).c).toBe(1);
    after.close();
  });

  it("initStorage honours TELEMETRY_DB_PATH so the store can live outside the deploy tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "cpa-envpath-"));
    tmpDirs.push(dir);
    const envPath = join(dir, "state", "telemetry.db");
    const prev = Bun.env.TELEMETRY_DB_PATH;
    Bun.env.TELEMETRY_DB_PATH = envPath;
    try {
      // Called with no argument, exactly as src/index.ts does at boot.
      initStorage();
      insertApiKey({ ...KEY });
      closeStorage();
      // The DB was created at the env-provided absolute path, not logs/telemetry.db.
      const reopened = new Database(envPath, { readonly: true });
      expect((reopened.query("SELECT count(*) AS c FROM api_keys").get() as { c: number }).c).toBe(1);
      reopened.close();
    } finally {
      if (prev === undefined) delete (Bun.env as Record<string, string | undefined>).TELEMETRY_DB_PATH;
      else Bun.env.TELEMETRY_DB_PATH = prev;
    }
  });
});
