// Increase default timeout further for mongodb binary downloads on first run
jest.setTimeout(60000);

// Silence noisy logs in tests
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Use an isolated download/temp directory for mongodb-memory-server to avoid lock conflicts
const os = require('os');
const path = require('path');
process.env.MONGOMS_DOWNLOAD_DIR = path.join(os.tmpdir(), 'mongodb-binaries-test');
process.env.MONGOMS_TMP_DIR = path.join(os.tmpdir(), 'mongodb-tmp-test');

