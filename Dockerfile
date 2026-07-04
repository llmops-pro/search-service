# search-service — minimal Node image for Fly.io.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json ./
# Use npm here for a lockfile-free scaffold; switch to pnpm + lockfile for prod.
RUN npm install --omit=dev && npm install tsx

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 8080
ENV PORT=8080
CMD ["node", "--import", "tsx", "src/server.ts"]
