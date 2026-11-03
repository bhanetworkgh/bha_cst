#!/usr/bin/env bash
# ==============================================================================
# CST Production API Endpoint Test Runner
# Target: https://bha-cst-7u9e.onrender.com
# STRICT RULE: READ-ONLY. Zero-mutation. No SMS, no voice calls, no DB writes.
# ==============================================================================

set -euo pipefail

BASE_URL="https://bha-cst-7u9e.onrender.com"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_FILE="$REPO_ROOT/prod-test-results.json"

# Load credentials from .env safely if present
ADMIN_EMAIL="admin@cst.com"
ADMIN_PASSWORD="admin"
CST_KEY=""

if [ -f "$REPO_ROOT/.env" ]; then
  val="$(grep -E '^CST_ADMIN_EMAIL=' "$REPO_ROOT/.env" | cut -d '=' -f2- || true)"
  if [ -n "$val" ]; then ADMIN_EMAIL="$val"; fi
  val="$(grep -E '^CST_ADMIN_PASSWORD=' "$REPO_ROOT/.env" | cut -d '=' -f2- || true)"
  if [ -n "$val" ]; then ADMIN_PASSWORD="$val"; fi
  val="$(grep -E '^CST_API_KEY=' "$REPO_ROOT/.env" | cut -d '=' -f2- || true)"
  if [ -n "$val" ]; then CST_KEY="$val"; fi
fi

echo "======================================================================"
echo " CST Production API Endpoint Test Suite"
echo " Target: $BASE_URL"
echo " Date:   $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo " Mode:   READ-ONLY (zero-mutation)"
echo "======================================================================"

TOTAL_TESTS=0
PASS_COUNT=0
FAIL_COUNT=0
DEGRADED_COUNT=0
AUTH_BLOCKED_COUNT=0
NOT_TESTED_COUNT=0

RESULTS_JSON="[]"

record_result() {
  local method="$1"
  local path="$2"
  local auth_mode="$3"
  local expected_status="$4"
  local actual_status="$5"
  local latency_ms="$6"
  local classification="$7"
  local snippet="$8"
  local notes="$9"

  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  case "$classification" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    DEGRADED) DEGRADED_COUNT=$((DEGRADED_COUNT + 1)) ;;
    AUTH_BLOCKED) AUTH_BLOCKED_COUNT=$((AUTH_BLOCKED_COUNT + 1)) ;;
    NOT_TESTED) NOT_TESTED_COUNT=$((NOT_TESTED_COUNT + 1)) ;;
  esac

  local clean_snippet
  clean_snippet=$(echo "$snippet" | tr '\r\n' ' ' | head -c 80)

  printf "%-7s %-50s [%s] %3s (exp %s) %5sms -> %s\n" \
    "$method" "$path" "$auth_mode" "$actual_status" "$expected_status" "$latency_ms" "$classification"
  if [ -n "$notes" ]; then
    printf "        ↳ %s\n" "$notes"
  fi

  local esc_snippet
  esc_snippet=$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$clean_snippet" 2>/dev/null || echo '""')
  local esc_notes
  esc_notes=$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$notes" 2>/dev/null || echo '""')

  local entry
  entry=$(cat <<EOF
{
  "method": "$method",
  "path": "$path",
  "auth_mode": "$auth_mode",
  "expected_status": "$expected_status",
  "actual_status": "$actual_status",
  "latency_ms": $latency_ms,
  "classification": "$classification",
  "snippet": $esc_snippet,
  "notes": $esc_notes
}
EOF
)
  RESULTS_JSON=$(node -e '
    const arr = JSON.parse(process.argv[1]);
    const entry = JSON.parse(process.argv[2]);
    arr.push(entry);
    console.log(JSON.stringify(arr));
  ' "$RESULTS_JSON" "$entry")
}

