#!/usr/bin/env bash
# Copy a working `.env` into this repository's GitHub Actions configuration.
#
# The operational loop should live in the cloud, not in a shell. Getting there
# means the values that already work on a laptop have to exist in Actions too,
# and retyping eight of them into a web form is exactly the kind of task that
# introduces a typo you then spend an evening finding.
#
# The rule this follows, and the reason it is not just `cat .env | gh secret`:
#
#   **The locator is a variable. The credential is a secret.**
#
# A bucket name, an endpoint, a project URL — those are not credentials, and
# masking them turns a configuration mistake into an unreadable log. Keys are
# secrets. Anything not named below is left alone entirely, because a `.env` is
# a working file and may hold things that have no business leaving the machine.
#
# Dry run by default. Nothing is written without `--apply`, and no secret value
# is ever printed — only its length, which is enough to spot a truncated paste.
#
#   ./scripts/sync-github-config.sh            # show what would change
#   ./scripts/sync-github-config.sh --apply    # do it
#
# Needs the GitHub CLI (`gh auth login`). Run it from the repository root.

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Locators: not credentials, and visible in logs on purpose.
VARIABLES=(
  S3_BUCKET
  S3_ENDPOINT
  S3_REGION
  SUPABASE_URL
  TOWNCIVIC_BASE_URL
  TOWNCIVIC_SECURE_COOKIES
)

# Credentials. SUPABASE_ANON_KEY is a secret here even though it is designed to
# be public: it is safe in a browser bundle, but there is no reason to publish
# it in the logs of a public repository either.
SECRETS=(
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY
  SUPABASE_ANON_KEY
  TOWNCIVIC_SESSION_SECRET
)

red() { printf '\033[31m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

command -v gh >/dev/null 2>&1 || {
  red "This needs the GitHub CLI. https://cli.github.com — then \`gh auth login\`."
  exit 1
}
gh auth status >/dev/null 2>&1 || {
  red "gh is installed but not signed in. Run \`gh auth login\`."
  exit 1
}
[ -f "$ENV_FILE" ] || {
  red "No $ENV_FILE here. Copy .env.example to .env and fill it in first."
  exit 1
}

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Repository: $REPO"
echo "Source:     $ENV_FILE"
[ "$APPLY" -eq 1 ] && echo "Mode:       apply" || echo "Mode:       dry run (pass --apply to write)"
echo

# Read one key's value out of the env file.
#
# Deliberately not `source`: this file is written to be read by Node, may
# contain values this script has no business executing, and sourcing it would
# also drag every unrelated line into scope. The last assignment wins, matching
# how a dotenv reader behaves.
read_value() {
  local key="$1" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -1 || true)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  # Strip one layer of matching quotes, the way dotenv readers do.
  case "$value" in
    \"*\") value="${value%\"}"; value="${value#\"}" ;;
    \'*\') value="${value%\'}"; value="${value#\'}" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

planned=0
skipped=()

sync_one() {
  local kind="$1" key="$2" value
  if ! value="$(read_value "$key")"; then
    skipped+=("$key")
    return 0
  fi

  planned=$((planned + 1))
  if [ "$kind" = "variable" ]; then
    # Locators are printed in full: seeing the wrong endpoint here is the whole
    # point of the dry run.
    printf '  variable  %-26s %s\n' "$key" "$value"
    [ "$APPLY" -eq 1 ] && gh variable set "$key" --body "$value" >/dev/null
  else
    printf '  secret    %-26s %s\n' "$key" "$(printf '%*s' "${#value}" '' | tr ' ' '*') (${#value} chars)"
    [ "$APPLY" -eq 1 ] && gh secret set "$key" --body "$value" >/dev/null
  fi
  return 0
}

for key in "${VARIABLES[@]}"; do sync_one variable "$key"; done
for key in "${SECRETS[@]}"; do sync_one secret "$key"; done

echo
if [ "${#skipped[@]}" -gt 0 ]; then
  dim "Not set in $ENV_FILE, so left alone: ${skipped[*]}"
fi

# Everything in the file that this script deliberately does not touch. Worth
# naming: a `.env` is a working file, and silently uploading whatever happens to
# be in it is how a credential ends up somewhere nobody meant to put it.
unknown="$(grep -oE '^[[:space:]]*[A-Z_][A-Z0-9_]*=' "$ENV_FILE" 2>/dev/null | tr -d ' =' | sort -u |
  grep -vxE "$(printf '%s|' "${VARIABLES[@]}" "${SECRETS[@]}" | sed 's/|$//')" || true)"
if [ -n "$unknown" ]; then
  dim "In $ENV_FILE but not synced (not part of the Actions contract):"
  dim "  $(echo "$unknown" | tr '\n' ' ')"
fi

echo
if [ "$APPLY" -eq 1 ]; then
  echo "Done. $planned value(s) written."
  echo "Now run it: gh workflow run Preflight   (or Actions → Preflight → Run workflow)"
else
  echo "Dry run; nothing written. $planned value(s) would be set."
  echo "Re-run with --apply to write them."
fi
