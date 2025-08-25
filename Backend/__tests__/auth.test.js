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

test('user register, login, profile, logout flow', async () => {
  const email = `test+${Date.now()}@example.com`;

  const register = await request(app)
    .post('/users/register')
    .send({ fullname: { firstname: 'Test', lastname: 'User' }, email, password: 'secret123' });
  expect(register.status).toBe(201);
  expect(register.body.user).toBeDefined();
  expect(register.body.user.password).toBeUndefined();

  const login = await request(app)
    .post('/users/login')
    .send({ email, password: 'secret123' });
  expect(login.status).toBe(200);
  const cookie = parseCookie(login);
  expect(cookie).toMatch(/token=/);

  const profile = await request(app)
    .get('/users/profile')
    .set('Cookie', cookie);
  expect(profile.status).toBe(200);
  expect(profile.body.password).toBeUndefined();

  const logout = await request(app)
    .get('/users/logout')
    .set('Cookie', cookie);
  expect(logout.status).toBe(200);

  const profileAfterLogout = await request(app)
    .get('/users/profile')
    .set('Cookie', cookie);
  expect(profileAfterLogout.status).toBe(401);
});
