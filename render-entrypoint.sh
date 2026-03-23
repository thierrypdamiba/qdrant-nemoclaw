#!/bin/bash
set -e

echo "starting qdrant-edge-bridge on port ${QDRANT_BRIDGE_PORT:-6333}..."
python3 /opt/qdrant-edge-bridge/server.py &
QDRANT_PID=$!

# Wait for qdrant bridge to be ready
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}/collections/_ 2>/dev/null || \
       curl -sf http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}/docs 2>/dev/null; then
        echo "qdrant-edge-bridge ready"
        break
    fi
    sleep 0.5
done

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
  },
  "plugins": {
    "qdrant-memory": {
      "qdrantUrl": "http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}",
      "collectionName": "${QDRANT_COLLECTION:-agent_memory}",
      "embeddingModel": "nvidia/nv-embedqa-e5-v5",
      "embeddingDimensions": 1024
    }
  }
}
CONF

chown sandbox:sandbox /sandbox/.openclaw-data/openclaw.json

# Start OpenClaw gateway bound to all interfaces
exec su -c "openclaw gateway --host 0.0.0.0 --port ${PORT:-18789}" sandbox
