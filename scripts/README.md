# scripts/

Operational scripts for `claude-plan-api`.

| Script | Purpose |
|--------|---------|
| `create-api-key.sh` | **Use this in production.** Wrapper that loads the prod env (`/etc/claude-plan-api/env`) then runs `create-api-key.ts`, so the key lands in the service's database. |
| `create-api-key.ts` | Issue a new API key (stores only the digest). Resolves the DB via `TELEMETRY_DB_PATH`. |
| `purge-telemetry.ts` | Hot-purge the telemetry store while the API keeps running (WAL-safe). Resolves the DB via `TELEMETRY_DB_PATH`. |
| `bare-thinking-test.ts` | Ad-hoc upstream "thinking" probe. |

## ⚠️ Which database do the scripts write to?

`create-api-key.ts` and `purge-telemetry.ts` open the store returned by
`getTelemetryDbPath()` — `TELEMETRY_DB_PATH` if set, else `logs/telemetry.db`.
The systemd service sets `TELEMETRY_DB_PATH=/var/lib/claude-plan-api/telemetry.db`,
so a CLI run in a **plain shell** (where that var is unset) would write to a
DIFFERENT database and the new key would never authenticate.

**In production always create keys via the wrapper**, which loads the same env
the service uses:

```sh
# admin key = the ONLY way to grant dashboard (/api/*) access
scripts/create-api-key.sh --admin <label>
```

To run any other script against the production store, load the env first:

```sh
set -a; . /etc/claude-plan-api/env; set +a
bun scripts/purge-telemetry.ts [keepHours]
```

## ⚠️ Log/telemetry safety while the service is live

**NEVER run `rm` on files under `logs/` while `claude-plan-api.service` is running** — it silently orphans the running process's open file descriptors (writes continue but become permanently unrecoverable once the process restarts). Use `scripts/purge-telemetry.ts` to clear telemetry data safely while the service is live.

**Never run a second ad-hoc `bun src/index.ts` / `bun run start` process against the same `logs/` directory as the live systemd service** — pino-roll's log rotation state is per-process and a second instance will unlink files the first instance is actively writing to.

### Safe telemetry purge

```sh
bun scripts/purge-telemetry.ts [keepHours]   # default keepHours = 1
```

Runs a `DELETE` + `VACUUM` under WAL so the live API only sees briefly slower
writes (never a crash).
