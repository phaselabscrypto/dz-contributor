#!/usr/bin/env bash
#
# queue-clear.sh — clear the dz-shapley what-if Redis work queue.
#
# All async-job state lives under the `shapley:whatif:*` keyspace:
#   …:stream          STREAM   the work queue (consumer group `whatif-workers`)
#   …:dead            STREAM   dead-letter (poison / max-deliveries)
#   …:state:{id}      HASH     per-job state + progress
#   …:payload:{id}    STRING   the SimulateRequest (TTL'd)
#   …:result:{hash}   STRING   idempotency result cache (TTL'd)
#   …:cancel:{id}     STRING   cancel flag (TTL'd)
#
# Modes (exactly one required):
#   --surgical   Drop QUEUED + PENDING (PEL) entries and recreate the consumer
#                group in place — stops the backlog and any stuck/duplicate
#                reclaim entries WITHOUT bouncing the worker. Keeps result cache,
#                job state, and the dead-letter stream. The safer choice.
#   --nuke       DELETE the entire `shapley:whatif:*` keyspace (stream, group,
#                state, payloads, results, cancel, dead-letter). Total wipe.
#                ⚠ Requires a WORKER RESTART afterwards — the consumer group is
#                gone until the worker's startup `ensure_group` recreates it,
#                else its XREADGROUP loops on NOGROUP.
#
# Options:
#   --cancel-running   First request cancellation of every job in state=running
#                      (stops in-flight *sampling* solves via the worker bridge;
#                      exact ≤10-operator solves aren't interruptible).
#   --dry-run          Print what would happen; change nothing.
#   --force            Skip the --nuke confirmation prompt.
#   -h | --help        This help.
#
# Connection (defaults target the dev docker-compose Redis):
#   REDIS_URL=redis://:pass@host:port   preferred (e.g. prod / TLS) — overrides below
#   REDIS_HOST  (default 127.0.0.1)
#   REDIS_PORT  (default 6390)
#   REDIS_PASS  (default devpass; set empty for no auth)
#
# Examples:
#   scripts/queue-clear.sh --surgical
#   scripts/queue-clear.sh --nuke --cancel-running --force
#   REDIS_URL=redis://:<password>@redis.example.com:6379 scripts/queue-clear.sh --surgical
#
set -euo pipefail

STREAM="shapley:whatif:stream"
GROUP="whatif-workers"
PATTERN="shapley:whatif:*"

MODE=""
CANCEL_RUNNING=0
DRY_RUN=0
FORCE=0

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^#\{0,1\} \{0,1\}//; s/^set -euo.*//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --surgical) MODE="surgical" ;;
    --nuke) MODE="nuke" ;;
    --cancel-running) CANCEL_RUNNING=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  echo "error: choose a mode — --surgical or --nuke (see --help)" >&2
  exit 2
fi

# ── Build the redis-cli invocation ──────────────────────────────────────────
RC=(redis-cli)
if [ -n "${REDIS_URL:-}" ]; then
  RC+=(-u "$REDIS_URL")
  CONN_DESC="$REDIS_URL"
else
  HOST="${REDIS_HOST:-127.0.0.1}"
  PORT="${REDIS_PORT:-6390}"
  PASS="${REDIS_PASS-devpass}" # `-` default: unset → devpass; explicitly empty → no auth
  RC+=(-h "$HOST" -p "$PORT")
  [ -n "$PASS" ] && RC+=(-a "$PASS" --no-auth-warning)
  CONN_DESC="$HOST:$PORT"
fi

rc() { "${RC[@]}" "$@"; }

# Fail fast if Redis isn't reachable.
if ! rc PING >/dev/null 2>&1; then
  echo "error: cannot reach Redis at ${CONN_DESC} (is the dev compose up? \`docker compose up -d\`)" >&2
  exit 1
fi

counts() {
  local depth dead states
  depth=$(rc XLEN "$STREAM" 2>/dev/null || echo 0)
  dead=$(rc XLEN "shapley:whatif:dead" 2>/dev/null || echo 0)
  states=$(rc --scan --pattern 'shapley:whatif:state:*' 2>/dev/null | grep -c . || true)
  echo "  queued=${depth:-0}  dead-letter=${dead:-0}  job-states=${states:-0}"
  echo "  pending(PEL):"
  rc XPENDING "$STREAM" "$GROUP" 2>/dev/null | sed 's/^/    /' || echo "    (no group)"
}

run() {
  # Echo every mutating command; execute unless --dry-run.
  echo "  + $*"
  if [ "$DRY_RUN" -eq 0 ]; then "${RC[@]}" "$@" >/dev/null 2>&1 || true; fi
}

echo "redis: ${CONN_DESC}   mode: ${MODE}$([ "$DRY_RUN" -eq 1 ] && echo '  (dry-run)')"
echo "── before ──"; counts

# ── Cancel in-flight running jobs (optional) ────────────────────────────────
if [ "$CANCEL_RUNNING" -eq 1 ]; then
  echo "── cancel-running ──"
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    state=$(rc HGET "$key" state 2>/dev/null || true)
    if [ "$state" = "running" ]; then
      id="${key##*:}"
      run SET "shapley:whatif:cancel:${id}" 1 EX 600
    fi
  done < <(rc --scan --pattern 'shapley:whatif:state:*' 2>/dev/null || true)
fi

# ── Clear ───────────────────────────────────────────────────────────────────
case "$MODE" in
  surgical)
    echo "── surgical clear (queued + PEL; keeps results/state/dead-letter) ──"
    run XTRIM "$STREAM" MAXLEN 0                       # drop queued entries
    run XGROUP DESTROY "$STREAM" "$GROUP"              # drop the pending-entries list
    run XGROUP CREATE "$STREAM" "$GROUP" '$' MKSTREAM  # recreate at the tail
    ;;
  nuke)
    if [ "$FORCE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
      printf "⚠ delete ALL %s keys at %s? worker restart required after. [y/N] " "$PATTERN" "$CONN_DESC"
      read -r ans
      case "$ans" in [yY]*) ;; *) echo "aborted."; exit 0 ;; esac
    fi
    echo "── nuke (delete every ${PATTERN} key) ──"
    keys=$(rc --scan --pattern "$PATTERN" 2>/dev/null || true)
    if [ -n "$keys" ]; then
      n=$(printf '%s\n' "$keys" | grep -c .)
      echo "  + del ${n} keys"
      if [ "$DRY_RUN" -eq 0 ]; then printf '%s\n' "$keys" | xargs "${RC[@]}" del >/dev/null; fi
    else
      echo "  (no matching keys)"
    fi
    echo "  ⚠ restart the worker so it recreates the consumer group:"
    echo "      docker compose restart >/dev/null  # (Redis only) then re-run: cargo run -- worker"
    ;;
esac

echo "── after ──"; counts
echo "done."
