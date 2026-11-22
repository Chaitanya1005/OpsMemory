# Production image: Next.js standalone server on Node 24 (node:sqlite is built in).
# Build:  docker build -t opsmemory .
# Run:    docker run -p 3000:3000 -v opsmemory-data:/data --env-file .env.local opsmemory

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    OPSMEMORY_DB=/data/opsmemory.db
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# SQLite lives on a mounted volume at /data. The process runs as root because hosts such as
# Railway mount volumes owned by root; the container holds no other secrets or services.
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
