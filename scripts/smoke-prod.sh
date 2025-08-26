#!/usr/bin/env bash
set -euo pipefail
BASE_URL=${BASE_URL:-https://localhost:8443}
CURL=${CURL:-curl -sk}
INFO() { printf "[INFO] %s\n" "$*"; }
WARN() { printf "[WARN] %s\n" "$*"; }

INFO "Gateway health: $BASE_URL/health"
$CURL -fS "$BASE_URL/health" >/dev/null && INFO "Gateway OK" || { WARN "Gateway not reachable"; exit 1; }

INFO "users-service health"
$CURL -fS "$BASE_URL/users/health" >/dev/null && INFO "users OK" || WARN "users not reachable"
INFO "rides-service health"
$CURL -fS "$BASE_URL/rides/health" >/dev/null && INFO "rides OK" || WARN "rides not reachable"
INFO "payments-service health"
$CURL -fS "$BASE_URL/payments/ready" >/dev/null && INFO "payments OK" || WARN "payments not reachable"

# Optional OTP flow if devOtp is available (non-production only)
EMAIL="smoke.$(date +%s)@example.com"
INFO "Registering user $EMAIL"
REG=$($CURL -s -X POST "$BASE_URL/users/register" -H 'Content-Type: application/json' \
  -d "{\"fullname\":{\"firstname\":\"Smoke\",\"lastname\":\"Test\"},\"email\":\"$EMAIL\",\"password\":\"Passw0rd!\"}") || true
TOKEN=$(printf "%s" "$REG" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "${TOKEN:-}" ]; then WARN "Registration failed (continuing): $REG"; fi

REQ=$($CURL -s -X POST "$BASE_URL/users/otp/request" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}") || true
DEV_OTP=$(printf "%s" "$REQ" | sed -n 's/.*"devOtp":"\([^"]*\)".*/\1/p')
if [ -n "${DEV_OTP:-}" ]; then
  INFO "devOtp present; verifying OTP"
VER=$($CURL -s -X POST "$BASE_URL/users/otp/verify" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"otp\":\"$DEV_OTP\"}") || true
  VTOKEN=$(printf "%s" "$VER" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -n "${VTOKEN:-}" ]; then INFO "OTP verified"; else WARN "OTP verify failed (dev mode)"; fi
else
  WARN "devOtp not present (likely production); skipping OTP verification"
fi

INFO "Payments UPI create-order"
ORD=$($CURL -s -X POST "$BASE_URL/payments/upi/create-order" -H 'Content-Type: application/json' -d '{"amount":5000,"currency":"INR"}') || true
PROVIDER=$(printf "%s" "$ORD" | sed -n 's/.*"provider":"\([^"]*\)".*/\1/p')
INFO "UPI provider: ${PROVIDER:-unknown}"

INFO "Smoke completed"

