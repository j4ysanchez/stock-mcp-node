FROM node:24-alpine

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install

COPY client/package.json ./client/
RUN cd client && npm install

COPY server/ ./server/
COPY client/ ./client/

RUN mkdir -p /data

ENV CACHE_FILE_PATH=/data/cache.json

CMD ["npx", "--prefix", "client", "tsx", "client/cli.ts"]
