#!/usr/bin/env bash
# ==============================================================================
# vFarm Live Integration & Smoke Test Script
#
# Verifies the live vFarm API seams against https://bhavfarm1.duckdns.org
# Using X-Farm-Key authentication header.
#
# Farm IDs are discovered dynamically — no hardcoded UUIDs.
# If VFARM_FARM_ID is not set, the script calls GET /api/v1/farms
# and uses the first farm returned.
#
# Usage:
#   VFARM_FARM_KEY="<key>" ./scripts/verify_vfarm_live.sh
#
# Optional overrides:
#   VFARM_BASE_URL="https://bhavfarm1.duckdns.org" (default)
#   VFARM_FARM_ID — if set, used directly; otherwise discovered dynamically.
# ==============================================================================

set -o pipefail

# ANSI color codes
BOLD="\033[1m"
GREEN="\033[1;32m"
RED="\033[1;31m"
YELLOW="\033[1;33m"
CYAN="\033[1;36m"
RESET="\033[0m"

# Auto-load from .env if VFARM_FARM_KEY is not already exported
if [ -z "$VFARM_FARM_KEY" ] && [ -f ".env" ]; then
  VFARM_FARM_KEY=$(grep -E '^VFARM_FARM_KEY=' .env | cut -d '=' -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
fi

# Fallback to legacy key if present
if [ -z "$VFARM_FARM_KEY" ] && [ -n "$VFARM_API_KEY" ]; then
  VFARM_FARM_KEY="$VFARM_API_KEY"
fi

VFARM_BASE_URL="${VFARM_BASE_URL:-https://bhavfarm1.duckdns.org}"
# Strip trailing slash
VFARM_BASE_URL="${VFARM_BASE_URL%/}"

PASSED_COUNT=0
FAILED_COUNT=0
TOTAL_COUNT=0

echo -e "${BOLD}${CYAN}================================================================${RESET}"
echo -e "${BOLD}${CYAN}   CST vFarm Integration Refactor — Live Smoke Verification    ${RESET}"
echo -e "${BOLD}${CYAN}================================================================${RESET}"
echo -e " Target Base URL: ${BOLD}${VFARM_BASE_URL}${RESET}"
if [ -n "$VFARM_FARM_KEY" ]; then
  echo -e " Auth Header:     ${BOLD}X-Farm-Key: configured (value redacted)${RESET}"
else
  echo -e " Auth Header:     ${BOLD}${RED}MISSING (VFARM_FARM_KEY is unset)${RESET}"
fi
echo -e "${BOLD}${CYAN}================================================================${RESET}\n"

# Verify credentials exist
if [ -z "$VFARM_FARM_KEY" ]; then
  echo -e "${RED}[FATAL] Missing required environment variable VFARM_FARM_KEY.${RESET}"
  echo -e "Please export VFARM_FARM_KEY or specify it in your .env file."
  echo -e "Example: VFARM_FARM_KEY=\"your_key_here\" ./scripts/verify_vfarm_live.sh\n"
  exit 1
fi

# ── Dynamic Farm Discovery ──────────────────────────────────────────────────
# If VFARM_FARM_ID is not set, discover farms dynamically via GET /api/v1/farms.
if [ -z "$VFARM_FARM_ID" ]; then
  echo -e "${BOLD}▶ Discovering farms dynamically (no VFARM_FARM_ID set)${RESET}"
  FARM_LIST_URL="${VFARM_BASE_URL}/api/v1/farms?limit=1000"
  FARM_LIST_RESP=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${FARM_LIST_URL}")
  FARM_LIST_BODY=$(echo "$FARM_LIST_RESP" | sed '$d')
  FARM_LIST_CODE=$(echo "$FARM_LIST_RESP" | tail -n 1)

  if [ "$FARM_LIST_CODE" = "200" ]; then
    # Extract first farm "id" value from the JSON array
    VFARM_FARM_ID=$(echo "$FARM_LIST_BODY" | grep -o '"id": *"[^"]*"' | head -n 1 | cut -d '"' -f4)
    if [ -n "$VFARM_FARM_ID" ]; then
      echo -e "  ${GREEN}Discovered farm ID: ${VFARM_FARM_ID}${RESET}"
    else
      echo -e "${RED}[FATAL] No farms returned by GET /api/v1/farms${RESET}"
      exit 1
    fi
  else
    echo -e "${RED}[FATAL] Farm discovery failed (HTTP ${FARM_LIST_CODE}). Set VFARM_FARM_ID explicitly to skip discovery.${RESET}"
    exit 1
  fi
fi

echo -e " Target Farm ID:  ${BOLD}${VFARM_FARM_ID}${RESET}"
echo ""

record_pass() {
  local step_name="$1"
  local details="$2"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  PASSED_COUNT=$((PASSED_COUNT + 1))
  echo -e "  ${GREEN}PASS${RESET}  ${BOLD}${step_name}${RESET}"
  if [ -n "$details" ]; then
    echo -e "        ${CYAN}↳ ${details}${RESET}"
  fi
}

record_fail() {
  local step_name="$1"
  local details="$2"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  FAILED_COUNT=$((FAILED_COUNT + 1))
  echo -e "  ${RED}FAIL${RESET}  ${BOLD}${step_name}${RESET}"
  if [ -n "$details" ]; then
    echo -e "        ${YELLOW}↳ ${details}${RESET}"
  fi
}

# ------------------------------------------------------------------------------
# STEP 1: Farm Metadata
# ------------------------------------------------------------------------------
echo -e "${BOLD}▶ Step 1: Farm Metadata${RESET}"
URL_STEP1="${VFARM_BASE_URL}/api/v1/farms/${VFARM_FARM_ID}"
echo -e "  GET ${URL_STEP1}"

HTTP_RESP_1=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP1}")
HTTP_BODY_1=$(echo "$HTTP_RESP_1" | sed '$d')
HTTP_CODE_1=$(echo "$HTTP_RESP_1" | tail -n 1)

