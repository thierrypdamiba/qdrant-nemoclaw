FROM node:22-slim AS builder

WORKDIR /build

# Clone and build the NemoClaw TypeScript plugin
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/NVIDIA/NemoClaw.git . \
    && cd nemoclaw \
    && npm install \
    && npm run build

# --- Runtime stage ---
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl git iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@2026.3.11

# Copy built NemoClaw plugin
COPY --from=builder /build/nemoclaw/dist /opt/nemoclaw/dist
COPY --from=builder /build/nemoclaw/package.json /opt/nemoclaw/package.json
COPY --from=builder /build/nemoclaw-blueprint /opt/nemoclaw-blueprint

# Create sandbox user with writable data dir
RUN useradd -m -d /sandbox -s /bin/bash sandbox \
    && mkdir -p /sandbox/.openclaw /sandbox/.openclaw-data \
    && chown -R sandbox:sandbox /sandbox

# Install the NemoClaw plugin into OpenClaw
RUN openclaw plugins install /opt/nemoclaw || true

# Copy entrypoint
COPY render-entrypoint.sh /usr/local/bin/render-entrypoint.sh
RUN chmod +x /usr/local/bin/render-entrypoint.sh

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL}
ENV NODE_ENV=production
ENV PORT=18789

EXPOSE 18789

ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
