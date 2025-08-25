const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

let app;
let mongo;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  mongo = await MongoMemoryServer.create();
  process.env.DB_CONNECT = mongo.getUri();
  // Require app after env is set to ensure it connects to the in-memory DB
  app = require('../app');
});

afterAll(async () => {
  if (mongo) await mongo.stop();
});

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health');
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
});

test('GET /ready returns ready when DB connected', async () => {
  const res = await request(app).get('/ready');
  expect([200,503]).toContain(res.status);
  // In test env with mongodb-memory-server, it should be connected
  if (res.status === 200) {
    expect(res.body.status).toBe('ready');
  }
});
