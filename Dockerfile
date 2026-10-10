# ─────────────────────────────────────────────
#  Stage 1: dependencies
# ─────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only manifests first for better layer caching
COPY package*.json ./

RUN npm install --production --ignore-scripts \
    && npm cache clean --force

# ─────────────────────────────────────────────
#  Stage 2: final runtime image
# ─────────────────────────────────────────────
FROM node:20-alpine AS runtime

ARG BUILD_SHA=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="RAT C2 Dashboard"
LABEL org.opencontainers.image.revision="${BUILD_SHA}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"

# Security: run as non-root
RUN addgroup -S c2 && adduser -S c2 -G c2

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps --chown=c2:c2 /app/node_modules ./node_modules

# Copy application files
COPY --chown=c2:c2 server.js      ./
COPY --chown=c2:c2 public/        ./public/

USER c2

# Expose the port (configurable via ENV)
EXPOSE 5000

# Environment defaults
ENV PORT=5000
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PING_INTERVAL=25000

# Health check — Docker will mark container unhealthy if this fails
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "server.js"]