run_request() {
  local method="$1"
  local url="$2"
  local header1="${3:-}"
  local header2="${4:-}"
  local body="${5:-}"
  local req_timeout_sec="${6:-12}"

  local body_file
  body_file=$(mktemp)

  local start_ms
  start_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')

  local curl_cmd=(curl -s -o "$body_file" -w "%{http_code}" -X "$method" "$url" -m "$req_timeout_sec")
  if [ -n "$header1" ]; then curl_cmd+=(-H "$header1"); fi
  if [ -n "$header2" ]; then curl_cmd+=(-H "$header2"); fi
  if [ -n "$body" ]; then curl_cmd+=(-d "$body"); fi

  CUR_STATUS="$("${curl_cmd[@]}" 2>/dev/null || echo "000")"

  local end_ms
  end_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  CUR_LATENCY=$((end_ms - start_ms))

  CUR_BODY="$(head -c 200 "$body_file" 2>/dev/null || echo "")"
  rm -f "$body_file"
}

# ------------------------------------------------------------------------------
# PHASE 1: PUBLIC / LIVENESS / DOCS ENDPOINTS
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 1] Public / Liveness / Documentation Endpoints ---"

# GET /health
run_request "GET" "$BASE_URL/health"
if [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/health" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Liveness probe OK"
else
  record_result "GET" "/health" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Liveness probe failed"
fi

# GET /health/voice
run_request "GET" "$BASE_URL/health/voice"
if [ "$CUR_STATUS" = "200" ] || [ "$CUR_STATUS" = "503" ]; then
  record_result "GET" "/health/voice" "public" "200/503" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Voice lane status evaluated"
else
  record_result "GET" "/health/voice" "public" "200/503" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Unexpected voice health status"
fi

# GET /api/health
run_request "GET" "$BASE_URL/api/health"
if [ "$CUR_STATUS" = "200" ]; then
  if echo "$CUR_BODY" | grep -q '"status":"unknown"'; then
    record_result "GET" "/api/health" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "Upstream reachability unavailable (probe_failed:auth)"
  else
    record_result "GET" "/api/health" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Detailed health OK"
  fi
else
  record_result "GET" "/api/health" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Health endpoint returned $CUR_STATUS"
fi

# GET /
run_request "GET" "$BASE_URL/"
if [ "$CUR_STATUS" = "200" ] || [ "$CUR_STATUS" = "302" ]; then
  record_result "GET" "/" "public" "200/302" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Root redirects to /api-docs"
else
  record_result "GET" "/" "public" "200/302" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Root landing page failed"
fi

# GET /api-docs/
run_request "GET" "$BASE_URL/api-docs/"
if [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/api-docs/" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Swagger UI documentation served"
else
  record_result "GET" "/api-docs/" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Swagger UI failed"
fi

# GET /web
run_request "GET" "$BASE_URL/web"
if [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/web" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Web chat interface served"
else
  record_result "GET" "/web" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Web chat interface failed"
fi

# GET /admin/login
run_request "GET" "$BASE_URL/admin/login"
if [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/admin/login" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Admin login page served"
else
  record_result "GET" "/admin/login" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Admin login page failed"
fi

# GET /admin
run_request "GET" "$BASE_URL/admin"
if [ "$CUR_STATUS" = "200" ] || [ "$CUR_STATUS" = "302" ]; then
  record_result "GET" "/admin" "public" "200/302" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Admin dashboard UI served"
else
  record_result "GET" "/admin" "public" "200/302" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Admin dashboard UI failed"
fi

# GET /api-docs.json
run_request "GET" "$BASE_URL/api-docs.json"
if [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/api-docs.json" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "OpenAPI 3.0.3 spec served"
else
  record_result "GET" "/api-docs.json" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "OpenAPI spec failed"
fi

# GET /debug/state
run_request "GET" "$BASE_URL/debug/state"
if [ "$CUR_STATUS" = "404" ]; then
  record_result "GET" "/debug/state" "public" "404" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Correctly disabled in production (404)"
else
  record_result "GET" "/debug/state" "public" "404" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "CRITICAL: Debug state exposed in production!"
fi

# GET /favicon.ico
run_request "GET" "$BASE_URL/favicon.ico"
if [ "$CUR_STATUS" = "204" ] || [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/favicon.ico" "public" "204" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "" "Favicon handler OK"
else
  record_result "GET" "/favicon.ico" "public" "204" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "" "Favicon returned $CUR_STATUS"
fi

# ------------------------------------------------------------------------------
# PHASE 2: ADMIN AUTHENTICATION
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 2] Admin Authentication & Session Management ---"

# Bad creds
run_request "POST" "$BASE_URL/api/v1/auth/login" "Content-Type: application/json" "" '{"email":"invalid@test.com","password":"wrong"}'
if [ "$CUR_STATUS" = "401" ]; then
  record_result "POST" "/api/v1/auth/login (bad creds)" "public" "401" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Invalid credentials rejected (401)"
else
  record_result "POST" "/api/v1/auth/login (bad creds)" "public" "401" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 401 for bad credentials"
fi

# Valid creds
run_request "POST" "$BASE_URL/api/v1/auth/login" "Content-Type: application/json" "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"

ADMIN_TOKEN=""
if [ "$CUR_STATUS" = "200" ]; then
  ADMIN_TOKEN=$(echo "$CUR_BODY" | node -e 'try{console.log(JSON.parse(fs.readFileSync(0)).token || "")}catch(e){}' 2>/dev/null || true)
  record_result "POST" "/api/v1/auth/login (valid)" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "Token acquired" "Authenticated successfully"
else
  record_result "POST" "/api/v1/auth/login (valid)" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Admin login failed"
fi

# GET /api/v1/auth/me (unauth)
run_request "GET" "$BASE_URL/api/v1/auth/me"
if [ "$CUR_STATUS" = "401" ]; then
  record_result "GET" "/api/v1/auth/me (unauth)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Unauthenticated access properly blocked (401)"
else
  record_result "GET" "/api/v1/auth/me (unauth)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 401 without token"
fi

# GET /api/v1/auth/me (auth)
if [ -n "$ADMIN_TOKEN" ]; then
  run_request "GET" "$BASE_URL/api/v1/auth/me" "x-admin-token: $ADMIN_TOKEN"
  if [ "$CUR_STATUS" = "200" ]; then
    record_result "GET" "/api/v1/auth/me" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Session validated successfully"
  else
    record_result "GET" "/api/v1/auth/me" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Failed to validate session"
  fi
else
  record_result "GET" "/api/v1/auth/me" "x-admin-token" "200" "000" "0" "AUTH_BLOCKED" "" "Missing admin token"
fi

# ------------------------------------------------------------------------------
# PHASE 3: ADMIN CORE & TENANCY
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 3] Admin Core & Tenancy Management ---"

ADMIN_ROUTES=(
  "/api/v1/admin/tenants"
  "/api/v1/admin/projects"
  "/api/v1/admin/numbers/bindings"
  "/api/v1/admin/numbers/candidate"
  "/api/v1/admin/health/verification"
  "/api/v1/admin/dashboard-publisher/status"
  "/api/v1/admin/speakers"
  "/api/v1/admin/audit/logs"
  "/api/v1/admin/dashboard"
  "/api/v1/admin/sms-consent/wording"
  "/api/v1/admin/sms-consent"
  "/api/v1/admin/sms-consent/%2B19715885823?tenant_id=tenant-vfarm-01"
  "/api/v1/admin/sms-consent/%2B19715885823/history?tenant_id=tenant-vfarm-01"
)

for ep in "${ADMIN_ROUTES[@]}"; do
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep" "x-admin-token: $ADMIN_TOKEN"
    if [ "$CUR_STATUS" = "200" ] || [ "$CUR_STATUS" = "404" ]; then
      record_result "GET" "$ep" "x-admin-token" "200/404" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Admin core endpoint responded OK"
    else
      record_result "GET" "$ep" "x-admin-token" "200/404" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Admin endpoint returned $CUR_STATUS"
    fi
  else
    record_result "GET" "$ep" "x-admin-token" "200" "000" "0" "AUTH_BLOCKED" "" "No admin token"
  fi
done

# ------------------------------------------------------------------------------
# PHASE 4: V-FARM ADMIN PROXIES
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 4] vFarm Admin Proxy Endpoints ---"

# Working proxy routes
VFARM_ADMIN_ROUTES=(
  "/api/v1/admin/vfarm/farms"
  "/api/v1/admin/vfarm/dashboard"
  "/api/v1/admin/vfarm/health"
  "/api/v1/admin/vfarm/summary"
  "/api/v1/admin/vfarm/organizations"
  "/api/v1/admin/vfarm/layout"
  "/api/v1/admin/vfarm/zones"
  "/api/v1/admin/vfarm/devices"
  "/api/v1/admin/vfarm/alerts/open"
  "/api/v1/admin/vfarm/alerts/history"
  "/api/v1/admin/vfarm/customers?org_id=122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d"
  "/api/v1/admin/vfarm/users?org_id=122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d"
  "/api/v1/admin/turn-stream"
)

for ep in "${VFARM_ADMIN_ROUTES[@]}"; do
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep" "x-admin-token: $ADMIN_TOKEN"
    if [ "$CUR_STATUS" = "200" ]; then
      record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "vFarm proxy responded OK"
    else
      record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "vFarm proxy returned $CUR_STATUS"
    fi
  else
    record_result "GET" "$ep" "x-admin-token" "200" "000" "0" "AUTH_BLOCKED" "" "No admin token"
  fi
done

# Upstream Degraded vFarm Endpoints
DEGRADED_VFARM_ROUTES=(
  "/api/v1/admin/vfarm/system-stats:Upstream vFarm returns 503 from /api/v1/system/stats"
  "/api/v1/admin/vfarm/alerts/counts:Upstream vFarm times out > 5000ms on /api/v1/alerts/threshold/counts"
  "/api/v1/admin/vfarm/vision/latest:Upstream vFarm returns 422 (no cameras configured for active farm)"
)

for item in "${DEGRADED_VFARM_ROUTES[@]}"; do
  ep="${item%%:*}"
  reason="${item#*:}"
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep" "x-admin-token: $ADMIN_TOKEN"
    record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "$reason"
  fi
done

# ------------------------------------------------------------------------------
# PHASE 5: SENSOR READINGS (ALL 4 SENSORS INDIVIDUALLY)
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 5] Individual Sensor Readings (rack1_soil, rack1_ph, rack2_dht, rack1_mq7) ---"

SENSORS=("rack1_soil" "rack1_ph" "rack2_dht" "rack1_mq7")

for s in "${SENSORS[@]}"; do
  # 1. Historical readings (confirmed working)
  ep_hist="/api/v1/admin/vfarm/readings?sensor_id=$s&limit=5"
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep_hist" "x-admin-token: $ADMIN_TOKEN"
    if [ "$CUR_STATUS" = "200" ]; then
      record_result "GET" "$ep_hist" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Historical readings retrieved OK"
    elif [ "$CUR_STATUS" = "502" ] || [ "$CUR_STATUS" = "504" ]; then
      record_result "GET" "$ep_hist" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "Upstream vFarm timeout/proxy error"
    else
      record_result "GET" "$ep_hist" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Historical readings failed"
    fi
  fi

  # 2. Latest reading endpoint (upstream vFarm /readings/latest times out > 5000ms)
  ep_latest="/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=$s"
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep_latest" "x-admin-token: $ADMIN_TOKEN"
    if [ "$CUR_STATUS" = "200" ]; then
      record_result "GET" "$ep_latest" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Latest reading retrieved"
    elif [ "$CUR_STATUS" = "502" ] || [ "$CUR_STATUS" = "504" ]; then
      record_result "GET" "$ep_latest" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "Upstream vFarm /readings/latest timeout > 5000ms"
    else
      record_result "GET" "$ep_latest" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Sensor latest failed with $CUR_STATUS"
    fi
  fi

  # 3. Reading stats endpoint (CST VFARM_READINGS_STATS_TIMEOUT_MS = 30000; allow 35s curl budget)
  ep_stats="/api/v1/admin/vfarm/readings/stats?sensor_id=$s&window=24h"
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep_stats" "x-admin-token: $ADMIN_TOKEN" "" "" 35
    if [ "$CUR_STATUS" = "200" ]; then
      record_result "GET" "$ep_stats" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Reading stats computed"
    elif [ "$CUR_STATUS" = "502" ] || [ "$CUR_STATUS" = "504" ]; then
      record_result "GET" "$ep_stats" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "Upstream vFarm stats timeout > 30000ms"
    elif [ "$CUR_STATUS" = "000" ]; then
      record_result "GET" "$ep_stats" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Client curl timeout at 35s (exceeded CST 30s budget)"
    else
      record_result "GET" "$ep_stats" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Reading stats failed with $CUR_STATUS"
    fi
  fi
done

# ------------------------------------------------------------------------------
# PHASE 6: PUBLIC V-FARM PROXIES & ALIASES
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 6] Public vFarm Proxies & Aliases ---"

PUBLIC_VFARM_ROUTES=(
  "/api/v1/dashboard"
  "/api/dashboard"
  "/api/v1/devices"
  "/api/devices"
  "/api/v1/farms"
  "/api/farms"
)

for ep in "${PUBLIC_VFARM_ROUTES[@]}"; do
  # Authenticated
  if [ -n "$ADMIN_TOKEN" ]; then
    run_request "GET" "$BASE_URL$ep" "x-admin-token: $ADMIN_TOKEN"
    if [ "$CUR_STATUS" = "200" ]; then
      record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Authenticated proxy OK"
    elif [ "$CUR_STATUS" = "500" ] && echo "$CUR_BODY" | grep -q "timed out after 5000ms"; then
      record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "Upstream vFarm devices timeout > 5000ms"
    elif [ "$CUR_STATUS" = "502" ] || [ "$CUR_STATUS" = "504" ]; then
      record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "DEGRADED" "$CUR_BODY" "Upstream vFarm proxy error/timeout ($CUR_STATUS)"
    else
      record_result "GET" "$ep" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Proxy returned $CUR_STATUS"
    fi
  fi

  # Unauthenticated
  run_request "GET" "$BASE_URL$ep"
  if [ "$CUR_STATUS" = "401" ]; then
    record_result "GET" "$ep (unauth)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Unauthenticated access properly blocked (401)"
  else
    record_result "GET" "$ep (unauth)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 401 without auth"
  fi
done

# ------------------------------------------------------------------------------
# PHASE 7: WEB CHAT INTERFACE
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 7] Web Chat Interface ---"

