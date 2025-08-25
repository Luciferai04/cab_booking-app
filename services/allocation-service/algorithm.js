const Redis = require('ioredis');
const mongoose = require('mongoose');
const winston = require('winston');
const EventEmitter = require('events');

const logger = winston.createLogger({
  transports: [new winston.transports.Console()]
});

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379
});

class DriverAllocationAlgorithm extends EventEmitter {
  constructor() {
    super();
    this.MAX_SEARCH_RADIUS = 10; // km
    this.MIN_DRIVER_RATING = 4.0;
    this.MAX_ALLOCATION_ATTEMPTS = 3;
    this.DRIVER_RESPONSE_TIMEOUT = 30000; // 30 seconds
    this.pendingAllocations = new Map();
  }

  /**
   * Main allocation method - finds and assigns the best driver for a ride
   */
  async allocateDriver(rideRequest) {
    const allocationId = `alloc_${Date.now()}_${rideRequest.rideId}`;
    
    try {
      logger.info(`Starting driver allocation for ride ${rideRequest.rideId}`);
      
      // Step 1: Find nearby available drivers
      const nearbyDrivers = await this.findNearbyDrivers(
        rideRequest.pickup.lat,
        rideRequest.pickup.lng,
        this.MAX_SEARCH_RADIUS
      );

      if (nearbyDrivers.length === 0) {
        throw new Error('No drivers available in the area');
      }

      // Step 2: Filter eligible drivers
      const eligibleDrivers = await this.filterEligibleDrivers(
        nearbyDrivers,
        rideRequest
      );

      if (eligibleDrivers.length === 0) {
        throw new Error('No eligible drivers found');
      }

      // Step 3: Score and rank drivers
      const scoredDrivers = await this.scoreDrivers(eligibleDrivers, rideRequest);
      
      // Step 4: Sort by score (higher is better)
      scoredDrivers.sort((a, b) => b.score - a.score);

      // Step 5: Attempt allocation with top drivers
      const allocatedDriver = await this.attemptAllocation(
        scoredDrivers,
        rideRequest,
        allocationId
      );

      if (!allocatedDriver) {
        throw new Error('Failed to allocate driver after multiple attempts');
      }

      // Step 6: Confirm allocation
      await this.confirmAllocation(allocatedDriver, rideRequest);

      logger.info(`Successfully allocated driver ${allocatedDriver.driverId} to ride ${rideRequest.rideId}`);
      
      return allocatedDriver;

    } catch (error) {
      logger.error(`Allocation failed for ride ${rideRequest.rideId}:`, error);
      await this.handleAllocationFailure(rideRequest, error);
      throw error;
    }
  }

  /**
   * Find drivers within radius using Redis GEO commands
   */
  async findNearbyDrivers(lat, lng, radiusKm) {
    const drivers = await redis.georadius(
      'drivers:location',
      lng,
      lat,
      radiusKm,
      'km',
      'WITHDIST',
      'WITHCOORD',
      'ASC'
    );

    const nearbyDrivers = [];
    
    for (const [driverId, distance, [driverLng, driverLat]] of drivers) {
      // Get driver details from cache
      const driverData = await redis.hgetall(`driver:${driverId}`);
      
      if (driverData && driverData.status === 'available') {
        nearbyDrivers.push({
          driverId,
          distance: parseFloat(distance),
          location: {
            lat: parseFloat(driverLat),
            lng: parseFloat(driverLng)
          },
          ...driverData,
          rating: parseFloat(driverData.rating || 5.0),
          completionRate: parseFloat(driverData.completionRate || 0.95),
          acceptanceRate: parseFloat(driverData.acceptanceRate || 0.90)
        });
      }
    }

    return nearbyDrivers;
  }

