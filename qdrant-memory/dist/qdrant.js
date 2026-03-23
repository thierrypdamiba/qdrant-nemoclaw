import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "crypto";
import { embedSingle } from "./embeddings.js";
export class QdrantMemory {
    client;
    collection;
    dimensions;
    embeddingModel;
    apiKey;
    initialized = false;
    constructor(opts) {
        this.client = new QdrantClient({ url: opts.qdrantUrl });
        this.collection = opts.collection;
        this.dimensions = opts.dimensions;
        this.embeddingModel = opts.embeddingModel;
        this.apiKey = opts.apiKey;
    }
    async ensureCollection() {
        if (this.initialized)
            return;
        try {
            await this.client.getCollection(this.collection);
        }
        catch {
            await this.client.createCollection(this.collection, {
                vectors: {
                    size: this.dimensions,
                    distance: "Cosine",
                },
            });
            await this.client.createPayloadIndex(this.collection, {
                field_name: "session_id",
                field_schema: "keyword",
                wait: true,
            });
            await this.client.createPayloadIndex(this.collection, {
                field_name: "category",
                field_schema: "keyword",
                wait: true,
            });
            await this.client.createPayloadIndex(this.collection, {
                field_name: "created_at",
                field_schema: "integer",
                wait: true,
            });
        }
        this.initialized = true;
    }
    async store(text, metadata = {}, sessionId) {
        await this.ensureCollection();
        const vector = await embedSingle(text, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "passage",
        });
        const id = randomUUID();
        const payload = {
            text,
            session_id: sessionId || "global",
            category: metadata.category || "general",
            created_at: Date.now(),
            ...metadata,
        };
        await this.client.upsert(this.collection, {
            wait: true,
            points: [{ id, vector, payload }],
        });
        return id;
    }
    async search(query, opts = {}) {
        await this.ensureCollection();
        const vector = await embedSingle(query, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "query",
        });
        const filter = {};
        const must = [];
        if (opts.sessionId) {
            must.push({ key: "session_id", match: { value: opts.sessionId } });
        }
        if (opts.category) {
            must.push({ key: "category", match: { value: opts.category } });
        }
        if (must.length > 0) {
            filter.must = must;
        }
        const results = await this.client.search(this.collection, {
            vector,
            limit: opts.limit || 5,
            with_payload: true,
            score_threshold: opts.scoreThreshold || 0.5,
            ...(must.length > 0 ? { filter } : {}),
        });
        return results.map((r) => ({
            id: String(r.id),
            text: r.payload?.text || "",
            metadata: r.payload || {},
            score: r.score,
        }));
    }
    async forget(query, opts = {}) {
        await this.ensureCollection();
        const results = await this.search(query, {
            limit: opts.limit || 3,
            scoreThreshold: opts.scoreThreshold || 0.8,
        });
        if (results.length === 0)
            return 0;
        const ids = results.map((r) => r.id);
        await this.client.delete(this.collection, {
            wait: true,
            points: ids,
        });
        return ids.length;
    }
    async getStats() {
        await this.ensureCollection();
        const info = await this.client.getCollection(this.collection);
        return {
            totalPoints: info.points_count || 0,
            status: String(info.status),
        };
    }
}