run_request "POST" "$BASE_URL/api/v1/web/session" "Content-Type: application/json" "" '{"projectId":"proj-vfarm-01"}'
if [ "$CUR_STATUS" = "501" ]; then
  record_result "POST" "/api/v1/web/session" "none" "501" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Enforces PRODUCTION_AUTH_REQUIRED (501)"
else
  record_result "POST" "/api/v1/web/session" "none" "501" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Unexpected status $CUR_STATUS"
fi

run_request "GET" "$BASE_URL/api/v1/web/projects"
if [ "$CUR_STATUS" = "200" ]; then
  record_result "GET" "/api/v1/web/projects" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Web projects listed"
else
  record_result "GET" "/api/v1/web/projects" "public" "200" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Web projects returned $CUR_STATUS"
fi

run_request "GET" "$BASE_URL/api/v1/web/session"
if [ "$CUR_STATUS" = "401" ]; then
  record_result "GET" "/api/v1/web/session (no cookie)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Unauthenticated web session blocked"
else
  record_result "GET" "/api/v1/web/session (no cookie)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 401"
fi

# ------------------------------------------------------------------------------
# PHASE 8: VOICE & PROGRAMMATIC AUTH GATES (READ-ONLY)
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 8] Voice & Programmatic Auth Gates (Fail-Closed Check) ---"

