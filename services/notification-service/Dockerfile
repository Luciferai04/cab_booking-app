# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app

# Install dependencies first
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

# Copy source
COPY . .
EXPOSE 4008
CMD ["node","index.js"]