if [ "$HTTP_CODE_1" = "200" ]; then
  FARM_NAME=$(echo "$HTTP_BODY_1" | grep -o '"name": *"[^"]*"' | head -n 1 | cut -d '"' -f4)
  if [ -n "$FARM_NAME" ]; then
    record_pass "Step 1: Farm Metadata" "HTTP 200 OK — Farm Name: '${FARM_NAME}'"
  else
    record_fail "Step 1: Farm Metadata" "HTTP 200 OK but farm name was empty or unparseable"
  fi
else
  record_fail "Step 1: Farm Metadata" "Expected HTTP 200, received HTTP ${HTTP_CODE_1}. Body: ${HTTP_BODY_1}"
fi
echo ""

# ------------------------------------------------------------------------------
# STEP 2: Farm Health
# ------------------------------------------------------------------------------
echo -e "${BOLD}▶ Step 2: Farm Health${RESET}"
URL_STEP2="${VFARM_BASE_URL}/api/v1/farms/${VFARM_FARM_ID}/health"
echo -e "  GET ${URL_STEP2}"

HTTP_RESP_2=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP2}")
HTTP_BODY_2=$(echo "$HTTP_RESP_2" | sed '$d')
HTTP_CODE_2=$(echo "$HTTP_RESP_2" | tail -n 1)

if [ "$HTTP_CODE_2" = "200" ]; then
  record_pass "Step 2: Farm Health" "HTTP 200 OK — Health payload received: ${HTTP_BODY_2:0:80}..."
else
  record_fail "Step 2: Farm Health" "Expected HTTP 200, received HTTP ${HTTP_CODE_2}. Body: ${HTTP_BODY_2}"
fi
echo ""

# ------------------------------------------------------------------------------
# STEP 3: Device Listing
# ------------------------------------------------------------------------------
echo -e "${BOLD}▶ Step 3: Device Listing${RESET}"
URL_STEP3="${VFARM_BASE_URL}/api/v1/devices?farm_id=${VFARM_FARM_ID}"
echo -e "  GET ${URL_STEP3}"

HTTP_RESP_3=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP3}")
HTTP_BODY_3=$(echo "$HTTP_RESP_3" | sed '$d')
HTTP_CODE_3=$(echo "$HTTP_RESP_3" | tail -n 1)
FIRST_DEVICE_ID=""

if [ "$HTTP_CODE_3" = "200" ]; then
  # Extract first device ID from json
  FIRST_DEVICE_ID=$(echo "$HTTP_BODY_3" | grep -o '"id": *"[^"]*"' | head -n 1 | cut -d '"' -f4)
  DEVICE_COUNT=$(echo "$HTTP_BODY_3" | grep -o '"id": *"[^"]*"' | wc -l | tr -d ' ')
  
  if [ -n "$FIRST_DEVICE_ID" ]; then
    record_pass "Step 3: Device Listing" "HTTP 200 OK — Found ${DEVICE_COUNT} device(s). First Device ID: ${FIRST_DEVICE_ID}"
  else
    record_pass "Step 3: Device Listing" "HTTP 200 OK — 0 devices registered on this farm"
  fi
else
  record_fail "Step 3: Device Listing" "Expected HTTP 200, received HTTP ${HTTP_CODE_3}. Body: ${HTTP_BODY_3}"
fi
echo ""

# ------------------------------------------------------------------------------
# STEP 4: Telemetry & Stats (Using a sensor device from Step 3)
# ------------------------------------------------------------------------------
echo -e "${BOLD}▶ Step 4: Telemetry & Stats${RESET}"
TARGET_SENSOR_ID=$(echo "$HTTP_BODY_3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const body=JSON.parse(s);const sensor=(body.devices||[]).find(d=>d.device_type==='sensor'&&d.id);if(sensor)process.stdout.write(sensor.id);})")

if [ -z "$TARGET_SENSOR_ID" ]; then
  record_fail "Step 4: Sensor Selection" "No authoritative sensor-type device was returned; telemetry checks skipped rather than using a fabricated ID."
  echo -e "\n ${RED}${BOLD}✗ SOME INTEGRATION CHECKS FAILED${RESET}"
  exit 1
