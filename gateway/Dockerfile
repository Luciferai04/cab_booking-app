# syntax=docker/dockerfile:1

FROM nginx:1.27-alpine
ARG NGINX_CONF=nginx.conf
COPY ${NGINX_CONF} /etc/nginx/nginx.conf
EXPOSE 80
EXPOSE 443

