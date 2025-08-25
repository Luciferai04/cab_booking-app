# RUNBOOK: Local Setup and Operations

This runbook explains how to run the entire Uber Video microservices stack locally, reliably, and repeatably.

It covers prerequisites, path hygiene (macOS), environment setup, TLS generation, starting/stopping the stack, verification, end-to-end testing, and troubleshooting common issues.

---

## 1) Prerequisites

- Docker Desktop with Docker Compose v2
- macOS (recommended notes included); Linux works similarly
- Node.js 18+ (only needed to run the E2E script locally)
- jq (optional, for pretty-printing JSON in verification commands)

Notes for Apple Silicon (M1/M2/M3):
- OSRM service may run under emulation (platform linux/amd64). This is already configured in docker-compose.yml.

---

## 2) Path hygiene (macOS) – avoid spaces in bind mounts

Docker Desktop on macOS can be finicky with host paths containing spaces (e.g., “/Volumes/T7 Shield”). To avoid bind-mount errors:

Option A: Work from a copy without spaces (recommended):

```
# Copy the project to a nospaces directory
mkdir -p "$HOME/uber-video-nospaces"
rsync -a --delete --exclude ".DS_Store" --exclude "._*" \
  "/Volumes/T7 Shield/uber-video/" "$HOME/uber-video-nospaces/"
cd "$HOME/uber-video-nospaces"
```

Option B: Symlink without spaces (works on many setups):

```
ln -s "/Volumes/T7 Shield/uber-video" "$HOME/uber-video"
cd "$HOME/uber-video"
```

Choose one option and use that path for all subsequent commands.

---

## 3) One-time setup

### 3.1 Clean macOS resource forks (if you copied from an external disk)

```
# From the repo root
find . -type f -name ".DS_Store" -print -delete
find . -type f -name "._*" -print -delete
xattr -rc .
```

Or simply run:

```
make clean-macos-forks
```

### 3.2 Create environment file

Start from the example and set values for local dev:

```
cp .env.example .env
```

Required values in .env:
- JWT_SECRET: required for users/captains/backend token signing
- DB_CONNECT: defaults to mongodb://mongo:27017/uber-video?directConnection=true
- CORS_ORIGIN: include http://localhost:5173, http://localhost:8080, and https://localhost:8443

Generate a strong secret without printing it to the terminal:

```
# macOS/Linux – store to .env without echoing to screen
SECRET=$(openssl rand -hex 32)
awk -v secret="$SECRET" 'BEGIN{print "JWT_SECRET="secret}' > .env.tmp
# Preserve other keys from existing .env (append or edit as needed)
cat << 'EOF' >> .env.tmp
DB_CONNECT=mongodb://mongo:27017/uber-video?directConnection=true
CORS_ORIGIN=http://localhost:5173,http://localhost:8080,https://localhost:8443
WANDB_API_KEY=disabled
EOF
mv .env.tmp .env
```

Never commit real secrets. Keep .env local.

### 3.3 Generate local TLS certificates

Gateway expects certs under gateway/certs as fullchain.pem and privkey.pem.

```
make tls-generate
```

This produces a self-signed certificate for localhost with proper SANs.

---

## 4) Build and start the stack

From the repository root:

```
# Build all images (first time may take a while)
docker compose -f ./docker-compose.yml build --no-cache

# Start all services detached
docker compose -f ./docker-compose.yml up -d
```

On Apple Silicon, OSRM runs with platform linux/amd64 as configured.

---

## 5) Verification checklist

Gateway health over HTTP and HTTPS:

```
curl -fsS http://localhost:8080/health
curl -skf https://localhost:8443/health
```

Jaeger should be reachable and initially show some services after traffic:

```
curl -fsS http://localhost:16686/api/services | jq .
```

Frontend should load:
- http://localhost:5173

Makefile quick checks (optional):

```
make smoke
```

---

## 6) End-to-End test

This runs a full booking flow through the gateway and services.

