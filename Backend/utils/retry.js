// Simple retry with exponential backoff for transient failures
// Usage: await retryWithBackoff(() => axios.get(url), { retries: 3, baseMs: 300 });

async function retryWithBackoff(fn, opts = {}) {
  const {
    retries = 3,
    baseMs = 300,
    maxMs = 3000,
    factor = 2,
    shouldRetry = (err) => {
      // Retry network errors and 5xx
      if (!err || !err.response) return true;
      const status = err.response.status;
      return status >= 500 || status === 429;
    },
  } = opts;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = Math.min(baseMs * Math.pow(factor, attempt), maxMs);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}

module.exports = { retryWithBackoff };

