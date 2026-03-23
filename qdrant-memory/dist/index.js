import { Type } from "@sinclair/typebox";
import { QdrantMemory } from "./qdrant.js";
function ok(text, details = {}) {
    return { content: [{ type: "text", text }], details };
}
// Tenant ID is the household. All family members share one tenant.
// User identity (dad/daughter/babysitter) determines ACL within the tenant.
const TENANT_ID = process.env.TENANT_ID || "household_1";
function register(api) {
    const cfg = api.pluginConfig ?? {};
    const qdrantUrl = cfg.qdrantUrl || process.env.QDRANT_URL || "http://localhost:6333";
    const collection = cfg.collectionName || process.env.QDRANT_COLLECTION || "family_memory";
    const embeddingModel = cfg.embeddingModel || "nvidia/nv-embedqa-e5-v5";
    const dimensions = cfg.embeddingDimensions || 1024;
    const apiKey = process.env.NVIDIA_API_KEY || "";
    const agentUser = process.env.AGENT_USER || "family";
    if (!apiKey) {
        api.logger.warn("NVIDIA_API_KEY not set. Qdrant memory plugin disabled.");
    }
    const memory = new QdrantMemory({ qdrantUrl, collection, dimensions, embeddingModel, apiKey });
    api.logger.info(`qdrant-memory: tenant="${TENANT_ID}", user="${agentUser}", qdrant=${qdrantUrl}`);
    api.registerTool((_ctx) => {
        const caller = agentUser;
        const tenantId = TENANT_ID;
        // --- vector_store ---
        const storeTool = {
            name: "vector_store",
            label: "Store Memory",
            description: `Store information in the household's shared memory. You are "${caller}". Memories are partitioned by household (tenant) in Qdrant. Within the household, access is controlled by visibility: "private" (only you), "family" (dad/mom/daughter/son), or shared with specific people.`,
            parameters: Type.Object({
                text: Type.String({ description: "The information to remember" }),
                visibility: Type.Optional(Type.Union([
                    Type.Literal("private"),
                    Type.Literal("family"),
                    Type.Literal("public"),
                ], { description: "Who can access: private (you only), family (family members), public (everyone including guests). Default: private" })),
                share_with: Type.Optional(Type.Array(Type.String(), { description: "Specific people to also grant access (e.g., ['babysitter'])" })),
                category: Type.Optional(Type.String({ description: "Category: wifi, schedule, emergency, preference, etc." })),
            }),
            execute: async (_tid, params) => {
                try {
                    const visibility = params.visibility || "private";
                    const shareWith = params.share_with || [];
                    const accessList = [caller, ...shareWith];
                    const id = await memory.store(params.text, {
                        tenantId,
                        owner: caller,
                        visibility: visibility,
                        accessList,
                        category: params.category,
                    });
                    const vis = visibility === "family" ? "family members" : visibility === "public" ? "everyone" : `you${shareWith.length ? " + " + shareWith.join(", ") : ""}`;
                    return ok(`Stored in household memory (id: ${id}). Visible to: ${vis}. Tenant: ${tenantId}`, { id, owner: caller, tenantId, visibility });
                }
                catch (err) {
                    return ok(`Failed to store: ${err}`, { error: true });
                }
            },
        };
        // --- vector_search ---
        const searchTool = {
            name: "vector_search",
            label: "Search Memory",
            description: `Search the household's shared memory. You are "${caller}". Qdrant filters by tenant_id first (per-tenant HNSW sub-graph), then checks your access level. If a memory exists but you lack access, the owner is alerted.`,
            parameters: Type.Object({
                query: Type.String({ description: "What to search for" }),
                limit: Type.Optional(Type.Number({ description: "Max results (default: 5)", default: 5 })),
                category: Type.Optional(Type.String({ description: "Filter by category" })),
            }),
            execute: async (_tid, params) => {
                try {
                    const { results, denied } = await memory.search(params.query, {
                        tenantId,
                        caller,
                        limit: params.limit || 5,
                        category: params.category,
                    });
                    let text = "";
                    if (results.length > 0) {
                        text += `Found ${results.length} accessible memories:\n\n`;
                        text += results
                            .map((r, i) => {
                            const owner = r.metadata.owner || "unknown";
                            return `[${i + 1}] (by ${owner}, score: ${r.score?.toFixed(3)}) ${r.text}`;
                        })
                            .join("\n\n");
                    }
                    if (denied.length > 0) {
                        for (const d of denied) {
                            const owner = d.metadata.owner || "";
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
                        text += `Owners: ${[...new Set(denied.map((d) => d.metadata.owner))].join(", ")}. `;
                        text += `They have been notified of your request.`;
                    }
                    if (!text)
                        text = "No matching memories found in this household.";
                    return ok(text, { accessible: results.length, denied: denied.length, tenantId });
                }
                catch (err) {
                    return ok(`Search failed: ${err}`, { error: true });
                }
            },
        };
        // --- vector_grant ---
        const grantTool = {
            name: "vector_grant",
            label: "Grant Access",
            description: `Grant someone access to your memories within this household. You are "${caller}". Only works on memories you own. The person is notified.`,
            parameters: Type.Object({
                memory_description: Type.String({ description: "Description of which memory to grant access to" }),
                grant_to: Type.String({ description: "Person to grant access to (e.g., babysitter, daughter)" }),
            }),
            execute: async (_tid, params) => {
                try {
                    const result = await memory.grantAccess(params.memory_description, {
                        tenantId,
                        granter: caller,
                        grantee: params.grant_to,
                    });
                    if (result.granted === 0) {
                        return ok(`No matching memories found that you own, or ${params.grant_to} already has access.`);
                    }
                    return ok(`Granted ${params.grant_to} access to ${result.granted} memories. They have been notified.`, { granted: result.granted });
                }
                catch (err) {
                    return ok(`Grant failed: ${err}`, { error: true });
                }
            },
        };
        // --- vector_revoke ---
        const revokeTool = {
            name: "vector_revoke",
            label: "Revoke Access",
            description: `Revoke someone's access to your memories. You are "${caller}".`,
            parameters: Type.Object({
                memory_description: Type.String({ description: "Description of which memory to revoke access to" }),
                revoke_from: Type.String({ description: "Person to revoke access from" }),
            }),
            execute: async (_tid, params) => {
                try {
                    const count = await memory.revokeAccess(params.memory_description, {
                        tenantId,
                        revoker: caller,
                        revokee: params.revoke_from,
                    });
                    if (count === 0)
                        return ok("No matching memories found that you own.");
                    return ok(`Revoked ${params.revoke_from}'s access to ${count} memories.`);
                }
                catch (err) {
                    return ok(`Revoke failed: ${err}`, { error: true });
                }
            },
        };
        // --- vector_alerts ---
        const alertsTool = {
            name: "vector_alerts",
            label: "Check Alerts",
            description: `Check your pending alerts. You are "${caller}". See when someone was denied access (so you can grant it) or when you received new access.`,
            parameters: Type.Object({
                mark_read: Type.Optional(Type.Boolean({ description: "Mark all alerts as read after viewing", default: false })),
            }),
            execute: async (_tid, params) => {
                try {
                    const alerts = await memory.getAlerts(caller);
                    if (alerts.length === 0)
                        return ok("No pending alerts.");
                    const text = alerts
                        .map((a, i) => {
                        if (a.type === "access_denied") {
                            return `[${i + 1}] ACCESS REQUEST: "${a.from}" tried to access "${a.memoryText}" but was denied. Use vector_grant to give them access.`;
                        }
                        return `[${i + 1}] ACCESS GRANTED: "${a.from}" gave you access to "${a.memoryText}".`;
                    })
                        .join("\n\n");
                    if (params.mark_read)
                        await memory.markAlertsRead(caller);
                    return ok(`${alerts.length} alerts:\n\n${text}`, { count: alerts.length });
                }
                catch (err) {
                    return ok(`Alerts check failed: ${err}`, { error: true });
                }
            },
        };
        // --- vector_forget ---
        const forgetTool = {
            name: "vector_forget",
            label: "Forget Memory",
            description: `Delete your own memories. You are "${caller}". Can only delete memories you own within this household.`,
            parameters: Type.Object({
                query: Type.String({ description: "Description of what to forget" }),
                limit: Type.Optional(Type.Number({ description: "Max memories to delete (default: 3)", default: 3 })),
            }),
            execute: async (_tid, params) => {
                try {
                    const count = await memory.forget(params.query, {
                        tenantId,
                        caller,
                        limit: params.limit || 3,
                    });
                    if (count === 0)
                        return ok("No matching memories found that you own.");
                    return ok(`Forgot ${count} memories.`, { deleted: count });
                }
                catch (err) {
                    return ok(`Forget failed: ${err}`, { error: true });
                }
            },
        };
        // --- vector_stats ---
        const statsTool = {
            name: "vector_stats",
            label: "Memory Stats",
            description: "Get statistics about the household's shared memory.",
            parameters: Type.Object({}),
            execute: async () => {
                try {
                    const stats = await memory.getStats(tenantId);
                    return ok(`Household memory stats:\n- Tenant: ${tenantId}\n- Total memories: ${stats.totalPoints}\n- Pending alerts: ${stats.totalAlerts}\n- Status: ${stats.status}\n- Your identity: ${caller}\n- Qdrant multitenancy: is_tenant=true on tenant_id, per-tenant HNSW (m=0, payload_m=16)`, stats);
                }
                catch (err) {
                    return ok(`Stats failed: ${err}`, { error: true });
                }
            },
        };
        return [storeTool, searchTool, grantTool, revokeTool, alertsTool, forgetTool, statsTool];
    }, { names: ["vector_store", "vector_search", "vector_grant", "vector_revoke", "vector_alerts", "vector_forget", "vector_stats"] });
    api.registerCommand({
        name: "memory",
        description: "Check household memory status",
        handler: () => ({ text: `Household memory active. Tenant: ${TENANT_ID}, User: ${agentUser}` }),
    });
    api.logger.info(`qdrant-memory: registered 7 tools, tenant="${TENANT_ID}", user="${agentUser}"`);
}
export default {
    id: "qdrant-memory",
    name: "Qdrant Household Memory",
    description: "Shared household memory with Qdrant multitenancy (is_tenant), RBAC, alerts, and NVIDIA embeddings.",
    register,
};
