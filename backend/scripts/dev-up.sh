#!/usr/bin/env bash
# Brings the whole ForkOS backend up: postgres, facilitator, 3 providers, api.
# Logs go to .logs/<service>.log. Stop everything with: scripts/dev-down.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p .logs

say() { printf '\033[1m%s\033[0m\n' "$*"; }
wait_for() { # wait_for <url> <name> <tries>
  for _ in $(seq 1 "${3:-60}"); do curl -s --max-time 2 "$1" >/dev/null 2>&1 && { echo "  ok   $2"; return 0; }; sleep 1; done
  echo "  FAIL $2 (see .logs/$2.log)"; return 1
}

say "1/4 postgres"
docker compose up -d db >/dev/null 2>&1
for _ in $(seq 1 30); do docker compose exec -T db pg_isready -U forkos >/dev/null 2>&1 && break; sleep 1; done
echo "  ok   postgres :5442"
pnpm db:migrate 2>&1 | grep -E 'applied|skip' | sed 's/^/  /'

say "2/4 facilitator"
nohup pnpm dev:facilitator > .logs/facilitator.log 2>&1 &
wait_for http://localhost:4020/health facilitator

say "3/4 providers"
for p in a b premium; do
  nohup pnpm "dev:scribe-$p" > ".logs/scribe-$p.log" 2>&1 &
  sleep 12
done
wait_for http://localhost:4031/health scribe-a
wait_for http://localhost:4032/health scribe-b
wait_for http://localhost:4033/health scribe-premium

say "4/4 api"
nohup pnpm dev:api > .logs/api.log 2>&1 &
wait_for http://localhost:4040/v1/health api

say ""
say "ForkOS is up."
echo "  facilitator  http://localhost:4020"
echo "  scribe-a/b/p http://localhost:4031 / :4032 / :4033"
echo "  api          http://localhost:4040   <- frontend uses this"
echo "  logs         backend/.logs/*.log"
echo ""
echo "Next:  pnpm --filter @forkos/agents link \"Agent A\"   (approve on your phone)"
