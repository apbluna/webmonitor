FROM node:20-alpine

RUN apk add --no-cache chromium

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json ./
RUN npm install && npm cache clean --force

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY views/ ./views/
RUN npx tsc && rm -rf src/ tsconfig.json && npm prune --omit=dev && npm cache clean --force

RUN addgroup -S appuser && adduser -S -G appuser appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
