#!/bin/bash
set -e

# --- 1. Start Qdrant Edge Bridge (shared by all agents) ---
echo "starting qdrant-edge-bridge on port ${QDRANT_BRIDGE_PORT:-6333}..."
python3 /opt/qdrant-edge-bridge/server.py &

for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}/docs 2>/dev/null; then
        echo "qdrant-edge-bridge ready"
        break
    fi
    sleep 0.5
done

# --- 2. Generate auth tokens ---
DAD_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
DAUGHTER_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
BABYSITTER_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)

export DAD_TOKEN DAUGHTER_TOKEN BABYSITTER_TOKEN

DAD_PORT=18801
DAUGHTER_PORT=18802
BABYSITTER_PORT=18803

# --- 3. Write config for each agent ---
write_agent_config() {
    local user=$1
    local port=$2
    local token=$3
    local config_dir="/sandbox/.openclaw-${user}"

    mkdir -p "${config_dir}"

    cat > "${config_dir}/openclaw.json" <<AGENTCONF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
      },
      "systemPrompt": "You are a helpful family AI assistant. Your identity is '${user}'. You have access to shared family memory tools. When storing memories, consider who should have access. When searching, you can only see what you're allowed to. Always check your alerts for access requests or grants."
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
    "port": ${port},
    "mode": "local",
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "${token}"
    }
  }
}
AGENTCONF

    chown -R sandbox:sandbox "${config_dir}"
    echo "wrote config for ${user} on port ${port}"
}

write_agent_config "dad" $DAD_PORT "$DAD_TOKEN"
write_agent_config "daughter" $DAUGHTER_PORT "$DAUGHTER_TOKEN"
write_agent_config "babysitter" $BABYSITTER_PORT "$BABYSITTER_TOKEN"

# --- 4. Install qdrant-memory plugin for sandbox user ---
su -c "HOME=/sandbox openclaw plugins install /opt/qdrant-memory" sandbox 2>&1 || echo "plugin install note: may already exist"

# --- 5. Start each agent ---
start_agent() {
    local user=$1
    local port=$2
    local token=$3
    local config_dir="/sandbox/.openclaw-${user}"

    echo "starting agent: ${user} on port ${port}..."
    HOME=/sandbox \
    OPENCLAW_CONFIG_DIR="${config_dir}" \
    OPENCLAW_GATEWAY_TOKEN="${token}" \
    AGENT_USER="${user}" \
    QDRANT_URL="http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333}" \
    QDRANT_COLLECTION="${QDRANT_COLLECTION:-family_memory}" \
    NVIDIA_API_KEY="${NVIDIA_API_KEY}" \
    su -c "HOME=/sandbox OPENCLAW_CONFIG_DIR=${config_dir} OPENCLAW_GATEWAY_TOKEN=${token} AGENT_USER=${user} QDRANT_URL=http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333} QDRANT_COLLECTION=${QDRANT_COLLECTION:-family_memory} NVIDIA_API_KEY=${NVIDIA_API_KEY} openclaw gateway --port ${port}" sandbox &
    echo "agent ${user} started (pid $!)"
}

start_agent "dad" $DAD_PORT "$DAD_TOKEN"
start_agent "daughter" $DAUGHTER_PORT "$DAUGHTER_TOKEN"
start_agent "babysitter" $BABYSITTER_PORT "$BABYSITTER_TOKEN"

# Wait for agents to come up
sleep 5

# --- 6. Start the family hub (reverse proxy + landing page) ---
echo "starting family hub on port ${PORT:-18789}..."
export DAD_PORT DAUGHTER_PORT BABYSITTER_PORT
exec node /opt/family-hub/server.js
