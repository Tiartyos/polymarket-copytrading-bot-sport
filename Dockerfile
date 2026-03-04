# ── Stage 1: build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ── Stage 2: compile TypeScript backend ───────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npx tsc

# ── Stage 3: production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Install only production deps (native modules re-compiled for target arch here)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Compiled backend
COPY --from=backend-builder /app/dist ./dist

# Built frontend (served by the embedded HTTP server)
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Default config — users should bind-mount their own trade.toml
COPY trade.toml ./

# Persistent data directory (override with a named volume or bind mount)
RUN mkdir -p data

EXPOSE 8000

CMD ["node", "dist/index.js"]
