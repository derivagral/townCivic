#!/usr/bin/env bash
# Deploy to Fly from a laptop, in the order the deploy actually requires.
#
# This exists because `fly deploy` on its own fails in a way that does not
# explain itself:
#
#   COPY data/towncivic.db ./data/towncivic.db
#   failed to compute cache key: "/data/towncivic.db": not found
#
# `data/` is gitignored, so a fresh clone — or Fly building from a GitHub branch
# — has no database at all, and the Dockerfile requires one on purpose: an image
# that shipped without it would come up healthy, pass its checks and serve an
# empty archive. The failure is right; the message is Docker's and cannot be
# improved from inside the Dockerfile. So the ordering lives here instead.
#
#   ./scripts/deploy-fly.sh              # preflight, pull the snapshot, deploy
#   ./scripts/deploy-fly.sh --skip-pull  # use the database already in data/
#
# `.github/workflows/deploy.yml` does exactly the same three steps. This is for
# when you want to watch it happen.

set -euo pipefail

SKIP_PULL=0
[ "${1:-}" = "--skip-pull" ] && SKIP_PULL=1

red() { printf '\033[31m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

command -v flyctl >/dev/null 2>&1 || {
  red "This needs flyctl. https://fly.io/docs/flyctl/install/"
  exit 1
}

APP="$(grep -E '^app *= *' fly.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')"

# `fly deploy` does not create an app, and `fly launch` would rewrite fly.toml
# with a generated one — losing every setting and comment in it. So check, and
# say which command to run rather than letting flyctl suggest the wrong one.
if ! flyctl status --app "$APP" >/dev/null 2>&1; then
  red "No Fly app called \"$APP\"."
  echo "  Create it first:  fly apps create $APP"
  echo "  Then the secrets: ./scripts/setup-fly.sh --apply"
  echo
  dim "  Do not use \`fly launch\` — it regenerates fly.toml and discards this one."
  exit 1
fi

step "1/4  Preflight"
# The same gate deploy.yml uses. A machine that starts, serves every public
# record and cannot sign anybody in looks exactly like a healthy one.
npm run preflight

if [ "$SKIP_PULL" -eq 1 ]; then
  step "2/4  Using the database already in data/"
  [ -f data/towncivic.db ] || { red "There is no data/towncivic.db to use."; exit 1; }
  ls -lh data/towncivic.db
else
  step "2/4  Fetching the published database"
  # Fails clearly when nothing has been published yet, which is the other half
  # of the confusing Docker error: the snapshot has to exist before a deploy can
  # bake it. `npm run snapshot` from wherever the pipeline last ran publishes one.
  npm run --silent snapshot -- --pull
fi

step "3/4  Deploying"
flyctl deploy --remote-only --wait-timeout 300

step "4/4  Verifying"
URL="$(grep -E 'TOWNCIVIC_BASE_URL *= *' fly.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')"
URL="${URL:-https://$APP.fly.dev}"
curl -fsS "$URL/healthz" && echo
dim "  If \"accounts\" above is not \"supabase\", the machine came up against the"
dim "  wrong configuration — check \`fly secrets list --app $APP\`."
