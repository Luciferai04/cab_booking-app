#!/usr/bin/env bash
set -euo pipefail
mkdir -p gateway/certs
# Generate self-signed cert valid for 365 days
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout gateway/certs/privkey.pem -out gateway/certs/fullchain.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "Self-signed certs written to gateway/certs"