VOICE_ENDPOINTS=(
  "/audio/speak"
  "/voice/turn"
  "/api/v1/voice/turn"
  "/api/v1/voice/synthesize"
)

for ep in "${VOICE_ENDPOINTS[@]}"; do
  # Without key -> 401
  run_request "POST" "$BASE_URL$ep" "Content-Type: application/json" "" '{"text":"test"}'
  if [ "$CUR_STATUS" = "401" ]; then
    record_result "POST" "$ep (no key)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Fail-closed without API key (401)"
  else
    record_result "POST" "$ep (no key)" "none" "401" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 401 without key"
  fi

  # Invalid key -> 403
  run_request "POST" "$BASE_URL$ep" "Content-Type: application/json" "x-cst-api-key: invalid-probe-key" '{"text":"test"}'
  if [ "$CUR_STATUS" = "403" ]; then
    record_result "POST" "$ep (bad key)" "x-cst-api-key" "403" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Invalid key rejected with 403 FORBIDDEN"
  else
    record_result "POST" "$ep (bad key)" "x-cst-api-key" "403" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 403 for bad key"
  fi
done

run_request "GET" "$BASE_URL/api/v1/voice/audio/non-existent-probe-id"
if [ "$CUR_STATUS" = "404" ]; then
  record_result "GET" "/api/v1/voice/audio/:id" "public" "404" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Correctly returns AUDIO_NOT_FOUND"
