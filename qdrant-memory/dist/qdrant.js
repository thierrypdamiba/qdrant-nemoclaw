import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "crypto";
import { embedSingle } from "./embeddings.js";
export class QdrantMemory {
    client;
    collection;
    alertCollection;
    dimensions;
    embeddingModel;
    apiKey;
    initialized = false;
    constructor(opts) {
        this.client = new QdrantClient({ url: opts.qdrantUrl });
        this.collection = opts.collection;
        this.alertCollection = opts.collection + "_alerts";
        this.dimensions = opts.dimensions;
        this.embeddingModel = opts.embeddingModel;
        this.apiKey = opts.apiKey;
    }
    async ensureCollections() {
        if (this.initialized)
            return;
        // Main memory collection with tenant-optimized HNSW
        try {
            await this.client.getCollection(this.collection);
        }
        catch {
            await this.client.createCollection(this.collection, {
                vectors: { size: this.dimensions, distance: "Cosine" },
                // Tenant-optimized: per-tenant HNSW sub-graphs
                // m=0 disables global graph (all queries MUST include tenant filter)
                // payload_m=16 builds efficient per-tenant indexes
                hnsw_config: {
                    payload_m: 16,
                    m: 0,
                },
            });
            // tenant_id is the primary partition key with is_tenant flag
            // This co-locates vectors from the same tenant on disk
            await this.client.createPayloadIndex(this.collection, {
                field_name: "tenant_id",
                field_schema: { type: "keyword", is_tenant: true },
                wait: true,
            });
            // Secondary indexes for filtering within a tenant
            for (const field of ["owner", "visibility", "category"]) {
                await this.client.createPayloadIndex(this.collection, {
                    field_name: field,
                    field_schema: "keyword",
                    wait: true,
                });
            }
            await this.client.createPayloadIndex(this.collection, {
                field_name: "created_at",
                field_schema: "integer",
                wait: true,
            });
        }
        // Alerts collection
        try {
            await this.client.getCollection(this.alertCollection);
        }
        catch {
            await this.client.createCollection(this.alertCollection, {
                vectors: { size: this.dimensions, distance: "Cosine" },
            });
            for (const field of ["to", "from", "type", "read", "timestamp"]) {
                const schema = field === "timestamp" ? "integer" : "keyword";
                await this.client.createPayloadIndex(this.alertCollection, {
                    field_name: field,
                    field_schema: schema,
                    wait: true,
                });
            }
        }
        this.initialized = true;
    }
    /**
     * Store a memory with tenant isolation.
     * tenant_id is the primary partition key for Qdrant multitenancy.
     * owner is the user who created the memory.
     * access_list controls who can read it (within or across tenants).
     */
    async store(text, opts) {
        await this.ensureCollections();
        const vector = await embedSingle(text, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "passage",
        });
        const id = randomUUID();
        const accessList = opts.accessList || [opts.owner];
        // Family visibility grants access to all family roles
        if (opts.visibility === "family") {
            const familyRoles = ["dad", "mom", "daughter", "son"];
            for (const role of familyRoles) {
                if (!accessList.includes(role))
                    accessList.push(role);
            }
        }
        const payload = {
            text,
            tenant_id: opts.tenantId,
            owner: opts.owner,
            visibility: opts.visibility || "private",
            access_list: accessList,
            category: opts.category || "general",
            created_at: Date.now(),
            ...(opts.metadata || {}),
        };
        await this.client.upsert(this.collection, {
            wait: true,
            points: [{ id, vector, payload }],
        });
        return id;
    }
    /**
     * Search memories with tenant-aware filtering.
     * Uses Qdrant's tenant_id filter pushed into the query for efficient
     * per-tenant HNSW traversal (no post-hoc filtering needed).
     *
     * Returns both accessible results and denied results (for alerting).
     */
    async search(query, opts) {
        await this.ensureCollections();
        const vector = await embedSingle(query, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "query",
        });
        // Search within tenant partition (uses per-tenant HNSW sub-graph)
        const must = [
            { key: "tenant_id", match: { value: opts.tenantId } },
        ];
        if (opts.category) {
            must.push({ key: "category", match: { value: opts.category } });
        }
        const allResults = await this.client.search(this.collection, {
            vector,
            limit: (opts.limit || 5) * 3,
            with_payload: true,
            score_threshold: opts.scoreThreshold || 0.5,
            filter: { must },
        });
        const results = [];
        const denied = [];
        for (const r of allResults) {
            const accessList = r.payload?.access_list || [];
            const owner = r.payload?.owner || "";
            const visibility = r.payload?.visibility || "private";
            const hasAccess = owner === opts.caller ||
                accessList.includes(opts.caller) ||
                visibility === "public";
            const point = {
                id: String(r.id),
                text: r.payload?.text || "",
                metadata: r.payload || {},
                score: r.score,
            };
            if (hasAccess) {
                results.push(point);
            }
            else {
                denied.push(point);
            }
        }
        return {
            results: results.slice(0, opts.limit || 5),
            denied: denied.slice(0, 3),
        };
    }
    async grantAccess(memoryQuery, opts) {
        await this.ensureCollections();
        const vector = await embedSingle(memoryQuery, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "query",
        });
        const results = await this.client.search(this.collection, {
            vector,
            limit: 3,
            with_payload: true,
            score_threshold: 0.6,
            filter: {
                must: [
                    { key: "tenant_id", match: { value: opts.tenantId } },
                    { key: "owner", match: { value: opts.granter } },
                ],
            },
        });
        const granted = [];
        for (const r of results) {
            const accessList = r.payload?.access_list || [];
            if (accessList.includes(opts.grantee))
                continue;
            accessList.push(opts.grantee);
            await this.client.setPayload(this.collection, {
                payload: { access_list: accessList },
                points: [String(r.id)],
                wait: true,
            });
            granted.push(String(r.id));
            await this.createAlert({
                type: "access_granted",
                from: opts.granter,
                to: opts.grantee,
                memoryText: r.payload?.text || "",
                memoryId: String(r.id),
            });
        }
        return { granted: granted.length, memoryIds: granted };
    }
    async revokeAccess(memoryQuery, opts) {
        await this.ensureCollections();
        const vector = await embedSingle(memoryQuery, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "query",
        });
        const results = await this.client.search(this.collection, {
            vector,
            limit: 3,
            with_payload: true,
            score_threshold: 0.6,
            filter: {
                must: [
                    { key: "tenant_id", match: { value: opts.tenantId } },
                    { key: "owner", match: { value: opts.revoker } },
                ],
            },
        });
        let revoked = 0;
        for (const r of results) {
            const accessList = (r.payload?.access_list || []).filter((u) => u !== opts.revokee);
            await this.client.setPayload(this.collection, {
                payload: { access_list: accessList },
                points: [String(r.id)],
                wait: true,
            });
            revoked++;
        }
        return revoked;
    }
    async createAlert(opts) {
        await this.ensureCollections();
        const vector = new Array(this.dimensions).fill(0);
        vector[0] = 1;
        const id = randomUUID();
        await this.client.upsert(this.alertCollection, {
            wait: true,
            points: [{
                    id,
                    vector,
                    payload: {
                        type: opts.type,
                        from: opts.from,
                        to: opts.to,
                        memory_text: opts.memoryText,
                        memory_id: opts.memoryId,
                        timestamp: Date.now(),
                        read: "false",
                    },
                }],
        });
        return id;
    }
    async getAlerts(userId) {
        await this.ensureCollections();
        const results = await this.client.scroll(this.alertCollection, {
            filter: {
                must: [
                    { key: "to", match: { value: userId } },
                    { key: "read", match: { value: "false" } },
                ],
            },
            with_payload: true,
            limit: 20,
        });
        return (results.points || []).map((p) => ({
            id: String(p.id),
            type: p.payload?.type || "access_denied",
            from: p.payload?.from || "",
            to: p.payload?.to || "",
            memoryText: p.payload?.memory_text || "",
            memoryId: p.payload?.memory_id || "",
            timestamp: p.payload?.timestamp || 0,
            read: p.payload?.read === "true",
        }));
    }
    async markAlertsRead(userId) {
        await this.ensureCollections();
        const alerts = await this.getAlerts(userId);
        for (const alert of alerts) {
            await this.client.setPayload(this.alertCollection, {
                payload: { read: "true" },
                points: [alert.id],
                wait: true,
            });
        }
        return alerts.length;
    }
    async forget(query, opts) {
        await this.ensureCollections();
        const vector = await embedSingle(query, {
            apiKey: this.apiKey,
            model: this.embeddingModel,
            inputType: "query",
        });
        const results = await this.client.search(this.collection, {
            vector,
            limit: opts.limit || 3,
            with_payload: true,
            score_threshold: opts.scoreThreshold || 0.8,
            filter: {
                must: [
                    { key: "tenant_id", match: { value: opts.tenantId } },
                    { key: "owner", match: { value: opts.caller } },
                ],
            },
        });
        if (results.length === 0)
            return 0;
        await this.client.delete(this.collection, {
            wait: true,
            points: results.map((r) => String(r.id)),
        });
        return results.length;
    }
    async getStats(tenantId) {
        await this.ensureCollections();
        const info = await this.client.getCollection(this.collection);
        const alertInfo = await this.client.getCollection(this.alertCollection);
        return {
            totalPoints: info.points_count || 0,
            totalAlerts: alertInfo.points_count || 0,
            status: String(info.status),
        };
    }
}
