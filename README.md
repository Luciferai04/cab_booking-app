# Uber Video – Microservices Demo (Local TLS + Tracing Ready)

This repository is a complete local microservices stack that demonstrates an end‑to‑end ride booking flow with service decomposition, local TLS termination, distributed tracing, and supporting infrastructure for routing and machine learning.

The stack runs entirely with Docker Compose and exposes:
- API Gateway (Nginx) on http://localhost:8080 and https://localhost:8443
- Frontend (static) on http://localhost:5173
- Jaeger UI on http://localhost:16686
- Prometheus on http://localhost:9090
- Grafana on http://localhost:3000 (admin/admin)

Key technologies:
- Node.js + Express for most microservices
- MongoDB as the database
- Redis for pub/sub and ephemeral state
- OSRM for road network routing
- Nginx as API gateway and TLS terminator
- OpenTelemetry SDKs exporting traces to Jaeger
- A small ML inference microservice (FastAPI/Uvicorn)

---

## Repository Layout

- Backend/ … shared API (aggregator/back-office) with routes, models, controllers
- gateway/ … Nginx gateway and TLS config
- frontend/ … static UI built and served via Nginx
- services/
  - users-service/ … user registration, login, profile
  - captains-service/ … captain registration, login, location/status updates
  - rides-service/ … fare estimate, create/confirm/start/end ride
  - maps-service/ … geospatial/ETA orchestration; talks to ML + routing + Redis
  - routing-service/ … wraps OSRM for route computations
  - socket-service/ … WebSocket/real-time integration (via Redis)
  - payments-service/ … stubbed payment intent
  - dispatcher-worker/ … background worker orchestrating ride offers/acks
  - ml-inference-service/ … FastAPI for ETA or model-based predictions
  - osrm-service/ … packaged OSRM with preprocessed route data
- ml/
  - models/ … trained artifacts
  - scripts/ … local training helpers
- tools/
  - osmium/ … Dockerfile for data clipping utilities
- docker-compose.yml … full stack composition
- Makefile … helper commands for OSRM, TLS, smoke checks, and E2E
- test-e2e-microservices.js … end-to-end booking flow test

---

## How It Works (High-Level)