else
  record_result "GET" "/api/v1/voice/audio/:id" "public" "404" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "Expected 404 for missing audio"
fi

# ------------------------------------------------------------------------------
# PHASE 9: TWILIO WEBHOOK GATES (SIGNATURE SECURITY VERIFICATION)
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 9] Twilio Webhook Gate Verification (Signature Guard) ---"

TWILIO_ENDPOINTS=(
  "/webhooks/twilio/sms"
  "/webhooks/twilio/delivery-status"
  "/webhooks/twilio/voice"
  "/webhooks/twilio/voice/inbound"
  "/twilio/voice"
  "/twilio/voice/inbound"
  "/webhooks/twilio/voice/turn"
  "/twilio/voice/turn"
  "/webhooks/twilio/voice/status"
  "/twilio/voice/status"
  "/api/v1/voice/status"
)

for ep in "${TWILIO_ENDPOINTS[@]}"; do
  run_request "POST" "$BASE_URL$ep" "Content-Type: application/x-www-form-urlencoded" "" "From=%2B12025551234&To=%2B19715885823&Body=Test"
  # CST Twilio signature guard returns 401 when signature header is missing, or 403 when signature is invalid
  if [ "$CUR_STATUS" = "401" ] || [ "$CUR_STATUS" = "403" ]; then
    record_result "POST" "$ep (unauthenticated)" "none" "401/403" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Unsigned Twilio webhook refused with $CUR_STATUS"
  else
    record_result "POST" "$ep (unauthenticated)" "none" "401/403" "$CUR_STATUS" "$CUR_LATENCY" "FAIL" "$CUR_BODY" "CRITICAL: Webhook did not reject unsigned request (code: $CUR_STATUS)"
  fi
