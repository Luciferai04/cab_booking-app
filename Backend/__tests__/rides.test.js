// Mock maps.service and socket to avoid network and sockets in tests
jest.mock('../services/maps.service', () => ({
  getDistanceTime: jest.fn(async () => ({
    distance: { value: 5000 }, // 5 km
    duration: { value: 900 }   // 15 min
  })),
  getAddressCoordinate: jest.fn(async () => ({ ltd: 12.34, lng: 56.78 })),
  getAutoCompleteSuggestions: jest.fn(async () => ['A', 'B']),
  getCaptainsInTheRadius: jest.fn(async () => [])
}));

jest.mock('../socket', () => ({
  sendMessageToSocketId: jest.fn()
}));

const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app;
let mongo;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  mongo = await MongoMemoryServer.create();
  process.env.DB_CONNECT = mongo.getUri();
  app = require('../app');
});

afterAll(async () => {
  if (mongo) await mongo.stop();
});

function parseCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  return cookies.length ? cookies[0] : '';
}

test('get fare requires auth and returns computed fares', async () => {
  const email = `test+${Date.now()}@example.com`;
  await request(app).post('/users/register').send({ fullname: { firstname: 'Test', lastname: 'User' }, email, password: 'secret123' });
  const login = await request(app).post('/users/login').send({ email, password: 'secret123' });
  const cookie = parseCookie(login);

  const res = await request(app)
    .get('/rides/get-fare')
    .set('Cookie', cookie)
    .query({ pickup: 'A', destination: 'B' });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('auto');
  expect(res.body).toHaveProperty('car');
  expect(res.body).toHaveProperty('moto');
});

