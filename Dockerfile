# Aether Gateway — single-stage image. We run TypeScript directly with tsx
# (no build step) and persist virtual keys via the built-in node:sqlite module,
# which is stable and unflagged on Node 24+.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

# Install only runtime deps (tsx is a runtime dependency here, not a dev tool).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source + default config.
COPY tsconfig.json gateway.config.yaml ./
COPY src ./src

# SQLite key store lives here; mount a volume to persist keys across restarts.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
