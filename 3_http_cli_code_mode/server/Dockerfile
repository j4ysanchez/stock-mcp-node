FROM node:24-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN mkdir -p /data

ENV CACHE_FILE_PATH=/data/cache.json
ENV HOST=0.0.0.0
ENV PORT=8001

EXPOSE 8001
CMD ["npx", "tsx", "server.ts"]
