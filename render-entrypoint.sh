#!/bin/bash
set -e

echo "starting nemoclaw on port ${PORT:-18789}..."

# Configure inference provider from env
if [ -n "$NVIDIA_API_KEY" ]; then
    echo "configuring nvidia inference provider..."
    export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-default}"
    export NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
fi

# Write openclaw config
cat > /sandbox/.openclaw-data/openclaw.json <<CONF
{
  "model": "${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}",
  "provider": {
    "type": "${NEMOCLAW_PROVIDER_TYPE:-nvidia}",
    "endpoint": "${NEMOCLAW_INFERENCE_ENDPOINT:-https://integrate.api.nvidia.com/v1}",
    "apiKey": "${NVIDIA_API_KEY:-}"
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": ${PORT:-18789}
  }
}
CONF

chown sandbox:sandbox /sandbox/.openclaw-data/openclaw.json

# Start OpenClaw gateway bound to all interfaces
exec su -c "openclaw serve --host 0.0.0.0 --port ${PORT:-18789}" sandbox
