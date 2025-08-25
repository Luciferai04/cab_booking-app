# OSRM dataset setup

This service packages an OSRM backend preprocessed with MLD.

Quick start (Kolkata / Eastern India)

- Swap the dataset and restart OSRM:
  make osrm-swap REGION_URL=https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf

- Check container status and logs:
  make osrm-status
  make osrm-logs

- Test OSRM directly (inside the container):
  make osrm-test

- Verify via gateway -> maps-service -> routing-service -> OSRM:
  make osrm-verify

Notes

- Coordinates are lon,lat for OSRM APIs.
- For a different city/region, point REGION_URL to an appropriate .osm.pbf. Examples:
  - India (entire country): https://download.geofabrik.de/asia/india-latest.osm.pbf
  - Eastern zone (covers West Bengal/Kolkata): https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf
- On Apple Silicon hosts, docker-compose sets platform: linux/amd64 for this service to ensure compatibility with osrm/osrm-backend.