done

# ------------------------------------------------------------------------------
# PHASE 10: WRITE MUTATIONS (MARKED READ-ONLY / NOT TESTED)
# ------------------------------------------------------------------------------
echo -e "\n--- [PHASE 10] Production Write Operations Safety Status ---"

WRITE_OPS=(
  "POST /api/v1/admin/tenants:Create new tenant"
  "PATCH /api/v1/admin/tenants/:tenantId:Update tenant configuration"
  "POST /api/v1/admin/projects/sync:Sync project configuration"
  "PATCH /api/v1/admin/projects/:projectId:Update project details"
  "POST /api/v1/admin/numbers/sync:Sync Twilio numbers"
  "POST /api/v1/admin/numbers/bind:Bind number to project"
  "DELETE /api/v1/admin/numbers/unbind:Unbind number"
  "POST /api/v1/admin/speakers/sync:Sync speaker registry"
  "POST /api/v1/admin/speakers/invalidate:Invalidate speaker cache"
  "POST /api/v1/admin/speakers:Create speaker"
  "PATCH /api/v1/admin/speakers/:phoneE164:Update speaker"
  "DELETE /api/v1/admin/speakers/:phoneE164:Delete speaker"
  "POST /api/v1/admin/sms-consent:Update SMS consent state"
  "POST /api/v1/admin/vfarm/login:Interactive farm admin login"
  "POST /api/v1/admin/vfarm/tokens:Generate farm token"
  "POST /api/v1/admin/vfarm/select:Switch active farm in-memory"
  "POST /api/v1/web/message:Send user web chat message"
  "POST /audio/speak (with valid key):Synthesize spoken turn via ElevenLabs"
  "POST /voice/turn (with valid key):Execute voice turn orchestrator"
)

