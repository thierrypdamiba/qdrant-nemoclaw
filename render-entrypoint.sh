#!/bin/bash
set -e

# --- 1. Start Qdrant Edge Bridge ---
echo "starting qdrant-edge-bridge on port ${QDRANT_BRIDGE_PORT:-6333}..."
python3 /opt/qdrant-edge-bridge/server.py &

for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}/docs 2>/dev/null; then
        echo "qdrant-edge-bridge ready"
        break
    fi
    sleep 0.5
done

# --- 2. Use env token or disable auth for demo ---
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"

# --- 3. Install plugin ---
su -c "HOME=/sandbox openclaw plugins install /opt/qdrant-memory" sandbox 2>&1 || true

# --- 4. Write config ---
mkdir -p /sandbox/.openclaw
cat > /sandbox/.openclaw/openclaw.json <<CONF
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
    "trustedProxies": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "auth": {
      "mode": "token",
      "token": "${GATEWAY_TOKEN:-nemoclaw-demo-2026}"
    },
    "controlUi": {
      "allowedOrigins": ["https://nemoclaw-4xdu.onrender.com", "http://localhost:18789", "http://127.0.0.1:18789"],
      "token": "${GATEWAY_TOKEN:-nemoclaw-demo-2026}"
    }
  },
  "plugins": {
    "allow": ["qdrant-memory"],
    "entries": {
      "qdrant-memory": {
        "enabled": true,
        "config": {
          "qdrantUrl": "http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}",
          "collectionName": "${QDRANT_COLLECTION:-family_memory}",
          "embeddingModel": "nvidia/nv-embedqa-e5-v5",
          "embeddingDimensions": 1024
        }
      }
    }
  }
}
CONF

# Write agent instructions
mkdir -p /sandbox/.openclaw/agents
cat > /sandbox/.openclaw/agents/default.md <<'INSTRUCTIONS'
You are a family AI assistant with shared vector memory.

IMPORTANT: At the start of each conversation, ask the user who they are (dad, daughter, or babysitter).
Set your identity accordingly and use the memory tools with that identity.

You have these memory tools:
- vector_store: save information (set visibility: private, family, or share with specific people)
- vector_search: find information (you only see what your role has access to)
- vector_grant: give someone access to your memories (only if you own them)
- vector_revoke: remove someone's access
- vector_alerts: check for access requests and notifications
- vector_forget: delete your own memories
- vector_stats: check memory statistics

Demo scenario: Dad stores wifi password as "family" visible. Daughter can find it.
Babysitter gets denied and dad gets alerted. Dad grants access and babysitter is notified.
INSTRUCTIONS

chown -R sandbox:sandbox /sandbox

echo "config written, starting gateway on port ${PORT:-18789}..."

# --- 5. Start OpenClaw gateway ---
exec su -c "HOME=/sandbox OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN:-nemoclaw-demo-2026} AGENT_USER=family QDRANT_URL=http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333} QDRANT_COLLECTION=${QDRANT_COLLECTION:-family_memory} NVIDIA_API_KEY=${NVIDIA_API_KEY} openclaw gateway --port ${PORT:-18789}" sandbox
