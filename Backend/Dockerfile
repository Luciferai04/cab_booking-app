# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (better layer caching)
COPY Backend/package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY Backend/ ./
# Ensure non-root can read/execute files copied from host with restrictive perms
RUN chown -R node:node /app && chmod -R a+rX /app

# Expose app port (container-internal)
EXPOSE 3000

# Run as non-root for security
USER node

CMD ["node", "server.js"]