1) API Gateway (Nginx)
- Terminates TLS on 443 and serves HTTP on 80.
- Path-based routing to internal services:
  - /users/* → users-service:4003
  - /captains/* → captains-service:4004
  - /rides/* → rides-service:4005
  - /maps/* → maps-service:4001
  - /payments/* → payments-service:4006
  - /socket/* → socket-service:4002
  - /routing/* → routing-service:4010
  - /ml/* → ml-inference-service:8000
- Adds correlation headers and rate limiting zones for basic protection.
- Uses Docker DNS resolver (127.0.0.11) so service names resolve inside the network.
- Serves a /health endpoint for basic checks; HTTP/2 enabled on TLS.

2) Frontend
- Built into static assets and served by Nginx.
- Talks to the gateway via VITE_BASE_URL (defaults to http://localhost:8080).

3) Users and Captains Services
- Node/Express services with MongoDB models.
- Implement register/login/profile and token-based auth with JWT.
- Expose /health, /ready, /metrics.
- Use OpenTelemetry tracing (see tracing.js in each service).

4) Rides Service
- Manages ride lifecycle: fare estimate, create, confirm, start, end.
- Integrates with maps-service (for ETA/surge), socket-service (events), Redis, ML.

5) Maps Service
- Higher-level orchestration for ETA and surge, calling:
  - routing-service (wraps OSRM) for travel times
  - ml-inference-service for ML-based ETA corrections
  - Redis for caching/coordination
- SURGE_* envs define surge dynamics for demo.

6) Routing + OSRM
- routing-service calls osrm-service at :5000 for table/route queries.
- osrm-service image preprocesses the OSM extract.
- Makefile has targets to fetch/clip/build region data.

7) Socket Service
- Pub/sub via Redis and Socket.IO for real-time updates.

8) Payments Service (stub)
- Returns a fake payment intent to simulate workflows.

9) Dispatcher Worker
- Background orchestration of ride offers and acknowledgements.

10) Observability
- All Node services export traces to Jaeger (OTLP HTTP at jaeger:4318).
- Jaeger UI shows spans and service dependency graph.
- Prometheus scrapes service metrics from users-service (:4003), captains-service (:4004), and rides-service (:4005) at /metrics.
- Redis metrics are exposed via redis-exporter (:9121) and scraped by Prometheus (job: redis).
- Grafana is pre-provisioned with Prometheus and Loki data sources and dashboards in observability/grafana/dashboards:
  - Uber Video Overview: latency and logs overview.
  - Service Latency & Errors & Redis: route latency (p50/p95), error rate, and Redis ops/sec.
- Grafana UI: http://localhost:3000 (admin/admin). Prometheus UI: http://localhost:9090.

Grafana quick navigation
- Sign in: admin/admin (change after first login if desired).
- Dashboards: Home → Dashboards → Browse → Uber Video Overview, Service Latency & Errors & Redis.
- Example views (place screenshots under docs/observability/):
  - docs/observability/grafana-overview.png
  - docs/observability/grafana-service-metrics.png

Generate demo traffic (optional)
- Run this from repo root after the stack is up to populate traces and metrics:

```
# Hit gateway health repeatedly
for i in $(seq 1 50); do curl -fsS http://localhost:8080/health >/dev/null || true; sleep 0.2; done

# Exercise a subset of the E2E flow quickly
node ./test-e2e-microservices.js || true
```

---

## System Architecture

```mermaid
flowchart LR
    subgraph Client
      U[User/Browser]
    end

    subgraph Frontend
      FE[Static Frontend (Nginx)\n:5173]
    end

    subgraph Gateway
      GW[Nginx API Gateway\n80/443]
    end

    subgraph Core Services
      US[users-service\n:4003]
      CS[captains-service\n:4004]
      RS[rides-service\n:4005]
      MS[maps-service\n:4001]
      SO[socket-service\n:4002]
      PAY[payments-service\n:4006]
      ROUT[routing-service\n:4010]
      ML[ml-inference-service\n:8000]
      BE[backend\n:3000]
      DISP[dispatcher-worker]
    end

    subgraph Infra
      JAEGER[Jaeger all-in-one\n:16686/:4318]
      REDIS[(Redis\n:6379)]
      MONGO[(MongoDB\n:27017)]
      OSRM[osrm-service\n:5000]
    end

    U --> FE
    FE -->|VITE_BASE_URL| GW
    U -->|Direct Dev Calls| GW

    GW --> US
    GW --> CS
    GW --> RS
    GW --> MS
    GW --> SO
    GW --> PAY
    GW --> ROUT
    GW --> ML
    GW --> BE

    US <---> MONGO
    CS <---> MONGO
    RS <---> MONGO
    BE <---> MONGO

    SO <---> REDIS
    DISP <---> REDIS

    MS --> ROUT
    ROUT --> OSRM
    MS --> ML

    US -. OTLP .-> JAEGER
    CS -. OTLP .-> JAEGER
    RS -. OTLP .-> JAEGER
    MS -. OTLP .-> JAEGER
    SO -. OTLP .-> JAEGER
    PAY -. OTLP .-> JAEGER
    ROUT -. OTLP .-> JAEGER
    BE -. OTLP .-> JAEGER
    DISP -. OTLP .-> JAEGER
```

## End-to-End Booking Flow

```mermaid
sequenceDiagram
    autonumber
    participant Client as Client/Frontend
    participant GW as Nginx Gateway
    participant US as users-service
    participant CS as captains-service
    participant RS as rides-service
    participant MS as maps-service
    participant ROUT as routing-service
    participant OSRM as osrm-service
    participant ML as ml-inference
    participant SO as socket-service
    participant PAY as payments-service
    participant REDIS as Redis
    participant MONGO as MongoDB
    participant J as Jaeger (OTLP)

    Client->>GW: GET /health
    GW-->>Client: 200 ok

    Client->>GW: POST /users/register
    GW->>US: /register
    US->>MONGO: insert user
    US-->>Client: 201 {token, user}

    Client->>GW: POST /captains/register
    GW->>CS: /register
    CS->>MONGO: insert captain
    CS-->>Client: 201 {token, captain}

    Client->>GW: GET /rides/get-fare?pickup&destination
    GW->>RS: /get-fare
    RS->>MS: pricing/eta request
    MS->>ROUT: ETA request
    ROUT->>OSRM: /table
    OSRM-->>ROUT: durations
    MS->>ML: adjust ETA/model
    ML-->>MS: eta correction
    MS-->>RS: fares (with surge)
    RS-->>Client: {auto, car, moto, surge}

    Client->>GW: POST /rides/create
    GW->>RS: create
    RS->>MONGO: create ride
    RS->>SO: publish events
    SO->>REDIS: pub/sub
    RS-->>Client: 201 {ride, otp}

    Client->>GW: POST /rides/confirm (captain)
    GW->>RS: confirm
    RS->>MONGO: update ride->accepted
    RS-->>Client: 200

    Client->>GW: GET /rides/start-ride?rideId&otp
    GW->>RS: start
    RS->>MONGO: update ride->ongoing
    RS-->>Client: 200

    Client->>GW: POST /rides/end-ride
    GW->>RS: end
    RS->>MONGO: update ride->completed
    RS-->>Client: 200 {fare}

    Client->>GW: POST /payments/create-intent
    GW->>PAY: create-intent (stub)
    PAY-->>Client: {id, status}

    note over US,DISP: All services emit OTLP traces to Jaeger
```

## Technical Innovations and Design Choices

- Local TLS with HTTP/2
  - Gateway terminates TLS using local self-signed certs mounted via Compose.
  - Upgraded deprecated `listen 443 ssl http2;` to `listen 443 ssl;` + `http2 on;`.
- Safe, repeatable DX on macOS
  - Eliminated macOS AppleDouble/extended-attribute issues in build contexts.
  - Symlink or nospaces working copy to avoid Docker Desktop bind-mount quirks.
- Resilient routing via Docker DNS with request-time resolution
  - Nginx `resolver 127.0.0.11 valid=30s` and `proxy_pass http://$var` pattern reduce stale DNS issues during container restarts.
- End-to-end observability by default
  - OpenTelemetry SDK in each Node service exports to Jaeger (OTLP HTTP).
  - Correlation IDs: gateway and services propagate `X-Correlation-Id` per request.
- Security-hardening in services
  - Helmet default headers, secure cookies, configurable CORS allowlist.
  - JWT with exp and blacklist collection (TTL index via `expires`) to invalidate tokens post-logout.
  - Rate limiting at gateway and express-rate-limit for auth endpoints.
- Operational hygiene
  - Graceful shutdown hooks (SIGTERM/SIGINT) close servers and DB connections.
  - Prometheus metrics (prom-client) with route-level latency histograms.
- Geo+ML integration pattern
  - Maps orchestrates OSRM travel times and ML ETA correction, parameterized surge model.
- Developer productivity
  - Makefile targets for TLS, build/up, smoke, E2E, Jaeger, and OSRM workflows.

---

## Setup

Prerequisites
- Docker Desktop with Compose v2
- Node.js (only if running local scripts outside containers)
- macOS users: remove macOS resource forks to avoid Docker build issues.

Environment
- Copy .env.example to .env and set values (never commit real secrets):
  - JWT_SECRET – required for auth tokens
  - DB_CONNECT – defaults to mongodb://mongo:27017/uber-video
  - CORS_ORIGIN – defaults to http://localhost:5173,http://localhost:8080,https://localhost:8443
  - WANDB_API_KEY – optional for ML training; set to disabled for local

TLS for Localhost
- TLS certs are expected in gateway/certs as fullchain.pem and privkey.pem.
- Generate them with:
  - make tls-generate
- Access gateway over HTTPS: https://localhost:8443 (curl -k for self-signed).

Start the Stack
- Build and start all services:
  - docker compose -f ./docker-compose.yml build --no-cache
  - docker compose -f ./docker-compose.yml up -d

Smoke Checks
- make smoke
  - HTTP and HTTPS health for gateway
  - Jaeger services list

End-to-End Test
- node ./test-e2e-microservices.js
  - Exercises: register/login (user, captain), fare estimate, ride create/confirm/start/end, payment intent, logouts

Jaeger
- Open http://localhost:16686 and look for services like users-service, rides-service, backend, maps-service, routing-service, socket-service, dispatcher-worker.

OSRM Data (optional)
- See Makefile: osrm-fetch, osrm-clip, osrm-build, osrm-up, osrm-verify.

---

## Main Problem Fixed

Symptom
- E2E test failed at POST /users/register with 502 Bad Gateway.
- users-service crashed with “secretOrPrivateKey must have a value” when signing JWT.

Root Cause
- JWT_SECRET environment variable was not set for users/captains/backend, causing jsonwebtoken.sign to throw.

Fix
- Introduced a root .env (ignored by Git) and populated a secure JWT_SECRET.
- Updated .env.example to document required vars.
- Recreated affected services so the secret is available.
- After the fix, the E2E test completes successfully and Jaeger shows traces from all services.

---

## Notable Implementation Details

- Gateway Nginx
  - Migrated from deprecated `listen 443 ssl http2;` to `listen 443 ssl;` with `http2 on;`.
  - Rate limiting via `limit_req_zone` and per-location enforcement.
  - Docker coredns resolver 127.0.0.11 valid=30s to re-resolve container IPs.

- CORS
  - Services compute allowed origins from CORS_ORIGIN env (comma-separated).
  - For local TLS, https://localhost:8443 is included.

- Tracing
  - Each Node service boots a tracing initializer (tracing.js) and exports spans to Jaeger via OTLP HTTP.
  - Correlation IDs propagated via X-Correlation-Id.

- Metrics
  - Users and Captains services have Prometheus metrics at /metrics (prom-client + histogram per route).

- OSRM + Routing
  - osrm-service pre-processes region.osm.pbf into .osrm artifacts.
  - routing-service calls OSRM /table and other endpoints; Makefile has helpers to fetch/clip/build.

- ML Inference
  - FastAPI app exposes ETA model; Makefile has local training helpers to produce models under ml/models.

- Frontend
  - Built with Node and served by Nginx. Uses VITE_BASE_URL to call gateway.

---

## Advanced Features – Recommendations

Production Hardening
- Identity and Access: introduce dedicated auth-service with refresh tokens, password reset, and role claims.
- mTLS and Service Mesh: enforce mTLS between internal services (e.g., with a mesh like Linkerd/Istio).
- Secrets Management: store JWT secrets and API keys in a secret manager (e.g., 1Password, Vault, or Docker Swarm/K8s secrets) rather than .env.
- Rate Limiting and WAF: expand gateway protections (per-route limits, bot filtering, IP allow/deny, request body size limits).
- Input Validation: centralize schema validation with Joi/Zod; standardize 4xx/5xx responses.

Observability & SRE
- Metrics: add a Prometheus + Grafana stack; instrument key business metrics (rides created, acceptance rate, ETA error, payment success rate). Now included: Prometheus at http://localhost:9090 and Grafana at http://localhost:3000 (admin/admin).
- Logging: ship structured logs (pino) to a central store (Loki/ELK).
- Tracing: enrich spans with user/ride IDs, add baggage, propagate correlation IDs across all hops.
- SLOs & Alerts: define SLOs (availability/latency) and set alerting via Alertmanager.

Reliability
- Retries & Circuit Breaking: implement per-service retry/backoff and bulkhead patterns. Consider Envoy or a mesh for resilience policies.
- Idempotency: add idempotency keys for critical POSTs (create-ride, create-intent).
- Caching: introduce per-route caches for maps/routing; add cache invalidation strategies.

Security
- JWT Improvements: rotate secrets, reduce lifetime, add refresh/blacklist lists via Redis with TTL.
- TLS: use mkcert or dev CA for local trust; enable HTTP/3/QUIC on Nginx for modern clients (note: enabling HTTP/3 requires a different Nginx build or a reverse proxy like Caddy/Envoy).
- CSRF/Headers: review cookie flags, CSRF tokens where relevant.

Platform & DX
- CI/CD: GitHub Actions to lint, test, build, publish images, and run E2E.
- Dev Containers: add devcontainer.json for uniform local dev environment.
- Pre-commit Hooks: lint-staged + ESLint/Prettier for consistent code.
- Test Strategy: expand unit/integration tests per service; add chaos testing for resilience.

---

## Known Issues & Tips

- macOS Resource Forks
  - Delete AppleDouble (._*) and .DS_Store files and clear xattrs before builds to avoid noisy contexts.
  - make clean-macos-forks

- Docker Paths with Spaces (macOS)
  - If you see a bind mount error with a host path containing spaces (e.g., /Volumes/T7\ Shield/…), try one of:
    - Use a symlink without spaces: ln -s "/Volumes/T7 Shield/uber-video" "$HOME/uber-video" and run compose from $HOME/uber-video.
    - Or move the project into a path without spaces.

- Compose Version Warning
  - docker-compose.yml no longer specifies a version key (it was obsolete in Compose v2).

---

## Quick Commands

- Build + Up: docker compose -f ./docker-compose.yml build --no-cache && docker compose -f ./docker-compose.yml up -d
- Smoke: make smoke
- E2E: node ./test-e2e-microservices.js
- Jaeger Services: make jaeger-services
- TLS Certs: make tls-generate
- OSRM Verify: make osrm-verify

---

## License

For educational/demo use. Do not use as-is in production without a thorough security and reliability review.

