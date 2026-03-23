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

# --- 3. Setup each agent with isolated HOME ---
setup_agent() {
    local user=$1
    local port=$2
    local token=$3
    local agent_home="/sandbox/agent-${user}"

    mkdir -p "${agent_home}/.openclaw"

    # Copy installed plugin to this agent's home
    if [ -d /sandbox/.openclaw/extensions ]; then
        cp -r /sandbox/.openclaw/extensions "${agent_home}/.openclaw/"
    fi

    cat > "${agent_home}/.openclaw/openclaw.json" <<AGENTCONF
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
    "port": ${port},
    "mode": "local",
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "${token}"
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
AGENTCONF

    # Write agent instructions file
    mkdir -p "${agent_home}/.openclaw/agents"
    cat > "${agent_home}/.openclaw/agents/default.md" <<INSTRUCTIONS
You are a helpful family AI assistant. Your identity is "${user}".

You have access to shared family memory tools:
- vector_store: save information to shared memory
- vector_search: find information in shared memory
- vector_grant: give someone access to your memories
- vector_revoke: remove someone's access
- vector_alerts: check for access requests and notifications
- vector_forget: delete your own memories
- vector_stats: check memory statistics

When storing memories, consider who should have access (private, family, or specific people).
When searching, you can only see what you are allowed to.
Check your alerts regularly for access requests or grants.
Always tell the user your identity when relevant.
INSTRUCTIONS

    chown -R sandbox:sandbox "${agent_home}"
    echo "setup agent: ${user} (home=${agent_home}, port=${port})"
}

# Install plugin once into default home
su -c "HOME=/sandbox openclaw plugins install /opt/qdrant-memory" sandbox 2>&1 || true

setup_agent "dad" $DAD_PORT "$DAD_TOKEN"
setup_agent "daughter" $DAUGHTER_PORT "$DAUGHTER_TOKEN"
setup_agent "babysitter" $BABYSITTER_PORT "$BABYSITTER_TOKEN"

# --- 4. Start each agent with its own HOME ---
start_agent() {
    local user=$1
    local port=$2
    local token=$3
    local agent_home="/sandbox/agent-${user}"

    echo "starting agent: ${user} on port ${port}..."
    su -c "HOME=${agent_home} AGENT_USER=${user} OPENCLAW_GATEWAY_TOKEN=${token} QDRANT_URL=http://127.0.0.1:${QDRANT_BRIDGE_PORT:-6333} QDRANT_COLLECTION=${QDRANT_COLLECTION:-family_memory} NVIDIA_API_KEY=${NVIDIA_API_KEY} CI=true OPENCLAW_NONINTERACTIVE=1 openclaw gateway --port ${port} 2>&1 | sed 's/^/[${user}] /' &" sandbox &
    echo "agent ${user} started"
}

start_agent "dad" $DAD_PORT "$DAD_TOKEN"
sleep 2
start_agent "daughter" $DAUGHTER_PORT "$DAUGHTER_TOKEN"
sleep 2
start_agent "babysitter" $BABYSITTER_PORT "$BABYSITTER_TOKEN"

# Wait for agents to come up
echo "waiting for agents to initialize..."
sleep 8

# --- 5. Start the family hub (reverse proxy + landing page) ---
echo "starting family hub on port ${PORT:-18789}..."
export DAD_PORT DAUGHTER_PORT BABYSITTER_PORT
exec node /opt/family-hub/server.js