  /**
   * Filter drivers based on eligibility criteria
   */
  async filterEligibleDrivers(drivers, rideRequest) {
    const eligible = [];

    for (const driver of drivers) {
      // Check basic criteria
      if (driver.rating < this.MIN_DRIVER_RATING) continue;
      
      // Check vehicle type
      if (rideRequest.vehicleType && 
          driver.vehicleType !== rideRequest.vehicleType) continue;
      
      // Check vehicle capacity
      if (rideRequest.passengerCount > 
          (driver.vehicleCapacity || 4)) continue;
      
      // Check if driver is not on another ride
      const onRide = await redis.exists(`driver:${driver.driverId}:current_ride`);
      if (onRide) continue;
      
      // Check if driver hasn't rejected this ride before
      const rejected = await redis.sismember(
        `ride:${rideRequest.rideId}:rejected_drivers`,
        driver.driverId
      );
      if (rejected) continue;
      
      // Check driver's work hours
      if (!this.isWithinWorkHours(driver)) continue;
      
      // Check if driver has required certifications for special rides
      if (rideRequest.requirements) {
        if (!this.meetsRequirements(driver, rideRequest.requirements)) continue;
      }

      eligible.push(driver);
    }

    return eligible;
  }

  /**
   * Score drivers based on multiple factors
   */
  async scoreDrivers(drivers, rideRequest) {
    const scoredDrivers = [];

    for (const driver of drivers) {
      const score = await this.calculateDriverScore(driver, rideRequest);
      scoredDrivers.push({
        ...driver,
        score,
        scoreBreakdown: score.breakdown
      });
    }

    return scoredDrivers;
  }

  /**
   * Calculate comprehensive score for a driver
   */
  async calculateDriverScore(driver, request) {
    const weights = {
      distance: 0.35,      // 35% weight
      rating: 0.20,        // 20% weight
      completion: 0.15,    // 15% weight
      acceptance: 0.10,    // 10% weight
      experience: 0.10,    // 10% weight
      vehicleAge: 0.05,    // 5% weight
      loyalty: 0.05        // 5% weight
    };

    // Distance score (closer is better)
    const maxDistance = this.MAX_SEARCH_RADIUS;
    const distanceScore = Math.max(0, 100 * (1 - driver.distance / maxDistance));

    // Rating score (higher is better)
    const ratingScore = (driver.rating / 5) * 100;

    // Completion rate score
    const completionScore = driver.completionRate * 100;

    // Acceptance rate score
    const acceptanceScore = driver.acceptanceRate * 100;

    // Experience score (based on total trips)
    const totalTrips = parseInt(driver.totalTrips || 0);
    const experienceScore = Math.min(100, (totalTrips / 1000) * 100);

    // Vehicle age score (newer is better)
    const vehicleAge = new Date().getFullYear() - (driver.vehicleYear || 2020);
    const vehicleAgeScore = Math.max(0, 100 - (vehicleAge * 10));

    // Loyalty score (based on time with platform)
    const joinDate = new Date(driver.joinedAt || Date.now());
    const monthsActive = (Date.now() - joinDate) / (1000 * 60 * 60 * 24 * 30);
    const loyaltyScore = Math.min(100, (monthsActive / 24) * 100);

    // Apply special bonuses/penalties
    let bonusMultiplier = 1.0;

    // Bonus for premium drivers
    if (driver.isPremium) bonusMultiplier *= 1.1;

    // Bonus for drivers in high-demand areas
    const isDemandArea = await this.isHighDemandArea(driver.location);
    if (isDemandArea) bonusMultiplier *= 1.05;

    // Penalty for recent complaints
    const recentComplaints = parseInt(driver.recentComplaints || 0);
    if (recentComplaints > 0) bonusMultiplier *= (1 - 0.1 * recentComplaints);

    // Calculate weighted score
    const baseScore = 
      (distanceScore * weights.distance) +
      (ratingScore * weights.rating) +
      (completionScore * weights.completion) +
      (acceptanceScore * weights.acceptance) +
      (experienceScore * weights.experience) +
      (vehicleAgeScore * weights.vehicleAge) +
      (loyaltyScore * weights.loyalty);

    const finalScore = baseScore * bonusMultiplier;

    return {
      total: Math.round(finalScore * 100) / 100,
      breakdown: {
        distance: distanceScore,
        rating: ratingScore,
        completion: completionScore,
        acceptance: acceptanceScore,
        experience: experienceScore,
        vehicleAge: vehicleAgeScore,
        loyalty: loyaltyScore,
        bonusMultiplier
      }
    };
  }

