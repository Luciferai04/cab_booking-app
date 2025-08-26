# syntax=docker/dockerfile:1

FROM nginx:1.27-alpine
# Default to production config; override with --build-arg NGINX_CONF=nginx.conf for dev
ARG NGINX_CONF=nginx.prod.conf
COPY ${NGINX_CONF} /etc/nginx/nginx.conf
EXPOSE 80
EXPOSE 443