```
node ./test-e2e-microservices.js
```

It will register a user and a captain, log both in, get fare estimates, create/confirm/start/end a ride, create a payment intent, and log out—failing fast on errors.

---

## 7) Observability

- Jaeger UI: http://localhost:16686
- Most services emit OpenTelemetry spans to Jaeger (OTLP HTTP).
- Some services expose Prometheus-style metrics at /metrics.

---

## 8) Common operations for developers

Rebuild and restart a single service (example: gateway) after changing config:

```
docker compose -f ./docker-compose.yml build gateway
docker compose -f ./docker-compose.yml up -d --force-recreate gateway
```

Alternatively, copy a new nginx.conf and reload without rebuild:

```
docker cp gateway/nginx.conf uber-video-gateway:/etc/nginx/nginx.conf
# If the container name differs, use `docker compose ps` to confirm

docker exec -t uber-video-gateway nginx -s reload
```

Tail logs for a service:

```
docker compose -f ./docker-compose.yml logs --no-color --no-log-prefix -f gateway
```

List containers and ports:

```
docker compose -f ./docker-compose.yml ps
```

---

## 9) OSRM dataset (optional)

The OSRM service ships with a dataset. To fetch/clip a different region:

```
# Download an OSM extract
make osrm-fetch REGION_URL=https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf

# Optionally clip to a bounding box or city preset
make osrm-clip BBOX=88.20,22.40,88.50,22.70
# OR
make osrm-clip-city CITY=kolkata

# Build and start OSRM
make osrm-build-amd64
make osrm-up

# Quick check
docker compose -f ./docker-compose.yml exec -T osrm-service curl -s "http://localhost:5000/health" || true
```

End-to-end routing verify via gateway:

```
make osrm-verify
```

---

## 10) Troubleshooting

- 502 Bad Gateway on /users/register
  - Likely JWT_SECRET not set (jsonwebtoken error: secretOrPrivateKey must have a value). Ensure .env has JWT_SECRET and recreate users/captains/backend:
  
  ```
  docker compose -f ./docker-compose.yml up -d --force-recreate users-service captains-service backend
  ```

- Bind mount error mentioning a path with spaces (macOS)
  - Move/symlink or copy the repo to a path without spaces (see Section 2).

- Nginx warning: “listen ... http2 is deprecated”
  - Already fixed in gateway/nginx.conf by using `listen 443 ssl;` and `http2 on;`.

- macOS AppleDouble files (._*) or xattr errors during builds
  - Clean them (Section 3.1) or use `make clean-macos-forks`.

- HTTPS with self-signed certs
  - Use curl -k or trust a local CA (e.g., mkcert) if you prefer trusted dev certs.

- Compose version warning
  - docker-compose.yml intentionally omits the obsolete version key in Compose v2.

---

## 11) Stop and cleanup

Stop containers:

```
docker compose -f ./docker-compose.yml down
```

Remove images/volumes (irreversible):

```
# Careful: this will remove volumes and data
docker compose -f ./docker-compose.yml down -v
```

Prune unused images/containers (optional):

```
docker system prune -f
```

---

## 12) HTTPS and local trust (optional)

If you want trusted HTTPS in browsers without `-k`, use mkcert:

```
# Install mkcert (macOS with Homebrew)
brew install mkcert nss
mkcert -install
mkcert localhost 127.0.0.1 ::1

# Place the generated files under gateway/certs
#   e.g., fullchain.pem -> localhost+2.pem, privkey.pem -> localhost+2-key.pem
# Or rename the files accordingly.
```

Restart gateway after updating certs.

---

## 13) Quick reference

```
# Build and up
docker compose -f ./docker-compose.yml build --no-cache && docker compose -f ./docker-compose.yml up -d

# Smoke checks
make smoke

# End-to-end test
node ./test-e2e-microservices.js

# Jaeger services list
make jaeger-services

# TLS generation
make tls-generate
```

