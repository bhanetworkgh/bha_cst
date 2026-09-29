#!/usr/bin/env bash
# ==============================================================================
# CST Admin Dashboard → vFarm Live E2E (API layer)
#
# Exercises the same /api/v1/admin/vfarm/* routes the Admin UI tab "7 · vFarm Live E2E" uses.
# Requires a running CST server with VFARM_FARM_KEY configured.
#
# Usage:
#   CST_BASE_URL=http://localhost:3000 \
#   CST_ADMIN_EMAIL=admin@example.com \
#   CST_ADMIN_PASSWORD=secret \
#   ./scripts/verify_admin_vfarm_e2e.sh
#
# Optional:
#   VFARM_LIVE_FARM_ID=21dde23e-f7f6-46bc-9b54-e97fabaaafd7
# ==============================================================================

set -o pipefail

GREEN="\033[1;32m"
RED="\033[1;31m"
CYAN="\033[1;36m"
BOLD="\033[1m"
RESET="\033[0m"

CST_BASE_URL="${CST_BASE_URL:-http://localhost:3000}"
CST_BASE_URL="${CST_BASE_URL%/}"
VFARM_LIVE_FARM_ID="${VFARM_LIVE_FARM_ID:-21dde23e-f7f6-46bc-9b54-e97fabaaafd7}"

PASSED=0
FAILED=0

record() {
  local ok="$1"
  local name="$2"
  local detail="$3"
  if [ "$ok" = "1" ]; then
    PASSED=$((PASSED + 1))
    echo -e "  ${GREEN}PASS${RESET}  ${BOLD}${name}${RESET} — ${detail}"
  else
    FAILED=$((FAILED + 1))
    echo -e "  ${RED}FAIL${RESET}  ${BOLD}${name}${RESET} — ${detail}"
  fi
}

echo -e "${BOLD}${CYAN}CST Admin vFarm E2E${RESET}"
echo -e " Server: ${CST_BASE_URL}"
echo -e " Farm:   ${VFARM_LIVE_FARM_ID}\n"

if [ -z "$CST_ADMIN_EMAIL" ] || [ -z "$CST_ADMIN_PASSWORD" ]; then
  echo -e "${RED}Set CST_ADMIN_EMAIL and CST_ADMIN_PASSWORD (or use DB-backed admin login).${RESET}"
  exit 1
fi

LOGIN_RESP=$(curl -s -w "\n%{http_code}" -X POST "${CST_BASE_URL}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${CST_ADMIN_EMAIL}\",\"password\":\"${CST_ADMIN_PASSWORD}\"}")
LOGIN_BODY=$(echo "$LOGIN_RESP" | sed '$d')
LOGIN_CODE=$(echo "$LOGIN_RESP" | tail -n 1)
TOKEN=$(echo "$LOGIN_BODY" | grep -o '"token": *"[^"]*"' | head -n1 | cut -d '"' -f4)

if [ "$LOGIN_CODE" != "200" ] || [ -z "$TOKEN" ]; then
  echo -e "${RED}Admin login failed (HTTP ${LOGIN_CODE})${RESET}"
  echo "$LOGIN_BODY"
  exit 1
fi
echo -e "${GREEN}Admin session OK${RESET}\n"

admin_get() {
  local path="$1"
  curl -s -w "\n%{http_code}" -H "X-Admin-Token: ${TOKEN}" -H "Accept: application/json" "${CST_BASE_URL}${path}"
}

check_get() {
  local section="$1"
  local path="$2"
  local resp body code
  resp=$(admin_get "$path")
  body=$(echo "$resp" | sed '$d')
  code=$(echo "$resp" | tail -n 1)
  if [ "$code" = "200" ]; then
    record 1 "$section" "HTTP 200 — ${body:0:120}..."
  else
    record 0 "$section" "HTTP ${code} — ${body:0:200}"
  fi
}

echo -e "${BOLD}▶ Section checks${RESET}"
check_get "Dashboard" "/api/v1/admin/vfarm/dashboard?farm_id=${VFARM_LIVE_FARM_ID}"
check_get "Farms" "/api/v1/admin/vfarm/farms"
check_get "Devices" "/api/v1/admin/vfarm/devices?farm_id=${VFARM_LIVE_FARM_ID}"

DEV_RESP=$(admin_get "/api/v1/admin/vfarm/devices?farm_id=${VFARM_LIVE_FARM_ID}")
DEV_BODY=$(echo "$DEV_RESP" | sed '$d')
DEVICE_ID=$(echo "$DEV_BODY" | grep -o '"id": *"[^"]*"' | head -n1 | cut -d '"' -f4)

if [ -n "$DEVICE_ID" ]; then
  check_get "Telemetry (farm latest)" "/api/v1/admin/vfarm/readings/latest?farm_id=${VFARM_LIVE_FARM_ID}&limit=5"
  check_get "Telemetry (sensor latest)" "/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=${DEVICE_ID}"
  check_get "Telemetry (history)" "/api/v1/admin/vfarm/readings?sensor_id=${DEVICE_ID}&limit=5"
  check_get "Telemetry (stats)" "/api/v1/admin/vfarm/readings/stats?sensor_id=${DEVICE_ID}&window=24h"
else
  record 1 "Telemetry" "Skipped per-sensor (0 devices on farm)"
fi

check_get "Alerts (counts)" "/api/v1/admin/vfarm/alerts/counts?farm_id=${VFARM_LIVE_FARM_ID}"
check_get "Alerts (open)" "/api/v1/admin/vfarm/alerts/open?farm_id=${VFARM_LIVE_FARM_ID}&limit=5"
check_get "Layout" "/api/v1/admin/vfarm/layout?farm_id=${VFARM_LIVE_FARM_ID}"
check_get "Organizations" "/api/v1/admin/vfarm/organizations"
check_get "Vision" "/api/v1/admin/vfarm/vision/latest?farm_id=${VFARM_LIVE_FARM_ID}"

echo ""
echo -e "${BOLD}Summary:${RESET} ${GREEN}${PASSED} passed${RESET}, ${RED}${FAILED} failed${RESET}"
[ "$FAILED" -eq 0 ] && exit 0 || exit 1
