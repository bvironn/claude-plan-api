# Deployment

Production runs on the host under systemd, behind Traefik (Dokploy), and
redeploys itself when `master` moves.

| File | Installed as |
|------|--------------|
| `systemd/claude-plan-api.service` | `/etc/systemd/system/` — the gateway (`EnvironmentFile=/etc/claude-plan-api/env`) |
| `systemd/claude-plan-api-deploy.service` + `.timer` | `/etc/systemd/system/` — runs `auto-deploy.sh` every minute |
| `auto-deploy.sh` | used in place from the checkout |

## How a deploy works

`auto-deploy.sh` fetches `origin/master`. When it moved (fast-forward only, and
no tracked file modified locally) it:

1. resets the checkout to the new commit;
2. runs `bun install --frozen-lockfile` if `package.json`/`bun.lock` changed;
3. rebuilds the dashboard into `src/ui/dist.next` and swaps it in, if `src/ui`
   changed — a failed build never leaves a half-written `dist/`;
4. restarts `claude-plan-api` and polls `/health` for 30s.

If any step fails it rolls back to the previous commit (same steps) and records
the failed commit in `/var/lib/claude-plan-api/deploy-failed-commit`; that
commit is skipped until a newer one lands on `master`, so a broken push is not
retried every minute.

Pull-based on purpose: no inbound webhook port and no server credentials stored
on GitHub. Worst-case latency is about a minute.

```sh
journalctl -u claude-plan-api-deploy -f      # deploy log
systemctl list-timers claude-plan-api-deploy # next run
systemctl start claude-plan-api-deploy       # deploy now
```

## First install

```sh
cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-plan-api claude-plan-api-deploy.timer
```

The public route lives in `/etc/dokploy/traefik/dynamic/claude-plan-api.yml`
(Host `api.geomakes.es` → `http://172.18.0.1:3456`, Let's Encrypt). The gateway
binds to the `docker_gwbridge` address so only Traefik and the host can reach
it; the host firewall allows `172.18.0.0/16` → `172.18.0.1:3456`.
