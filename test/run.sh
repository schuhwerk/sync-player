#!/usr/bin/env bash
# Browser suite: installs Playwright into test/node_modules on first run
# (gitignored), then hands off to test/run.mjs, which spawns its own PHP
# servers + WAV fixtures and drives headless Chromium. Exit 0 on success.
# SyncPlayer unit scenarios run separately via `bun test`.
#
#   bash test/run.sh
#
# Requires: php 8+, node 18+, npm (for the one-time playwright install).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$ROOT/test"

if [[ ! -d "$TEST_DIR/node_modules/playwright" ]]; then
    echo "→ installing playwright into test/node_modules (first run only)…"
    npm install --prefix "$TEST_DIR" --no-audit --no-fund --silent
    "$TEST_DIR/node_modules/.bin/playwright" install chromium >/dev/null
fi

exec node "$TEST_DIR/run.mjs"
