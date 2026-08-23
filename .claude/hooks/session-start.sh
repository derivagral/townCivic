#!/bin/bash
# Prepare a fresh checkout so tests, typecheck and the linter work immediately.
#
# Runs on session start in Claude Code on the web, where the container is a
# clean clone with no node_modules. Idempotent and non-interactive.
set -euo pipefail

# Only needed in the remote environment; a local checkout manages its own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# `npm install` rather than `npm ci`: the container image is cached after this
# hook completes, and install reuses an existing node_modules instead of
# deleting and refetching it on every session.
npm install --no-audit --no-fund
