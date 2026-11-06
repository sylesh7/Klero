#!/usr/bin/env bash
# Stops every ForkOS dev process (leaves postgres running; add --db to stop it too).
cd "$(dirname "$0")/.."
pkill -f 'facilitator/src/index.ts' 2>/dev/null
pkill -f 'provider/src/index.ts' 2>/dev/null
pkill -f 'api/src/index.ts' 2>/dev/null
pkill -f 'dev:scribe' 2>/dev/null
echo "stopped facilitator, providers, api"
if [ "${1:-}" = "--db" ]; then docker compose down >/dev/null 2>&1 && echo "stopped postgres"; fi
