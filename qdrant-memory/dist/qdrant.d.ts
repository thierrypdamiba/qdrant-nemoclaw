export interface MemoryPoint {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
    score?: number;
}
export interface Alert {
    id: string;
    type: "access_denied" | "access_granted";
    from: string;
    to: string;
    memoryText: string;
    memoryId: string;
    timestamp: number;
    read: boolean;
}
export declare class QdrantMemory {
    private client;
    private collection;
    private alertCollection;
    private dimensions;
    private embeddingModel;
    private apiKey;
    private initialized;
    constructor(opts: {
        qdrantUrl: string;
        collection: string;
        dimensions: number;
        embeddingModel: string;
        apiKey: string;
    });
    ensureCollections(): Promise<void>;
    /**
     * Store a memory with tenant isolation.
     * tenant_id is the primary partition key for Qdrant multitenancy.
     * owner is the user who created the memory.
     * access_list controls who can read it (within or across tenants).
     */
    store(text: string, opts: {
        tenantId: string;
        owner: string;
        visibility?: "private" | "family" | "custom";
        accessList?: string[];
        category?: string;
        metadata?: Record<string, unknown>;
    }): Promise<string>;
    /**
     * Search memories with tenant-aware filtering.
     * Uses Qdrant's tenant_id filter pushed into the query for efficient
     * per-tenant HNSW traversal (no post-hoc filtering needed).
     *
     * Returns both accessible results and denied results (for alerting).
     */
    search(query: string, opts: {
        tenantId: string;
        caller: string;
        limit?: number;
        category?: string;
        scoreThreshold?: number;
    }): Promise<{
        results: MemoryPoint[];
        denied: MemoryPoint[];
    }>;
    grantAccess(memoryQuery: string, opts: {
        tenantId: string;
        granter: string;
        grantee: string;
    }): Promise<{
        granted: number;
        memoryIds: string[];
    }>;
    revokeAccess(memoryQuery: string, opts: {
        tenantId: string;
        revoker: string;
        revokee: string;
    }): Promise<number>;
    createAlert(opts: {
        type: "access_denied" | "access_granted";
        from: string;
        to: string;
        memoryText: string;
        memoryId: string;
    }): Promise<string>;
    getAlerts(userId: string): Promise<Alert[]>;
    markAlertsRead(userId: string): Promise<number>;
    forget(query: string, opts: {
        tenantId: string;
        caller: string;
        limit?: number;
        scoreThreshold?: number;
    }): Promise<number>;
    getStats(tenantId?: string): Promise<{
        totalPoints: number;
        totalAlerts: number;
        status: string;
    }>;
}
