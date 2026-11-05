# Production image: builds the web app, then runs the API and serves the built web files from one process.
# Data lives in /data. The host must attach a persistent volume at /data (Railway: service Settings → Volumes).
# No VOLUME instruction here: Railway rejects it and wants the volume attached on the platform side.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TOT_DB=/data/tot.db \
    TOT_TRUST_PROXY=1

# Install with the lockfile first so this layer is cached until dependencies change.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run build:web \
 && mkdir -p /data

EXPOSE 3000

CMD ["npm", "start", "-w", "@tot/server"]
