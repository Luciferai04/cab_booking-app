const axios = require('axios');
const captainModel = require('../models/captain.model');
const { retryWithBackoff } = require('../utils/retry');

const MAPS_BASE_URL = process.env.MAPS_BASE_URL || '';

function useMock() {
    const apiKey = process.env.GOOGLE_MAPS_API;
    return !MAPS_BASE_URL && (!apiKey || apiKey === 'dummy-key' || process.env.USE_MOCK_MAPS === 'true' || process.env.NODE_ENV === 'test');
}

module.exports.getAddressCoordinate = async (address) => {
    if (MAPS_BASE_URL) {
        const res = await retryWithBackoff(() => axios.get(`${MAPS_BASE_URL}/get-coordinates`, { params: { address } }));
        return res.data;
    }
    const apiKey = process.env.GOOGLE_MAPS_API;
    if (useMock()) {
        return { ltd: 12.9716, lng: 77.5946 };
    }
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const response = await retryWithBackoff(() => axios.get(url));
    if (response.data.status === 'OK') {
        const location = response.data.results[ 0 ].geometry.location;
        return { ltd: location.lat, lng: location.lng };
    } else {
        throw new Error('Unable to fetch coordinates');
    }
}

module.exports.getDistanceTime = async (origin, destination) => {
    if (!origin || !destination) {
        throw new Error('Origin and destination are required');
    }

    if (MAPS_BASE_URL) {
        const res = await retryWithBackoff(() => axios.get(`${MAPS_BASE_URL}/get-distance-time`, { params: { origin, destination } }));
        return res.data;
    }

    const apiKey = process.env.GOOGLE_MAPS_API;
    if (useMock()) {
        return { distance: { value: 5000 }, duration: { value: 900 } };
    }
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${apiKey}`;
    const response = await retryWithBackoff(() => axios.get(url));
    if (response.data.status === 'OK') {
        if (response.data.rows[ 0 ].elements[ 0 ].status === 'ZERO_RESULTS') {
            throw new Error('No routes found');
        }
        return response.data.rows[ 0 ].elements[ 0 ];
    } else {
        throw new Error('Unable to fetch distance and time');
    }
}

module.exports.getAutoCompleteSuggestions = async (input) => {
    if (!input) {
        throw new Error('query is required');
    }

    if (MAPS_BASE_URL) {
        const res = await retryWithBackoff(() => axios.get(`${MAPS_BASE_URL}/get-suggestions`, { params: { input } }));
        return res.data;
    }

    const apiKey = process.env.GOOGLE_MAPS_API;
    if (useMock()) {
        return [ 'Mock Place A', 'Mock Place B' ];
    }
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${apiKey}`;
    const response = await retryWithBackoff(() => axios.get(url));
    if (response.data.status === 'OK') {
        return response.data.predictions.map(prediction => prediction.description).filter(value => value);
    } else {
        throw new Error('Unable to fetch suggestions');
    }
}

module.exports.getCaptainsInTheRadius = async (ltd, lng, radiusKm) => {
    const captains = await captainModel.find({
        location: {
            $near: {
                $geometry: { type: 'Point', coordinates: [ lng, ltd ] },
                $maxDistance: Math.max(1, radiusKm * 1000)
            }
        }
    });
    return captains;
}