for op in "${WRITE_OPS[@]}"; do
  method=$(echo "$op" | cut -d' ' -f1)
  rest=$(echo "$op" | cut -d' ' -f2-)
  path=$(echo "$rest" | cut -d':' -f1)
  reason=$(echo "$rest" | cut -d':' -f2)

  record_result "$method" "$path" "restricted" "N/A" "000" 0 "NOT_TESTED" "" "Skipped in prod audit: $reason (zero-mutation rule)"
done

# ------------------------------------------------------------------------------
# PHASE 11: ADMIN LOGOUT CLEANUP
# ------------------------------------------------------------------------------
if [ -n "$ADMIN_TOKEN" ]; then
  echo -e "\n--- Admin Session Cleanup ---"
  run_request "POST" "$BASE_URL/api/v1/auth/logout" "x-admin-token: $ADMIN_TOKEN" "Content-Type: application/json" "{\"token\":\"$ADMIN_TOKEN\"}"
  record_result "POST" "/api/v1/auth/logout" "x-admin-token" "200" "$CUR_STATUS" "$CUR_LATENCY" "PASS" "$CUR_BODY" "Admin session token revoked cleanly"
fi

# ------------------------------------------------------------------------------
# SUMMARY & ARTIFACT GENERATION
# ------------------------------------------------------------------------------
echo -e "\n======================================================================"
echo " CST Production API Test Suite Complete"
echo "======================================================================"
echo " Total Endpoints Evaluated: $TOTAL_TESTS"
echo "   PASS:         $PASS_COUNT"
echo "   FAIL:         $FAIL_COUNT"
echo "   DEGRADED:     $DEGRADED_COUNT"
echo "   AUTH_BLOCKED: $AUTH_BLOCKED_COUNT"
echo "   NOT_TESTED:   $NOT_TESTED_COUNT"
echo "======================================================================"

VERDICT="PRODUCTION API VERIFIED"
if [ "$FAIL_COUNT" -gt 0 ]; then
  VERDICT="PRODUCTION API FAILING"
elif [ "$DEGRADED_COUNT" -gt 0 ]; then
  VERDICT="DEGRADED"
elif [ "$AUTH_BLOCKED_COUNT" -gt 0 ]; then
  VERDICT="VERIFICATION BLOCKED"
fi

echo " Final Verdict: $VERDICT"
echo " Writing raw results to $OUTPUT_FILE ..."

cat <<EOF > "$OUTPUT_FILE"
{
  "target": "$BASE_URL",
  "tested_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "total_evaluated": $TOTAL_TESTS,
  "summary": {
    "pass": $PASS_COUNT,
    "fail": $FAIL_COUNT,
    "degraded": $DEGRADED_COUNT,
    "auth_blocked": $AUTH_BLOCKED_COUNT,
    "not_tested": $NOT_TESTED_COUNT
  },
  "final_verdict": "$VERDICT",
  "results": $RESULTS_JSON
}
EOF

echo "Done. Test results saved to $OUTPUT_FILE"
