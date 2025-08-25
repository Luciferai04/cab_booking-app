# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine AS runtime

# Remove default nginx site config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy a minimal SPA config
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Static assets
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

