#!/bin/bash
set -e

echo "starting qdrant-edge-bridge on port ${QDRANT_BRIDGE_PORT:-6333}..."
python3 /opt/qdrant-edge-bridge/server.py &
QDRANT_PID=$!

# Wait for qdrant bridge to be ready
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}/docs 2>/dev/null; then
        echo "qdrant-edge-bridge ready"
        break
    fi
    sleep 0.5
done

echo "starting nemoclaw on port ${PORT:-18789}..."

# Generate a gateway token for auth
GATEWAY_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"

# Install qdrant-memory plugin at runtime (in case Dockerfile install didn't persist)
su -c "HOME=/sandbox openclaw plugins install /opt/qdrant-memory" sandbox 2>&1 || echo "plugin install skipped"

# Write openclaw config using the correct schema
cat > /tmp/openclaw-config.json <<CONF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "nvidia": {
        "baseUrl": "${NEMOCLAW_INFERENCE_ENDPOINT:-https://integrate.api.nvidia.com/v1}",
        "apiKey": "${NVIDIA_API_KEY:-}",
        "api": "openai-completions",
        "models": [
          {
            "id": "nemotron-3-super-120b-a12b",
            "name": "Nemotron 3 Super 120B",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 131072,
            "maxTokens": 4096
          }
        ]
      }
    }
  },
  "gateway": {
    "port": ${PORT:-18789},
    "mode": "local",
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "$GATEWAY_TOKEN"
    }
  },
  "plugins": {
    "entries": {
      "qdrant-memory": {
        "enabled": true,
        "config": {
          "qdrantUrl": "http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}",
          "collectionName": "${QDRANT_COLLECTION:-agent_memory}",
          "embeddingModel": "nvidia/nv-embedqa-e5-v5",
          "embeddingDimensions": 1024
        }
      }
    }
  }
}
CONF

# Write to all config locations OpenClaw checks
mkdir -p /sandbox/.openclaw /sandbox/.config/openclaw
cp /tmp/openclaw-config.json /sandbox/.openclaw/openclaw.json
cp /tmp/openclaw-config.json /sandbox/.config/openclaw/config.json
chown -R sandbox:sandbox /sandbox
rm /tmp/openclaw-config.json

echo "openclaw config written (token: $GATEWAY_TOKEN)"

# Start OpenClaw gateway
exec su -c "HOME=/sandbox OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN openclaw gateway --port ${PORT:-18789}" sandbox
