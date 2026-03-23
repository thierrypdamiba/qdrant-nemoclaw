FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv curl git iproute2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install OpenClaw globally
RUN npm install -g openclaw@2026.3.11

# Install NemoClaw from GitHub
RUN git clone --depth 1 https://github.com/NVIDIA/NemoClaw.git /tmp/nemoclaw \
    && cd /tmp/nemoclaw \
    && npm install \
    && npm run build \
    && npm install -g . \
    && rm -rf /tmp/nemoclaw

# Copy deployment config
COPY render-entrypoint.sh /usr/local/bin/render-entrypoint.sh
RUN chmod +x /usr/local/bin/render-entrypoint.sh

# Create sandbox user
RUN useradd -m -d /sandbox -s /bin/bash sandbox
RUN mkdir -p /sandbox/.openclaw-data /sandbox/.nemoclaw \
    && chown -R sandbox:sandbox /sandbox

ENV NODE_ENV=production
ENV NEMOCLAW_HOST=0.0.0.0
ENV PORT=18789

EXPOSE 18789

ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
