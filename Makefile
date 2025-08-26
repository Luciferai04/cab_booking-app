# OSRM automation for dataset management and service lifecycle

COMPOSE := docker compose -f "./docker-compose.yml"
OSRM_SVC := osrm-service
OSRM_PBF := services/osrm-service/region.osm.pbf

# Default region URL: Eastern India zone (covers Kolkata / West Bengal)
# Override with: make osrm-fetch REGION_URL=https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf
REGION_URL ?= https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf

# Buildx platform (e.g., linux/amd64 or linux/arm64)
PLATFORM ?= linux/amd64

.PHONY: osrm-fetch osrm-build osrm-up osrm-restart osrm-swap osrm-status osrm-logs osrm-test osrm-verify osrm-buildx osrm-build-amd64 osrm-clip osrm-clip-and-build osrm-clip-city ml-train-eta ml-serve

osrm-fetch:
	@if [ -z "$(REGION_URL)" ]; then echo "REGION_URL is required"; exit 1; fi
	@echo "Downloading OSM extract from $(REGION_URL) ..."
	@curl -L --fail --retry 3 --retry-connrefused --connect-timeout 20 -o "$(OSRM_PBF)" "$(REGION_URL)"
	@ls -lh "$(OSRM_PBF)"

osrm-build:
	@echo "Building $(OSRM_SVC) image (no cache) ..."
	@$(COMPOSE) build --no-cache $(OSRM_SVC)

# Build for a specific platform using Buildx and load into local Docker
osrm-buildx:
	@echo "Buildx building $(OSRM_SVC) for $(PLATFORM) ..."
	@docker buildx build --platform $(PLATFORM) --load -t uber-video-osrm-service:latest ./services/osrm-service

# Convenience target for amd64 (Apple Silicon hosts with x86 image requirement)
osrm-build-amd64:
	@$(MAKE) osrm-buildx PLATFORM=linux/amd64

osrm-up:
	@echo "Starting $(OSRM_SVC) ..."
	@$(COMPOSE) up -d $(OSRM_SVC)

osrm-restart:
	@echo "Restarting $(OSRM_SVC) ..."
	@$(COMPOSE) up -d --force-recreate $(OSRM_SVC)

osrm-swap: osrm-fetch osrm-build osrm-up
	@echo "Swapped dataset and (re)started $(OSRM_SVC)."

osrm-status:
	@$(COMPOSE) ps $(OSRM_SVC)

osrm-logs:
	@$(COMPOSE) logs --no-color --no-log-prefix --since=10m $(OSRM_SVC)

# Simple runtime check: call /table on a pair in central Kolkata.
# Note OSRM expects coordinates as lon,lat ordered pairs.
OSRM_TEST_COORDS := 88.3639,22.5726;88.3426,22.5448
osrm-test:
	@echo "Testing OSRM /table with coordinates $(OSRM_TEST_COORDS) ..."
	@$(COMPOSE) exec -T $(OSRM_SVC) curl -s "http://localhost:5000/table?annotations=duration,distance&sources=0&destinations=1&coordinates=$(OSRM_TEST_COORDS)" | jq . || true

# End-to-end sanity via gateway -> maps -> routing -> OSRM
osrm-verify:
	@echo "Verifying through gateway /maps/multi-eta ..."
	@curl -s "http://localhost:8080/maps/multi-eta?sources=22.5726,88.3639;22.5892,88.4085&destination=22.5448,88.3426&boundSec=1200" | jq . || true

# Clip dataset to Kolkata bounding box using osmium in a container
# Default bbox: minlon,minlat,maxlon,maxlat (Kolkata approx)
BBOX ?= 88.20,22.40,88.50,22.70
# Local osmium image (built from tools/osmium)
OSMIUM_IMG := uber-video-osmium:latest

osrm-osmium-image:
	@echo "Building local osmium image ..."
	@docker build -t $(OSMIUM_IMG) ./tools/osmium

osrm-clip:
	@echo "Clipping $(OSRM_PBF) to bbox $(BBOX) ..."
	@if command -v osmium >/dev/null 2>&1; then \
		osmium extract -b $(BBOX) -o services/osrm-service/region-clipped.osm.pbf $(OSRM_PBF); \
	else \
		echo "osmium not found on host. Building local container image and running inside..."; \
		$(MAKE) osrm-osmium-image; \
		docker run --rm -u $(shell id -u):$(shell id -g) -v $(PWD):/work -w /work $(OSMIUM_IMG) \
			osmium extract -b $(BBOX) -o services/osrm-service/region-clipped.osm.pbf $(OSRM_PBF); \
	fi
	@mv -f services/osrm-service/region-clipped.osm.pbf $(OSRM_PBF)
	@ls -lh "$(OSRM_PBF)"