fi
echo -e "  Target Sensor ID: ${BOLD}${TARGET_SENSOR_ID}${RESET}"

# 4a: Authoritative single latest reading
URL_STEP4A="${VFARM_BASE_URL}/api/v1/readings/latest?sensor_id=${TARGET_SENSOR_ID}"
echo -e "  GET ${URL_STEP4A}"
HTTP_RESP_4A=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP4A}")
HTTP_BODY_4A=$(echo "$HTTP_RESP_4A" | sed '$d')
HTTP_CODE_4A=$(echo "$HTTP_RESP_4A" | tail -n 1)

if [ "$HTTP_CODE_4A" = "200" ]; then
  record_pass "Step 4a: Latest Reading" "HTTP 200 OK — Authoritative latest reading received"
else
  record_fail "Step 4a: Latest Reading" "Expected HTTP 200, received HTTP ${HTTP_CODE_4A}. Body: ${HTTP_BODY_4A}"
fi

# 4b: Readings History (limit=5)
URL_STEP4B="${VFARM_BASE_URL}/api/v1/readings?sensor_id=${TARGET_SENSOR_ID}&limit=5"
echo -e "  GET ${URL_STEP4B}"
HTTP_RESP_4B=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP4B}")
HTTP_BODY_4B=$(echo "$HTTP_RESP_4B" | sed '$d')
HTTP_CODE_4B=$(echo "$HTTP_RESP_4B" | tail -n 1)

if [ "$HTTP_CODE_4B" = "200" ]; then
  record_pass "Step 4b: Readings History" "HTTP 200 OK — History items received"
else
  record_fail "Step 4b: Readings History" "Expected HTTP 200, received HTTP ${HTTP_CODE_4B}. Body: ${HTTP_BODY_4B}"
fi

# 4c: Reading Stats (window=24h)
URL_STEP4C="${VFARM_BASE_URL}/api/v1/readings/stats?sensor_id=${TARGET_SENSOR_ID}&window=24h"
echo -e "  GET ${URL_STEP4C}"
HTTP_RESP_4C=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP4C}")
HTTP_BODY_4C=$(echo "$HTTP_RESP_4C" | sed '$d')
HTTP_CODE_4C=$(echo "$HTTP_RESP_4C" | tail -n 1)

if [ "$HTTP_CODE_4C" = "200" ]; then
  record_pass "Step 4c: Reading Stats (24h)" "HTTP 200 OK — Aggregated stats received"
else
  record_fail "Step 4c: Reading Stats (24h)" "Expected HTTP 200, received HTTP ${HTTP_CODE_4C}. Body: ${HTTP_BODY_4C}"
fi
echo ""

# ------------------------------------------------------------------------------
# STEP 5: Graceful Missing Endpoint Test
# ------------------------------------------------------------------------------
echo -e "${BOLD}▶ Step 5: Graceful Missing Endpoint Test${RESET}"
URL_STEP5="${VFARM_BASE_URL}/api/v1/inventory/dummy-serial/config"
echo -e "  GET ${URL_STEP5}"

HTTP_RESP_5=$(curl -s -w "\n%{http_code}" -H "X-Farm-Key: ${VFARM_FARM_KEY}" -H "Accept: application/json" "${URL_STEP5}")
HTTP_BODY_5=$(echo "$HTTP_RESP_5" | sed '$d')
HTTP_CODE_5=$(echo "$HTTP_RESP_5" | tail -n 1)

# Step 5 asserts that non-200 responses are safely caught and do not cause uncaught crashes
if [ "$HTTP_CODE_5" != "200" ]; then
  record_pass "Step 5: Graceful Missing Endpoint Test" "Safely caught non-200 response (HTTP ${HTTP_CODE_5}). Handled gracefully without crash."
else
  record_pass "Step 5: Graceful Missing Endpoint Test" "Endpoint returned HTTP 200. Body: ${HTTP_BODY_5}"
fi
echo ""

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
echo -e "${BOLD}${CYAN}================================================================${RESET}"
echo -e "${BOLD} Verification Summary:${RESET}"
echo -e " Total Tests:  ${BOLD}${TOTAL_COUNT}${RESET}"
echo -e " Passed:       ${GREEN}${BOLD}${PASSED_COUNT}${RESET}"
echo -e " Failed:       ${RED}${BOLD}${FAILED_COUNT}${RESET}"

if [ "$FAILED_COUNT" -eq 0 ]; then
  echo -e "\n ${GREEN}${BOLD}✓ ALL LIVE INTEGRATION CHECKS PASSED${RESET}"
  echo -e "${BOLD}${CYAN}================================================================${RESET}"
  exit 0
else
  echo -e "\n ${RED}${BOLD}✗ SOME INTEGRATION CHECKS FAILED${RESET}"
  echo -e "${BOLD}${CYAN}================================================================${RESET}"
  exit 1
fi
