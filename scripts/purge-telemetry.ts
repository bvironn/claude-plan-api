#!/usr/bin/env bun
/**
 * Hot-purge telemetry.db while the API keeps running.
 *
 * Usage:
 *   bun scripts/purge-telemetry.ts [keepHours]
 *
 * Default keepHours = 1 (keep only the last hour of data).
 *
 * Safe because SQLite WAL mode allows a second writer to take the write
 * lock briefly. The API will see slightly slower writes during VACUUM
 * (it serializes against an exclusive lock at the end) but won't crash.
 */
import { Database } from "bun:sqlite";

const keepHours = Number(process.argv[2] ?? 1);
const dbPath = "logs/telemetry.db";

console.log(`[purge] opening ${dbPath} — will keep last ${keepHours}h of data`);

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 30000;"); // wait up to 30s for write lock

const cutoff = new Date(Date.now() - keepHours * 60 * 60 * 1000).toISOString();
console.log(`[purge] cutoff: ${cutoff}`);

const sizeBefore = (await Bun.file(dbPath).size) / 1024 / 1024 / 1024;
console.log(`[purge] db size before: ${sizeBefore.toFixed(2)} GB`);

const t0 = performance.now();
const ev = db.prepare("DELETE FROM events WHERE timestamp < ?").run(cutoff);
const rq = db.prepare("DELETE FROM requests WHERE timestamp < ?").run(cutoff);
console.log(`[purge] deleted: ${ev.changes} events, ${rq.changes} requests in ${(performance.now() - t0).toFixed(0)}ms`);

console.log("[purge] running VACUUM (may take a few minutes)…");
const tv = performance.now();
db.exec("VACUUM");
console.log(`[purge] VACUUM done in ${((performance.now() - tv) / 1000).toFixed(1)}s`);

db.close();

const sizeAfter = (await Bun.file(dbPath).size) / 1024 / 1024 / 1024;
console.log(`[purge] db size after: ${sizeAfter.toFixed(2)} GB (freed ${(sizeBefore - sizeAfter).toFixed(2)} GB)`);
