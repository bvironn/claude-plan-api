#!/usr/bin/env bash
#
# Wrapper for create-api-key.ts that loads the PRODUCTION environment (secrets +
# TELEMETRY_DB_PATH) before minting a key, so the key lands in the SAME database
# the running service uses — not a stray logs/telemetry.db.
#
# Why this exists: create-api-key.ts resolves the DB path from TELEMETRY_DB_PATH
# and the pepper from API_KEY_PEPPER. Run in a plain shell those are unset, so
# the CLI silently writes to logs/telemetry.db while the service reads
# /var/lib/claude-plan-api/telemetry.db — the new key never authenticates.
#
# Usage:
#   scripts/create-api-key.sh [--admin] <label>
#
# Env:
#   CLAUDE_PLAN_API_ENV   override the env file (default: /etc/claude-plan-api/env)
#
set -euo pipefail

ENV_FILE="${CLAUDE_PLAN_API_ENV:-/etc/claude-plan-api/env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "warning: env file '$ENV_FILE' not found — using the current shell environment" >&2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/create-api-key.ts" "$@"
