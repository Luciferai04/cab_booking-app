FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . ./
ENV PORT=4010
EXPOSE 4010
CMD ["node", "server.js"]

