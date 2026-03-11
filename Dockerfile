FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY server.js ./
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]
