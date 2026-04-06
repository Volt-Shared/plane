# ──────────────────────────────────────────────────────────────────────────────
# Build stage
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && \
    cp -R node_modules prod_node_modules && \
    npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Production stage
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

ENV NODE_ENV=production

# Security: non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prod_node_modules ./node_modules
COPY package.json ./

# wget for healthcheck
RUN apk add --no-cache wget

USER appuser

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
