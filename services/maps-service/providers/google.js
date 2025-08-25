const { Client } = require('@googlemaps/google-maps-services-js');
const Redis = require('ioredis');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const logger = winston.createLogger({
  transports: [new winston.transports.Console()]
});

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379
});

class GoogleMapsProvider {
  constructor() {
    this.client = new Client({});
    this.apiKey = process.env.GOOGLE_MAPS_API_KEY;
    this.cacheExpiry = parseInt(process.env.CACHE_EXPIRY || '3600');
  }

  /**
   * Get driving route between two points with traffic consideration
   */
  async getRoute(origin, destination, options = {}) {
    const cacheKey = `route:${origin.lat},${origin.lng}:${destination.lat},${destination.lng}`;
    
    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached && !options.skipCache) {
      return JSON.parse(cached);
    }

    try {
      const response = await this.client.directions({
        params: {
          origin: `${origin.lat},${origin.lng}`,
          destination: `${destination.lat},${destination.lng}`,
          mode: options.mode || 'driving',
          alternatives: true,
          departure_time: options.departureTime || 'now',
          traffic_model: 'best_guess',
          key: this.apiKey
        }
      });

      if (response.data.status !== 'OK') {
        throw new Error(`Google Maps API error: ${response.data.status}`);
      }

      const routes = response.data.routes.map(route => ({
        distance: route.legs[0].distance,
        duration: route.legs[0].duration,
        duration_in_traffic: route.legs[0].duration_in_traffic,
        polyline: route.overview_polyline.points,
        bounds: route.bounds,
        steps: route.legs[0].steps.map(step => ({
          distance: step.distance,
          duration: step.duration,
          instruction: step.html_instructions,
          polyline: step.polyline.points,
          start_location: step.start_location,
          end_location: step.end_location
        }))
      }));

      // Cache the result
      await redis.setex(cacheKey, this.cacheExpiry, JSON.stringify(routes));

      return routes;
    } catch (error) {
      logger.error('Error getting route from Google Maps:', error);
      throw error;
    }
  }

  /**
   * Get distance matrix for multiple origins and destinations
   */
  async getDistanceMatrix(origins, destinations) {
    try {
      const response = await this.client.distancematrix({
        params: {
          origins: origins.map(o => `${o.lat},${o.lng}`),
          destinations: destinations.map(d => `${d.lat},${d.lng}`),
          mode: 'driving',
          departure_time: 'now',
          traffic_model: 'best_guess',
          key: this.apiKey
        }
      });

      if (response.data.status !== 'OK') {
        throw new Error(`Distance Matrix API error: ${response.data.status}`);
      }

      const results = [];
      response.data.rows.forEach((row, originIndex) => {
        row.elements.forEach((element, destIndex) => {
          if (element.status === 'OK') {
            results.push({
              origin: origins[originIndex],
              destination: destinations[destIndex],
              distance: element.distance,
              duration: element.duration,
              duration_in_traffic: element.duration_in_traffic
            });
          }
        });
      });

      return results;
    } catch (error) {
      logger.error('Error getting distance matrix:', error);
      throw error;
    }
  }

  /**
   * Geocode an address to coordinates
   */
  async geocode(address) {
    const cacheKey = `geocode:${address}`;
    
    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    try {
      const response = await this.client.geocode({
        params: {
          address: address,
          key: this.apiKey
        }
      });

      if (response.data.status !== 'OK' || !response.data.results.length) {
        throw new Error('Address not found');
      }

      const result = {
        lat: response.data.results[0].geometry.location.lat,
        lng: response.data.results[0].geometry.location.lng,
        formatted_address: response.data.results[0].formatted_address,
        place_id: response.data.results[0].place_id
      };

      // Cache for 24 hours
      await redis.setex(cacheKey, 86400, JSON.stringify(result));

      return result;
    } catch (error) {
      logger.error('Error geocoding address:', error);
      throw error;
    }
  }

  /**
   * Reverse geocode coordinates to address
   */
  async reverseGeocode(lat, lng) {
    const cacheKey = `reverse:${lat},${lng}`;
    
    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    try {
      const response = await this.client.reverseGeocode({
        params: {
          latlng: `${lat},${lng}`,
          key: this.apiKey
        }
      });

      if (response.data.status !== 'OK' || !response.data.results.length) {
        throw new Error('Location not found');
      }

      const result = {
        formatted_address: response.data.results[0].formatted_address,
        place_id: response.data.results[0].place_id,
        components: response.data.results[0].address_components
      };

      // Cache for 24 hours
      await redis.setex(cacheKey, 86400, JSON.stringify(result));

      return result;
    } catch (error) {
      logger.error('Error reverse geocoding:', error);
      throw error;
    }
  }

  /**
   * Get place details including photos
   */
  async getPlaceDetails(placeId) {
    try {
      const response = await this.client.placeDetails({
        params: {
          place_id: placeId,
          fields: ['name', 'formatted_address', 'geometry', 'photo', 'rating', 'opening_hours'],
          key: this.apiKey
        }
      });

      if (response.data.status !== 'OK') {
        throw new Error(`Place Details API error: ${response.data.status}`);
      }

      return response.data.result;
    } catch (error) {
      logger.error('Error getting place details:', error);
      throw error;
    }
  }

  /**
   * Autocomplete place search
   */
  async placeAutocomplete(input, location = null, radius = 50000) {
    try {
      const params = {
        input,
        key: this.apiKey,
        types: 'geocode'
      };

      if (location) {
        params.location = `${location.lat},${location.lng}`;
        params.radius = radius;
      }

      const response = await this.client.placeAutocomplete({
        params
      });

      if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
        throw new Error(`Autocomplete API error: ${response.data.status}`);
      }

      return response.data.predictions.map(pred => ({
        place_id: pred.place_id,
        description: pred.description,
        structured_formatting: pred.structured_formatting
      }));
    } catch (error) {
      logger.error('Error in place autocomplete:', error);
      throw error;
    }
  }

  /**
   * Calculate fare estimate based on distance and duration
   */
  calculateFareEstimate(distanceMeters, durationSeconds, vehicleType, surgeMultiplier = 1.0) {
    const distanceKm = distanceMeters / 1000;
    const durationMin = durationSeconds / 60;

    // Base fare structure (customize per region/regulations)
    const fareStructure = {
      economy: {
        baseFare: 2.50,
        perKm: 1.20,
        perMin: 0.15,
        minFare: 5.00,
        bookingFee: 1.50
      },
      premium: {
        baseFare: 4.00,
        perKm: 1.80,
        perMin: 0.25,
        minFare: 8.00,
        bookingFee: 2.00
      },
      luxury: {
        baseFare: 6.00,
        perKm: 2.50,
        perMin: 0.40,
        minFare: 12.00,
        bookingFee: 3.00
      },
      xl: {
        baseFare: 4.50,
        perKm: 1.60,
        perMin: 0.20,
        minFare: 7.00,
        bookingFee: 2.00
      }
    };

    const rates = fareStructure[vehicleType] || fareStructure.economy;
    
    let fare = rates.baseFare + 
               (distanceKm * rates.perKm) + 
               (durationMin * rates.perMin) + 
               rates.bookingFee;
    
    // Apply surge pricing
    fare *= surgeMultiplier;
    
    // Apply minimum fare
    fare = Math.max(fare, rates.minFare * surgeMultiplier);
    
    // Calculate taxes (customize per region)
    const taxRate = 0.15; // 15% tax
    const taxes = fare * taxRate;
    const totalFare = fare + taxes;

    return {
      baseFare: parseFloat(fare.toFixed(2)),
      surgeMultiplier,
      taxes: parseFloat(taxes.toFixed(2)),
      total: parseFloat(totalFare.toFixed(2)),
      currency: 'USD',
      breakdown: {
        base: rates.baseFare,
        distance: parseFloat((distanceKm * rates.perKm).toFixed(2)),
        time: parseFloat((durationMin * rates.perMin).toFixed(2)),
        booking: rates.bookingFee
      }
    };
  }

  /**
   * Track real-time location
   */
  async trackLocation(tripId, location) {
    const key = `trip:location:${tripId}`;
    const timestamp = Date.now();
    
    // Store in sorted set for time-series data
    await redis.zadd(key, timestamp, JSON.stringify({
      ...location,
      timestamp
    }));
    
    // Expire after 24 hours
    await redis.expire(key, 86400);
    
    // Publish to real-time subscribers
    await redis.publish(`trip:tracking:${tripId}`, JSON.stringify({
      tripId,
      location,
      timestamp
    }));
  }

  /**
   * Get trip location history
   */
  async getTripLocationHistory(tripId, startTime = 0, endTime = Date.now()) {
    const key = `trip:location:${tripId}`;
    const locations = await redis.zrangebyscore(key, startTime, endTime);
    
    return locations.map(loc => JSON.parse(loc));
  }

  /**
   * Check if location is within a geofence
   */
  isLocationInGeofence(location, geofence) {
    // Simple point-in-polygon algorithm
    const { lat, lng } = location;
    const polygon = geofence.coordinates[0];
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][1], yi = polygon[i][0];
      const xj = polygon[j][1], yj = polygon[j][0];

      const intersect = ((yi > lng) !== (yj > lng))
          && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }

    return inside;
  }

  /**
   * Find nearby points of interest
   */
  async findNearbyPlaces(location, type, radius = 1000) {
    try {
      const response = await this.client.placesNearby({
        params: {
          location: `${location.lat},${location.lng}`,
          radius,
          type,
          key: this.apiKey
        }
      });

      if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
        throw new Error(`Places API error: ${response.data.status}`);
      }

      return response.data.results.map(place => ({
        place_id: place.place_id,
        name: place.name,
        vicinity: place.vicinity,
        location: place.geometry.location,
        rating: place.rating,
        types: place.types
      }));
    } catch (error) {
      logger.error('Error finding nearby places:', error);
      throw error;
    }
  }
}

module.exports = GoogleMapsProvider;
