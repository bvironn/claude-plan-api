/**
 * Best-effort cross-process single-flight lock for OAuth token refreshes.
 *
 * Refresh tokens rotate: when two processes sharing one credentials file
 * refresh at once, the loser holds a dead token and the endpoint answers the
 * pile-up with 429. An advisory lock file lets one gateway process refresh
 * while the others wait and adopt its freshly written token. Ported from the
 * upstream plugin (#264).
 *
 * Any filesystem error degrades to refreshing without a lock, and a crashed
 * holder cannot wedge anything: the lock has a TTL and a stale one is taken
 * over.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { emit } from "../observability/logger.ts";

export const DEFAULT_LOCK_TTL_MS = (() => {
  const parsed = Number.parseInt(Bun.env.REFRESH_LOCK_TTL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
})();

export interface RefreshLock {
  release(): void;
}

export interface AcquireOptions {
  dir?: string;
  ttlMs?: number;
  now?: () => number;
}

function defaultLockDir(): string {
  // Read at call time so tests can redirect it.
  return Bun.env.REFRESH_LOCK_DIR ?? join(homedir(), ".local", "share", "claude-plan-api");
}

function lockPathFor(key: string, dir: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(dir, `refresh-${digest}.lock`);
}

const NOOP_LOCK: RefreshLock = { release() {} };

/**
 * Try to acquire the refresh lock for `key` (the credentials path). Returns a
 * lock when this process may refresh (won it, or the filesystem failed and we
 * degrade), or null when a live holder owns it — the caller should wait and
 * adopt the holder's result instead.
 */
export function acquireRefreshLock(key: string, opts: AcquireOptions = {}): RefreshLock | null {
  const dir = opts.dir ?? defaultLockDir();
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const now = opts.now ?? Date.now;
  const path = lockPathFor(key, dir);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // openSync below surfaces a real problem.
  }

  // Two attempts: the second only runs after clearing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        emit("warn", "credentials.lock.error", { error: String(code ?? err) });
        return NOOP_LOCK;
      }
      let stale = false;
      try {
        stale = now() - statSync(path).mtimeMs > ttlMs;
      } catch {
        // Vanished between open and stat — retry the acquire.
        stale = true;
      }
      if (stale) {
        emit("warn", "credentials.lock.staleTakeover", {});
        try {
          unlinkSync(path);
        } catch {
          // Lost the race to remove it; the next attempt settles it.
        }
        continue;
      }
      return null;
    }

    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: now() }));
    } catch {
      // Held regardless of whether the payload wrote.
    }
    return {
      release() {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        try {
          unlinkSync(path);
        } catch {
          // already gone (stale takeover)
        }
      },
    };
  }

  return null;
}
