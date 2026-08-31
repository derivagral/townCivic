#!/usr/bin/env bash
# Push the runtime configuration from `.env` into a Fly app.
#
# The sibling of `sync-github-config.sh`, and deliberately built on the same
# allowlist so the two cannot describe different deployments. Fly has no
# variable/secret split the way Actions does — `fly secrets` is the only
# mechanism — but the non-credentials are already in `fly.toml` under `[env]`,
# where they are readable, so this only sends the credentials.
#
# Dry run by default. No secret value is printed, only its length.
#
#   ./scripts/setup-fly.sh              # show what would be set
#   ./scripts/setup-fly.sh --apply      # do it
#
# Needs flyctl (`fly auth login`) and an app that already exists
# (`fly apps create towncivic`). Run from the repository root.

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
APP="${FLY_APP:-$(grep -E '^app *= *' fly.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Only the credentials. Everything else is in fly.toml's [env], on purpose:
# a locator buried in `fly secrets` is a locator nobody can read back.
SECRETS=(
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY
  S3_BUCKET
  S3_ENDPOINT
  SUPABASE_URL
  SUPABASE_ANON_KEY
  TOWNCIVIC_SESSION_SECRET
)

red() { printf '\033[31m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

command -v flyctl >/dev/null 2>&1 || { red "This needs flyctl. https://fly.io/docs/flyctl/install/"; exit 1; }
[ -f "$ENV_FILE" ] || { red "No $ENV_FILE here. Copy .env.example to .env first."; exit 1; }
[ -n "$APP" ] || { red "Could not read the app name from fly.toml. Set FLY_APP."; exit 1; }

echo "Fly app:  $APP"
echo "Source:   $ENV_FILE"
[ "$APPLY" -eq 1 ] && echo "Mode:     apply" || echo "Mode:     dry run (pass --apply to write)"
echo

read_value() {
  local key="$1" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -1 || true)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  case "$value" in
    \"*\") value="${value%\"}"; value="${value#\"}" ;;
    \'*\') value="${value%\'}"; value="${value#\'}" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

args=()
missing=()
for key in "${SECRETS[@]}"; do
  if value="$(read_value "$key")"; then
    printf '  %-26s %s\n' "$key" "$(printf '%*s' "${#value}" '' | tr ' ' '*') (${#value} chars)"
    args+=("$key=$value")
  else
    missing+=("$key")
  fi
done

echo
[ "${#missing[@]}" -gt 0 ] && dim "Not set in $ENV_FILE: ${missing[*]}"

# One `fly secrets set` for all of them: each call restarts the machines, and
# seven restarts to set seven values is a needlessly exciting way to deploy.
if [ "$APPLY" -eq 1 ]; then
  flyctl secrets set --app "$APP" "${args[@]}"
  echo
  echo "Set. Machines restart with the new values."
  echo "Then: fly deploy   (or let .github/workflows/deploy.yml do it)"
else
  echo "Dry run; nothing written. ${#args[@]} secret(s) would be set in one call."
  echo "Re-run with --apply."
fi
