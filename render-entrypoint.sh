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

# Write openclaw config to all possible locations OpenClaw checks
CONFIG_JSON='{
  "model": "'"${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"'",
  "provider": {
    "type": "'"${NEMOCLAW_PROVIDER_TYPE:-nvidia}"'",
    "endpoint": "'"${NEMOCLAW_INFERENCE_ENDPOINT:-https://integrate.api.nvidia.com/v1}"'",
    "apiKey": "'"${NVIDIA_API_KEY:-}"'"
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": '"${PORT:-18789}"',
    "mode": "local"
  },
  "plugins": {
    "qdrant-memory": {
      "qdrantUrl": "http://127.0.0.1:'"${QDRANT_BRIDGE_PORT:-6333}"'",
      "collectionName": "'"${QDRANT_COLLECTION:-agent_memory}"'",
      "embeddingModel": "nvidia/nv-embedqa-e5-v5",
      "embeddingDimensions": 1024
    }
  }
}'

# Write to sandbox user config dirs
mkdir -p /sandbox/.openclaw /sandbox/.openclaw-data /sandbox/.config/openclaw
echo "$CONFIG_JSON" > /sandbox/.openclaw/openclaw.json
echo "$CONFIG_JSON" > /sandbox/.openclaw-data/openclaw.json
echo "$CONFIG_JSON" > /sandbox/.config/openclaw/config.json
chown -R sandbox:sandbox /sandbox

# Also write to root-level config in case openclaw checks there
mkdir -p /root/.openclaw /root/.config/openclaw
echo "$CONFIG_JSON" > /root/.openclaw/openclaw.json
echo "$CONFIG_JSON" > /root/.config/openclaw/config.json

echo "openclaw config written"

# Start OpenClaw gateway
exec su -c "HOME=/sandbox openclaw gateway --port ${PORT:-18789} --allow-unconfigured" sandbox