  /**
   * Attempt to allocate drivers in order of preference
   */
  async attemptAllocation(scoredDrivers, rideRequest, allocationId) {
    let attemptCount = 0;
    
    for (const driver of scoredDrivers) {
      if (attemptCount >= this.MAX_ALLOCATION_ATTEMPTS) {
        break;
      }

      attemptCount++;
      
      // Send allocation request to driver
      const accepted = await this.sendAllocationRequest(
        driver,
        rideRequest,
        allocationId
      );

      if (accepted) {
        return driver;
      }

      // Driver rejected, add to rejected list
      await redis.sadd(
        `ride:${rideRequest.rideId}:rejected_drivers`,
        driver.driverId
      );
    }

    return null;
  }

  /**
   * Send allocation request to driver and wait for response
   */
  async sendAllocationRequest(driver, rideRequest, allocationId) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingAllocations.delete(allocationId);
        resolve(false);
      }, this.DRIVER_RESPONSE_TIMEOUT);

      // Store pending allocation
      this.pendingAllocations.set(allocationId, {
        driver,
        rideRequest,
        timeoutId,
        resolve
      });

      // Publish allocation request to driver
      redis.publish(`driver:${driver.driverId}:requests`, JSON.stringify({
        type: 'RIDE_REQUEST',
        allocationId,
        ride: {
          rideId: rideRequest.rideId,
          pickup: rideRequest.pickup,
          dropoff: rideRequest.dropoff,
          estimatedFare: rideRequest.estimatedFare,
          distance: rideRequest.distance,
          duration: rideRequest.duration,
          passengerName: rideRequest.passengerName,
          passengerRating: rideRequest.passengerRating
        },
        expiresAt: Date.now() + this.DRIVER_RESPONSE_TIMEOUT
      }));

      // Log the request
      logger.info(`Sent allocation request ${allocationId} to driver ${driver.driverId}`);
    });
  }

  /**
   * Handle driver response to allocation request
   */
  async handleDriverResponse(allocationId, driverId, accepted) {
    const pending = this.pendingAllocations.get(allocationId);
    
    if (!pending) {
      logger.warn(`No pending allocation found for ${allocationId}`);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingAllocations.delete(allocationId);

    if (accepted) {
      // Update driver status
      await redis.hset(`driver:${driverId}`, 'status', 'assigned');
      await redis.set(
        `driver:${driverId}:current_ride`,
        pending.rideRequest.rideId
      );
    }

    pending.resolve(accepted);
  }

  /**
   * Confirm the allocation and update all systems
   */
  async confirmAllocation(driver, rideRequest) {
    // Update ride status
    await redis.hset(`ride:${rideRequest.rideId}`, {
      status: 'driver_assigned',
      driverId: driver.driverId,
      assignedAt: Date.now(),
      estimatedArrival: this.calculateETA(driver.distance)
    });

    // Update driver metrics
    await redis.hincrby(`driver:${driver.driverId}`, 'assignedRides', 1);

    // Notify passenger
    await redis.publish(`passenger:${rideRequest.passengerId}:updates`, JSON.stringify({
      type: 'DRIVER_ASSIGNED',
      driver: {
        id: driver.driverId,
        name: driver.name,
        photo: driver.photo,
        rating: driver.rating,
        vehicle: {
          make: driver.vehicleMake,
          model: driver.vehicleModel,
          color: driver.vehicleColor,
          plate: driver.vehiclePlate
        },
        location: driver.location,
        estimatedArrival: this.calculateETA(driver.distance)
      }
    }));

    // Emit allocation event
    this.emit('driver_allocated', {
      rideId: rideRequest.rideId,
      driverId: driver.driverId,
      timestamp: Date.now()
    });
  }

  /**
   * Handle allocation failure
   */
  async handleAllocationFailure(rideRequest, error) {
    // Update ride status
    await redis.hset(`ride:${rideRequest.rideId}`, {
      status: 'allocation_failed',
      failureReason: error.message,
      failedAt: Date.now()
    });

    // Notify passenger
    await redis.publish(`passenger:${rideRequest.passengerId}:updates`, JSON.stringify({
      type: 'ALLOCATION_FAILED',
      reason: error.message,
      rideId: rideRequest.rideId
    }));

    // Log for monitoring
    logger.error(`Allocation failed for ride ${rideRequest.rideId}:`, error);

    // Emit failure event
    this.emit('allocation_failed', {
      rideId: rideRequest.rideId,
      reason: error.message,
      timestamp: Date.now()
    });
  }

  /**
   * Check if driver is within work hours
   */
  isWithinWorkHours(driver) {
    if (!driver.workSchedule) return true;

    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();

    const schedule = driver.workSchedule[currentDay];
    if (!schedule || !schedule.isWorking) return false;

    return currentHour >= schedule.startHour && currentHour < schedule.endHour;
  }

  /**
   * Check if driver meets special requirements
   */
  meetsRequirements(driver, requirements) {
    if (requirements.wheelchair && !driver.wheelchairAccessible) return false;
    if (requirements.childSeat && !driver.hasChildSeat) return false;
    if (requirements.petFriendly && !driver.petFriendly) return false;
    if (requirements.femaleDriver && driver.gender !== 'female') return false;
    
    return true;
  }

  /**
   * Check if location is in high demand area
   */
  async isHighDemandArea(location) {
    const demandScore = await redis.get(
      `demand:${Math.floor(location.lat)}_${Math.floor(location.lng)}`
    );
    return parseFloat(demandScore || 0) > 0.7;
  }

  /**
   * Calculate estimated time of arrival
   */
  calculateETA(distanceKm) {
    // Assume average speed of 30 km/h in city
    const avgSpeedKmh = 30;
    const etaMinutes = Math.ceil((distanceKm / avgSpeedKmh) * 60);
    return Date.now() + (etaMinutes * 60 * 1000);
  }

  /**
   * Rebalance drivers to high-demand areas
   */
  async rebalanceDrivers() {
    // This would run periodically to suggest drivers move to high-demand areas
    const demandHeatmap = await this.getDemandHeatmap();
    const availableDrivers = await this.getIdleDrivers();

    for (const driver of availableDrivers) {
      const optimalLocation = this.findOptimalLocation(
        driver.location,
        demandHeatmap
      );

      if (optimalLocation) {
        await redis.publish(`driver:${driver.driverId}:suggestions`, JSON.stringify({
          type: 'REBALANCE_SUGGESTION',
          location: optimalLocation,
          incentive: this.calculateIncentive(driver.location, optimalLocation)
        }));
      }
    }
  }

  /**
   * Get demand heatmap
   */
  async getDemandHeatmap() {
    const keys = await redis.keys('demand:*');
    const heatmap = [];

    for (const key of keys) {
      const [, coords] = key.split(':');
      const [lat, lng] = coords.split('_').map(parseFloat);
      const demand = await redis.get(key);
      
      heatmap.push({
        lat,
        lng,
        demand: parseFloat(demand)
      });
    }

    return heatmap;
  }

  /**
   * Find optimal location for driver based on demand
   */
  findOptimalLocation(currentLocation, demandHeatmap) {
    const nearbyHighDemand = demandHeatmap
      .filter(point => {
        const distance = this.calculateDistance(
          currentLocation.lat,
          currentLocation.lng,
          point.lat,
          point.lng
        );
        return distance < 5 && point.demand > 0.7; // Within 5km and high demand
      })
      .sort((a, b) => b.demand - a.demand);

    return nearbyHighDemand[0] || null;
  }

  /**
   * Calculate incentive for rebalancing
   */
  calculateIncentive(from, to) {
    const distance = this.calculateDistance(
      from.lat,
      from.lng,
      to.lat,
      to.lng
    );
    
    // Base incentive + distance bonus
    const baseIncentive = 5;
    const distanceBonus = distance * 0.5;
    
    return baseIncentive + distanceBonus;
  }

  /**
   * Calculate distance between two points (Haversine formula)
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * Get idle drivers
   */
  async getIdleDrivers() {
    const allDrivers = await redis.smembers('drivers:active');
    const idleDrivers = [];

    for (const driverId of allDrivers) {
      const status = await redis.hget(`driver:${driverId}`, 'status');
      if (status === 'available') {
        const driverData = await redis.hgetall(`driver:${driverId}`);
        idleDrivers.push({
          driverId,
          ...driverData,
          location: {
            lat: parseFloat(driverData.lat),
            lng: parseFloat(driverData.lng)
          }
        });
      }
    }

    return idleDrivers;
  }
}

module.exports = DriverAllocationAlgorithm;
