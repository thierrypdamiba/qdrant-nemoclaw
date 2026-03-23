import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import { QdrantMemory } from "./qdrant.js";

// OpenClaw plugin SDK types (stubs, resolved at runtime inside the OpenClaw host)
interface PluginApi {
  registerTool: (factory: (ctx: ToolContext) => AgentTool[] | null, opts?: { names?: string[] }) => void;
  registerCommand: (def: { name: string; description: string; handler: (args: string) => { text: string } }) => void;
  pluginConfig?: Record<string, unknown>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

interface ToolContext {
  sessionId?: string;
  agentId?: string;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: TObject<TProperties>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

function makeResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function register(api: PluginApi) {
  const cfg = api.pluginConfig ?? {};
  const qdrantUrl = (cfg.qdrantUrl as string) || process.env.QDRANT_URL || "http://localhost:6333";
  const collection = (cfg.collectionName as string) || process.env.QDRANT_COLLECTION || "agent_memory";
  const embeddingModel = (cfg.embeddingModel as string) || "nvidia/nv-embedqa-e5-v5";
  const dimensions = (cfg.embeddingDimensions as number) || 1024;
  const apiKey = process.env.NVIDIA_API_KEY || "";

  // Agent identity from env (set per-agent in multi-agent mode)
  const agentUser = process.env.AGENT_USER || "default";

  if (!apiKey) {
    api.logger.warn("NVIDIA_API_KEY not set. Qdrant memory plugin will not function.");
  }

  const memory = new QdrantMemory({ qdrantUrl, collection, dimensions, embeddingModel, apiKey });

  api.logger.info(`qdrant-memory: user="${agentUser}", qdrant=${qdrantUrl}, collection="${collection}"`);

  api.registerTool(
    (_ctx: ToolContext) => {
      const caller = agentUser;

      // --- vector_store ---
      const storeTool: AgentTool = {
        name: "vector_store",
        label: "Store Memory",
        description: `Store information in shared family memory. You are "${caller}". Memories can be private (only you), family (all family members), or shared with specific people. Babysitters and guests must be explicitly granted access to private/family memories.`,
        parameters: Type.Object({
          text: Type.String({ description: "The information to remember (e.g., 'WiFi password is SuperSecret123')" }),
          visibility: Type.Optional(Type.Union([
            Type.Literal("private"),
            Type.Literal("family"),
            Type.Literal("public"),
          ], { description: "Who can access: 'private' (only you), 'family' (family members), 'public' (everyone). Default: private", default: "private" })),
          share_with: Type.Optional(Type.Array(Type.String(), { description: "Specific usernames to also grant access (e.g., ['babysitter'])" })),
          category: Type.Optional(Type.String({ description: "Category: 'wifi', 'schedule', 'emergency', 'preference', etc." })),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const visibility = (params.visibility as string) || "private";
            const shareWith = (params.share_with as string[]) || [];
            const accessList = [caller, ...shareWith];

            const id = await memory.store(params.text as string, {
              owner: caller,
              visibility: visibility as "private" | "family" | "custom",
              accessList,
              category: params.category as string,
            });

            const vis = visibility === "family" ? "family members" : visibility === "public" ? "everyone" : `you${shareWith.length ? " + " + shareWith.join(", ") : ""}`;
            return makeResult(`Stored (id: ${id}). Visible to: ${vis}.`, { id, owner: caller, visibility });
          } catch (err) {
            return makeResult(`Failed to store: ${err}`, { error: true });
          }
        },
      };

      // --- vector_search ---
      const searchTool: AgentTool = {
        name: "vector_search",
        label: "Search Memory",
        description: `Search shared family memory. You are "${caller}". You can only see memories you own or have been granted access to. If a relevant memory exists but you don't have access, you'll be told it exists but can't see the content. The memory owner will be alerted about your request.`,
        parameters: Type.Object({
          query: Type.String({ description: "What to search for (e.g., 'wifi password', 'kids bedtime')" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)", default: 5 })),
          category: Type.Optional(Type.String({ description: "Filter by category" })),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const { results, denied } = await memory.search(params.query as string, {
              caller,
              limit: (params.limit as number) || 5,
              category: params.category as string,
            });

            let text = "";

            if (results.length > 0) {
              text += `Found ${results.length} accessible memories:\n\n`;
              text += results
                .map((r, i) => {
                  const owner = (r.metadata.owner as string) || "unknown";
                  return `[${i + 1}] (by ${owner}, score: ${r.score?.toFixed(3)}) ${r.text}`;
                })
                .join("\n\n");
            }

            if (denied.length > 0) {
              // Alert the owners about the denied access attempt
              for (const d of denied) {
                const owner = (d.metadata.owner as string) || "";
                if (owner && owner !== caller) {
                  await memory.createAlert({
                    type: "access_denied",
                    from: caller,
                    to: owner,
                    memoryText: d.text.slice(0, 50) + "...",
                    memoryId: d.id,
                  });
                }
              }

              text += `\n\n${denied.length} relevant memories found but ACCESS DENIED. `;
              text += `Owners: ${[...new Set(denied.map((d) => d.metadata.owner as string))].join(", ")}. `;
              text += `They have been notified of your request.`;
            }

            if (!text) text = "No matching memories found.";

            return makeResult(text, {
              accessible: results.length,
              denied: denied.length,
            });
          } catch (err) {
            return makeResult(`Search failed: ${err}`, { error: true });
          }
        },
      };

      // --- vector_grant ---
      const grantTool: AgentTool = {
        name: "vector_grant",
        label: "Grant Access",
        description: `Grant another person access to your memories. You are "${caller}". Only works on memories you own. The person will be notified they now have access.`,
        parameters: Type.Object({
          memory_description: Type.String({ description: "Description of which memory to grant access to (e.g., 'wifi password')" }),
          grant_to: Type.String({ description: "Username to grant access to (e.g., 'babysitter', 'daughter')" }),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const result = await memory.grantAccess(params.memory_description as string, {
              granter: caller,
              grantee: params.grant_to as string,
            });

            if (result.granted === 0) {
              return makeResult(`No matching memories found that you own, or ${params.grant_to} already has access.`);
            }

            return makeResult(
              `Granted ${params.grant_to} access to ${result.granted} memories. They have been notified.`,
              { granted: result.granted, memoryIds: result.memoryIds },
            );
          } catch (err) {
            return makeResult(`Grant failed: ${err}`, { error: true });
          }
        },
      };

      // --- vector_revoke ---
      const revokeTool: AgentTool = {
        name: "vector_revoke",
        label: "Revoke Access",
        description: `Revoke someone's access to your memories. You are "${caller}". Only works on memories you own.`,
        parameters: Type.Object({
          memory_description: Type.String({ description: "Description of which memory to revoke access to" }),
          revoke_from: Type.String({ description: "Username to revoke access from" }),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const count = await memory.revokeAccess(params.memory_description as string, {
              revoker: caller,
              revokee: params.revoke_from as string,
            });
            if (count === 0) return makeResult("No matching memories found that you own.");
            return makeResult(`Revoked ${params.revoke_from}'s access to ${count} memories.`);
          } catch (err) {
            return makeResult(`Revoke failed: ${err}`, { error: true });
          }
        },
      };

      // --- vector_alerts ---
      const alertsTool: AgentTool = {
        name: "vector_alerts",
        label: "Check Alerts",
        description: `Check your pending alerts/notifications. You are "${caller}". You'll see when someone was denied access to your memories (so you can decide to grant it) and when someone grants you access to theirs.`,
        parameters: Type.Object({
          mark_read: Type.Optional(Type.Boolean({ description: "Mark all alerts as read after viewing (default: false)", default: false })),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const alerts = await memory.getAlerts(caller);

            if (alerts.length === 0) {
              return makeResult("No pending alerts.");
            }

            const text = alerts
              .map((a, i) => {
                if (a.type === "access_denied") {
                  return `[${i + 1}] ACCESS REQUEST: "${a.from}" tried to access "${a.memoryText}" but was denied. Use vector_grant to give them access.`;
                } else {
                  return `[${i + 1}] ACCESS GRANTED: "${a.from}" gave you access to "${a.memoryText}". You can now search for it.`;
                }
              })
              .join("\n\n");

            if (params.mark_read) {
              await memory.markAlertsRead(caller);
            }

            return makeResult(`${alerts.length} alerts:\n\n${text}`, { count: alerts.length, alerts });
          } catch (err) {
            return makeResult(`Alerts check failed: ${err}`, { error: true });
          }
        },
      };

      // --- vector_forget ---
      const forgetTool: AgentTool = {
        name: "vector_forget",
        label: "Forget Memory",
        description: `Delete your own memories. You are "${caller}". Can only delete memories you own.`,
        parameters: Type.Object({
          query: Type.String({ description: "Description of what to forget" }),
          limit: Type.Optional(Type.Number({ description: "Max memories to delete (default: 3)", default: 3 })),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const count = await memory.forget(params.query as string, {
              caller,
              limit: (params.limit as number) || 3,
            });
            if (count === 0) return makeResult("No matching memories found that you own.");
            return makeResult(`Forgot ${count} memories.`, { deleted: count });
          } catch (err) {
            return makeResult(`Forget failed: ${err}`, { error: true });
          }
        },
      };

      // --- vector_stats ---
      const statsTool: AgentTool = {
        name: "vector_stats",
        label: "Memory Stats",
        description: "Get statistics about the shared family memory store.",
        parameters: Type.Object({}),
        execute: async () => {
          try {
            const stats = await memory.getStats();
            return makeResult(
              `Family memory stats:\n- Total memories: ${stats.totalPoints}\n- Pending alerts: ${stats.totalAlerts}\n- Status: ${stats.status}\n- Your identity: ${caller}`,
              stats,
            );
          } catch (err) {
            return makeResult(`Stats failed: ${err}`, { error: true });
          }
        },
      };

      return [storeTool, searchTool, grantTool, revokeTool, alertsTool, forgetTool, statsTool];
    },
    { names: ["vector_store", "vector_search", "vector_grant", "vector_revoke", "vector_alerts", "vector_forget", "vector_stats"] },
  );

  api.registerCommand({
    name: "memory",
    description: "Check family memory status",
    handler: () => {
      return { text: `Family memory active. You are: ${agentUser}. Server: ${qdrantUrl}` };
    },
  });

  api.logger.info(`qdrant-memory: registered 7 tools for user "${agentUser}"`);
}

export default {
  id: "qdrant-memory",
  name: "Qdrant Family Memory",
  description: "Shared family memory with role-based access control, alerts, and grant/revoke. Powered by Qdrant vector search and NVIDIA embeddings.",
  register,
};
