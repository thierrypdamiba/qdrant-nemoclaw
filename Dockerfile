FROM node:22-slim AS nemoclaw-builder

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/NVIDIA/NemoClaw.git . \
    && cd nemoclaw \
    && npm install \
    && npm run build

# Build the qdrant-memory plugin
FROM node:22-slim AS plugin-builder

WORKDIR /plugin
COPY qdrant-memory/package.json qdrant-memory/pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile || pnpm install
COPY qdrant-memory/ ./
RUN pnpm run build

# --- Runtime stage ---
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl git iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@2026.3.11

# Copy built NemoClaw plugin
COPY --from=nemoclaw-builder /build/nemoclaw/dist /opt/nemoclaw/dist
COPY --from=nemoclaw-builder /build/nemoclaw/package.json /opt/nemoclaw/package.json
COPY --from=nemoclaw-builder /build/nemoclaw-blueprint /opt/nemoclaw-blueprint

# Copy built qdrant-memory plugin
COPY --from=plugin-builder /plugin/dist /opt/qdrant-memory/dist
COPY --from=plugin-builder /plugin/package.json /opt/qdrant-memory/package.json
COPY --from=plugin-builder /plugin/openclaw.plugin.json /opt/qdrant-memory/openclaw.plugin.json
COPY --from=plugin-builder /plugin/node_modules /opt/qdrant-memory/node_modules

# Install qdrant-edge-bridge Python dependencies
COPY qdrant-edge-bridge/ /opt/qdrant-edge-bridge/
RUN python3 -m pip install --break-system-packages --no-cache-dir \
    fastapi uvicorn[standard] httpx \
    && python3 -m pip install --break-system-packages --no-cache-dir \
    qdrant-edge-py || echo "qdrant-edge-py not available, using fallback mode"

# Create sandbox user with writable data dirs
RUN useradd -m -d /sandbox -s /bin/bash sandbox \
    && mkdir -p /sandbox/.openclaw /sandbox/.openclaw-data \
    && mkdir -p /var/lib/qdrant-edge \
    && chown -R sandbox:sandbox /sandbox /var/lib/qdrant-edge

# Install plugins into OpenClaw
RUN openclaw plugins install /opt/nemoclaw || true
RUN openclaw plugins install /opt/qdrant-memory || true

# Copy family hub
COPY family-hub/ /opt/family-hub/

# Copy entrypoint
COPY render-entrypoint.sh /usr/local/bin/render-entrypoint.sh
RUN chmod +x /usr/local/bin/render-entrypoint.sh

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL}
ENV NODE_ENV=production
ENV PORT=18789
ENV QDRANT_URL=http://127.0.0.1:6333
ENV QDRANT_BRIDGE_PORT=6333
ENV QDRANT_STORAGE_DIR=/var/lib/qdrant-edge

EXPOSE 18789

ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
