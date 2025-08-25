FROM osrm/osrm-backend:latest
WORKDIR /data
# Expect an OSM PBF provided at build time
COPY region.osm.pbf /data/region.osm.pbf
# Prepare the dataset (MLD algorithm)
RUN osrm-extract -p /opt/car.lua /data/region.osm.pbf \
 && osrm-partition /data/region.osrm \
 && osrm-customize /data/region.osrm
EXPOSE 5000
CMD ["osrm-routed", "--algorithm", "mld", "/data/region.osrm"]