osrm-clip-and-build: osrm-clip osrm-build-amd64 osrm-up
	@echo "Clipped, built (amd64), and restarted OSRM."

# Quick BBOX presets per city
osrm-clip-city:
	@if [ -z "$(CITY)" ]; then echo "Usage: make osrm-clip-city CITY=kolkata|bangalore|mumbai|delhi"; exit 1; fi
	@case "$(CITY)" in \
		kolkata) BBOX=88.20,22.40,88.50,22.70 ;; \
		bangalore) BBOX=77.45,12.80,77.75,13.20 ;; \
		mumbai) BBOX=72.75,18.85,72.995,19.30 ;; \
		delhi) BBOX=76.80,28.35,77.35,28.90 ;; \
		*) echo "Unknown CITY: $(CITY)"; exit 1 ;; \
	esac; \
	$(MAKE) osrm-clip BBOX=$$BBOX; \
	$(MAKE) osrm-build-amd64; \
	$(MAKE) osrm-up
	@echo "Clipped to $(CITY) and restarted OSRM."

# ML helpers
ML_IN := ml/samples/trips.csv
ML_MODEL := ml/models/eta_calibration.joblib
ml-train-eta:
	@mkdir -p ml/models
	@python3 ml/scripts/train_eta_calibration.py --input $(ML_IN) --output $(ML_MODEL)
	@echo "ETA calibration model trained at $(ML_MODEL)"

DEMAND_IN := ml/samples/demand.csv
DEMAND_MODEL := ml/models/demand_forecast.joblib
ml-train-demand:
	@mkdir -p ml/models
	@python3 ml/scripts/train_demand_forecast.py --input $(DEMAND_IN) --output $(DEMAND_MODEL)
	@echo "Demand model trained at $(DEMAND_MODEL)"

ml-serve:
	@docker compose build --no-cache ml-inference-service
	@docker compose up -d ml-inference-service
	@docker compose ps ml-inference-service

clean-macos-forks:
	@echo "Removing macOS resource fork files (._*) recursively..."
	@find . -type f -name "._*" -print -delete || true

# Generate local self-signed TLS certificates for localhost
.PHONY: tls-generate
tls-generate:
	@mkdir -p gateway/certs
	@if [ -f gateway/certs/fullchain.pem ] && [ -f gateway/certs/privkey.pem ]; then \
		echo "TLS certs already exist under gateway/certs"; \
	else \
		echo "Generating self-signed cert for localhost..."; \
		openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
			-subj "/CN=localhost" \
			-addext "subjectAltName = DNS:localhost,IP:127.0.0.1" \
			-keyout gateway/certs/privkey.pem -out gateway/certs/fullchain.pem; \
		ls -l gateway/certs/fullchain.pem gateway/certs/privkey.pem; \
	fi

# Quick stack helpers
.PHONY: stack-up stack-rebuild stack-down gateway-restart smoke e2e jaeger-services
stack-up:
	@$(COMPOSE) up -d

stack-rebuild:
	@$(COMPOSE) build --no-cache
	@$(COMPOSE) up -d

stack-down:
	@$(COMPOSE) down

gateway-restart:
	@$(COMPOSE) up -d --force-recreate gateway

gateway-build-prod:
	@echo "Building gateway with production nginx.conf (HTTPS-only)..."
	@$(COMPOSE) build --build-arg NGINX_CONF=nginx.prod.conf gateway
	@$(COMPOSE) up -d gateway

gateway-build-dev:
	@echo "Building gateway with development nginx.conf (HTTP + HTTPS)..."
	@$(COMPOSE) build --build-arg NGINX_CONF=nginx.conf gateway
	@$(COMPOSE) up -d gateway

gateway-use-prod: gateway-build-prod
	@echo "Gateway now using production config"

gateway-use-dev: gateway-build-dev
	@echo "Gateway now using development config"

gateway-build-staging:
	@echo "Building gateway with staging nginx.conf (strict TLS) ..."
	@$(COMPOSE) build --build-arg NGINX_CONF=nginx.staging.conf gateway
	@$(COMPOSE) up -d gateway

gateway-use-staging: gateway-build-staging
	@echo "Gateway now using staging config"

smoke-prod:
	@bash ./scripts/smoke-prod.sh

smoke:
	@echo "HTTP health:" && curl -fsS http://localhost:8080/health && echo
	@echo "HTTPS health:" && curl -skf https://localhost:8443/health && echo
	@echo "Jaeger services:" && curl -fsS http://localhost:16686/api/services | jq . || true

e2e:
	@node test-e2e-microservices.js || true

jaeger-services:
	@curl -fsS http://localhost:16686/api/services | jq .

