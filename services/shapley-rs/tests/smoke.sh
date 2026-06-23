#!/usr/bin/env bash
# Smoke test for dz-shapley-service.
#
# Usage:
#   ./tests/smoke.sh                       # tests against http://localhost:8080
#   ./tests/smoke.sh https://your-url      # tests against deployed service
#
# Exits non-zero on the first failure. Designed to be safe to run in CI.

set -euo pipefail

BASE="${1:-http://localhost:8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { red "missing: $1"; exit 2; }
}
require curl
require jq

# Tolerance: 1% — upstream solver versions may differ slightly.
TOL="${TOL:-0.01}"

# 1) /health
yellow "[1/5] GET $BASE/health"
HEALTH=$(curl -fsS "$BASE/health")
echo "$HEALTH" | jq -e '.status == "ok"' >/dev/null
green "    ok"

# 2) /shapley with upstream simple example
yellow "[2/5] POST $BASE/shapley (simple example)"
RESP=$(curl -fsS -X POST "$BASE/shapley" \
  -H 'content-type: application/json' \
  --data-binary @"$ROOT/tests/fixtures/simple.json")

ALPHA=$(echo "$RESP" | jq -r '.values.Alpha.value // 0')
BETA=$(echo "$RESP"  | jq -r '.values.Beta.value  // 0')
echo "    alpha = $ALPHA"
echo "    beta  = $BETA"

# Upstream README expected (network-shapley-rs#main, simple example):
#   Alpha = 173.67559751778526   (proportion 0.6701709)
#   Beta  =  85.47560036995537   (proportion 0.3298291)
EXPECTED_ALPHA=173.67559751778526
EXPECTED_BETA=85.47560036995537

within() {
  python3 -c "
import sys
a, b, tol = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
denom = max(abs(b), 1e-9)
diff = abs(a - b) / denom
sys.exit(0 if diff <= tol else 1)
" "$1" "$2" "$3"
}

if within "$ALPHA" "$EXPECTED_ALPHA" "$TOL"; then
  green "    alpha within ${TOL} of upstream expected ($EXPECTED_ALPHA)"
else
  red   "    alpha = $ALPHA, expected ~$EXPECTED_ALPHA"
  exit 1
fi
if within "$BETA" "$EXPECTED_BETA" "$TOL"; then
  green "    beta  within ${TOL} of upstream expected ($EXPECTED_BETA)"
else
  red   "    beta = $BETA, expected ~$EXPECTED_BETA"
  exit 1
fi

# 3) /link-estimate with Alpha as focus
yellow "[3/5] POST $BASE/link-estimate (focus=Alpha)"
LE_BODY=$(jq '{ input: ., operator_focus: "Alpha" }' "$ROOT/tests/fixtures/simple.json")
LE_RESP=$(curl -fsS -X POST "$BASE/link-estimate" \
  -H 'content-type: application/json' \
  --data-binary "$LE_BODY")
echo "$LE_RESP" | jq -e '.method == "retag-shapley-rs"' >/dev/null
LINKS=$(echo "$LE_RESP" | jq -r '.links | length')
echo "    links scored: $LINKS"
test "$LINKS" -ge 1 || { red "expected >= 1 link"; exit 1; }

# 4) /shapley with three-operator scenario (structural correctness)
yellow "[4/5] POST $BASE/shapley (three-operator fixture)"
TO_RESP=$(curl -fsS -X POST "$BASE/shapley" \
  -H 'content-type: application/json' \
  --data-binary @"$ROOT/tests/fixtures/three-operator.json")

ALPHA3=$(echo "$TO_RESP" | jq -r '.values.Alpha.value // 0')
BETA3=$(echo  "$TO_RESP" | jq -r '.values.Beta.value  // 0')
GAMMA3=$(echo "$TO_RESP" | jq -r '.values.Gamma.value // 0')
echo "    alpha = $ALPHA3"
echo "    beta  = $BETA3"
echo "    gamma = $GAMMA3"

# Structural assertion: all three operators present and non-negative,
# and Alpha (NYC + LON ingress dominance) outranks Gamma (AMS sink only).
python3 -c "
import sys
a, b, g = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
assert a >= 0 and b >= 0 and g >= 0, f'negative value: a={a} b={b} g={g}'
assert a + b + g > 0, 'all zero'
assert a >= g, f'expected alpha ({a}) >= gamma ({g})'
" "$ALPHA3" "$BETA3" "$GAMMA3" \
  || { red "    structural check failed"; exit 1; }
green "    three-operator structural checks passed"

# 5) Round-trip latency budget — total < 30s on cold-start, < 5s warm.
yellow "[5/5] Latency check"
START=$(date +%s%N)
curl -fsS "$BASE/health" >/dev/null
END=$(date +%s%N)
MS=$(( (END - START) / 1000000 ))
echo "    /health round-trip: ${MS}ms"
test "$MS" -le 5000 || yellow "    warning: ${MS}ms > 5s warm budget"

green ""
green "All checks passed against $BASE"
