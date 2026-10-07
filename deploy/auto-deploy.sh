#!/usr/bin/env bash
#
# Pull-based continuous deployment. Run every minute by
# claude-plan-api-deploy.timer: when origin/master moved, fast-forward,
# install dependencies, rebuild the dashboard if it changed, restart the
# service and health-check it. Any failure rolls back to the previous commit.
#
# Pull-based on purpose: no inbound webhook port, no server credentials stored
# on GitHub. Logs: journalctl -u claude-plan-api-deploy
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/claude-plan-api}"
SERVICE="${SERVICE:-claude-plan-api}"
BRANCH="${BRANCH:-master}"
ENV_FILE="${CLAUDE_PLAN_API_ENV:-/etc/claude-plan-api/env}"
# Last commit that failed to deploy: skipped until master moves past it, so a
# broken push is not retried (and the service bounced) every minute.
FAILED_FILE="${FAILED_FILE:-/var/lib/${SERVICE}/deploy-failed-commit}"
export PATH="/root/.bun/bin:$PATH"

cd "$REPO_DIR"

# One deploy at a time.
exec 9>"/run/${SERVICE}-deploy.lock"
flock -n 9 || exit 0

git fetch --quiet origin "$BRANCH"
PREV=$(git rev-parse HEAD)
NEXT=$(git rev-parse "origin/$BRANCH")
[[ "$PREV" == "$NEXT" ]] && exit 0
[[ -f "$FAILED_FILE" && "$(cat "$FAILED_FILE")" == "$NEXT" ]] && exit 0

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "refusing to deploy: tracked files modified in $REPO_DIR" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$PREV" "$NEXT"; then
  echo "refusing to deploy: $NEXT is not a fast-forward of $PREV" >&2
  exit 1
fi

PORT=3456 BIND_HOST=127.0.0.1
[[ -f "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }
HEALTH_URL="http://${BIND_HOST}:${PORT}/health"

changed() { git diff --quiet "$1" "$2" -- "${@:3}" && return 1 || return 0; }

build_ui() {
  (
    cd src/ui
    bun install --frozen-lockfile
    bunx tsr generate
    bunx tsc -b
    rm -rf dist.next
    bunx vite build --outDir dist.next --emptyOutDir
  )
  rm -rf src/ui/dist.prev
  [[ -d src/ui/dist ]] && mv src/ui/dist src/ui/dist.prev
  mv src/ui/dist.next src/ui/dist
  rm -rf src/ui/dist.prev
}

# Bring the tree to $2 coming from $1: deps, dashboard, restart, health.
apply() {
  local from=$1 to=$2
  git reset --quiet --hard "$to"
  if changed "$from" "$to" package.json bun.lock; then bun install --frozen-lockfile; fi
  if changed "$from" "$to" src/ui || [[ ! -f src/ui/dist/index.html ]]; then build_ui; fi
  systemctl restart "$SERVICE"
  for _ in $(seq 1 30); do
    sleep 1
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1 && return 0
  done
  echo "health check failed: $HEALTH_URL" >&2
  return 1
}

echo "deploying $PREV -> $NEXT ($(git log -1 --format=%s "$NEXT"))"
if apply "$PREV" "$NEXT"; then
  echo "deployed $NEXT"
  rm -f "$FAILED_FILE"
  exit 0
fi

echo "deploy of $NEXT failed, rolling back to $PREV" >&2
mkdir -p "$(dirname "$FAILED_FILE")"
echo "$NEXT" > "$FAILED_FILE"
# Force a dashboard rebuild on rollback only if the failed deploy touched it.
if apply "$NEXT" "$PREV"; then
  echo "rolled back to $PREV" >&2
else
  echo "ROLLBACK FAILED: $SERVICE may be down" >&2
fi
exit 1
