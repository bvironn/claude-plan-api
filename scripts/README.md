# scripts/

Operational scripts for `claude-plan-api`.

| Script | Purpose |
|--------|---------|
| `purge-telemetry.ts` | Hot-purge `logs/telemetry.db` while the API keeps running (WAL-safe). |
| `create-api-key.ts` | Issue a new API key (stores only the digest). |
| `bare-thinking-test.ts` | Ad-hoc upstream "thinking" probe. |

## ⚠️ Log/telemetry safety while the service is live

**NEVER run `rm` on files under `logs/` while `claude-plan-api.service` is running** — it silently orphans the running process's open file descriptors (writes continue but become permanently unrecoverable once the process restarts). Use `scripts/purge-telemetry.ts` to clear telemetry data safely while the service is live.

**Never run a second ad-hoc `bun src/index.ts` / `bun run start` process against the same `logs/` directory as the live systemd service** — pino-roll's log rotation state is per-process and a second instance will unlink files the first instance is actively writing to.

### Safe telemetry purge

```sh
bun scripts/purge-telemetry.ts [keepHours]   # default keepHours = 1
```

Runs a `DELETE` + `VACUUM` under WAL so the live API only sees briefly slower
writes (never a crash).
