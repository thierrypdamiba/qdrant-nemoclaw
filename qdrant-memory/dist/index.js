import { Type } from "@sinclair/typebox";
import { QdrantMemory } from "./qdrant.js";
function makeResult(text, details = {}) {
    return { content: [{ type: "text", text }], details };
}
// Plugin entry
function register(api) {
    const cfg = api.pluginConfig ?? {};
    const qdrantUrl = cfg.qdrantUrl || process.env.QDRANT_URL || "http://localhost:6333";
    const collection = cfg.collectionName || process.env.QDRANT_COLLECTION || "agent_memory";
    const embeddingModel = cfg.embeddingModel || "nvidia/nv-embedqa-e5-v5";
    const dimensions = cfg.embeddingDimensions || 1024;
    const apiKey = process.env.NVIDIA_API_KEY || "";
    if (!apiKey) {
        api.logger.warn("NVIDIA_API_KEY not set. Qdrant memory plugin will not function.");
    }
    const memory = new QdrantMemory({ qdrantUrl, collection, dimensions, embeddingModel, apiKey });
    api.logger.info(`qdrant-memory: connecting to ${qdrantUrl}, collection="${collection}", model="${embeddingModel}"`);
    api.registerTool((ctx) => {
        const sessionId = ctx.sessionId || "global";
        // --- vector_store ---
        const storeParams = Type.Object({
            text: Type.String({ description: "The text content to remember. Can be a fact, conversation summary, user preference, or any knowledge worth persisting." }),
            category: Type.Optional(Type.String({ description: "Category tag for organizing memories. Examples: 'preference', 'fact', 'conversation', 'task', 'code'" })),
            metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Additional key-value metadata to store with the memory" })),
        });
        const storeTool = {
            name: "vector_store",
            label: "Store Memory",
            description: "Store a piece of information in persistent vector memory. The text is embedded and saved to Qdrant so it can be retrieved later by semantic similarity. Use this to remember important facts, user preferences, conversation context, decisions, or anything the agent should recall in future interactions.",
            parameters: storeParams,
            execute: async (_toolCallId, params) => {
                try {
                    const meta = params.metadata || {};
                    if (params.category)
                        meta.category = params.category;
                    const id = await memory.store(params.text, meta, sessionId);
                    return makeResult(`Stored in memory (id: ${id})`, { id, sessionId });
                }
                catch (err) {
                    return makeResult(`Failed to store memory: ${err}`, { error: true });
                }
            },
        };
        // --- vector_search ---
        const searchParams = Type.Object({
            query: Type.String({ description: "Natural language search query. Finds memories semantically similar to this text." }),
            limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5)", default: 5 })),
            category: Type.Optional(Type.String({ description: "Filter results to a specific category" })),
        });
        const searchTool = {
            name: "vector_search",
            label: "Search Memory",
            description: "Search persistent vector memory for information semantically similar to the query. Returns previously stored memories ranked by relevance. Use this to recall facts, user preferences, past conversation context, or any previously stored knowledge. Always search memory before asking the user to repeat information.",
            parameters: searchParams,
            execute: async (_toolCallId, params) => {
                try {
                    const results = await memory.search(params.query, {
                        limit: params.limit || 5,
                        category: params.category,
                        sessionId,
                    });
                    if (results.length === 0) {
                        // Also try global memories
                        const globalResults = await memory.search(params.query, {
                            limit: params.limit || 5,
                            category: params.category,
                        });
                        if (globalResults.length === 0) {
                            return makeResult("No matching memories found.", { count: 0 });
                        }
                        const text = globalResults
                            .map((r, i) => `[${i + 1}] (score: ${r.score?.toFixed(3)}) ${r.text}`)
                            .join("\n\n");
                        return makeResult(`Found ${globalResults.length} memories (global):\n\n${text}`, {
                            count: globalResults.length,
                            results: globalResults,
                        });
                    }
                    const text = results
                        .map((r, i) => `[${i + 1}] (score: ${r.score?.toFixed(3)}) ${r.text}`)
                        .join("\n\n");
                    return makeResult(`Found ${results.length} memories:\n\n${text}`, {
                        count: results.length,
                        results,
                    });
                }
                catch (err) {
                    return makeResult(`Memory search failed: ${err}`, { error: true });
                }
            },
        };
        // --- vector_forget ---
        const forgetParams = Type.Object({
            query: Type.String({ description: "Description of the memory to forget. Memories most similar to this text will be deleted." }),
            limit: Type.Optional(Type.Number({ description: "Maximum number of memories to delete (default: 3)", default: 3 })),
        });
        const forgetTool = {
            name: "vector_forget",
            label: "Forget Memory",
            description: "Delete memories from vector storage that closely match the query. Use this when the user asks to forget something, when information is outdated, or when correcting previously stored facts.",
            parameters: forgetParams,
            execute: async (_toolCallId, params) => {
                try {
                    const count = await memory.forget(params.query, {
                        limit: params.limit || 3,
                    });
                    if (count === 0) {
                        return makeResult("No matching memories found to forget.", { deleted: 0 });
                    }
                    return makeResult(`Forgot ${count} matching memories.`, { deleted: count });
                }
                catch (err) {
                    return makeResult(`Failed to forget: ${err}`, { error: true });
                }
            },
        };
        // --- vector_stats ---
        const statsParams = Type.Object({});
        const statsTool = {
            name: "vector_stats",
            label: "Memory Stats",
            description: "Get statistics about the vector memory store: total memories stored, collection status.",
            parameters: statsParams,
            execute: async () => {
                try {
                    const stats = await memory.getStats();
                    return makeResult(`Vector memory stats:\n- Total memories: ${stats.totalPoints}\n- Collection status: ${stats.status}\n- Collection: ${collection}\n- Qdrant: ${qdrantUrl}`, stats);
                }
                catch (err) {
                    return makeResult(`Failed to get stats: ${err}`, { error: true });
                }
            },
        };
        return [storeTool, searchTool, forgetTool, statsTool];
    }, { names: ["vector_store", "vector_search", "vector_forget", "vector_stats"] });
    api.registerCommand({
        name: "memory",
        description: "Check Qdrant vector memory status",
        handler: () => {
            return { text: `Qdrant vector memory active. Server: ${qdrantUrl}, Collection: ${collection}` };
        },
    });
    api.logger.info("qdrant-memory plugin registered: vector_store, vector_search, vector_forget, vector_stats");
}
// Export for OpenClaw plugin loader
export default {
    id: "qdrant-memory",
    name: "Qdrant Vector Memory",
    description: "Persistent semantic memory for NemoClaw agents, powered by Qdrant vector search and NVIDIA embeddings",
    register,
};
