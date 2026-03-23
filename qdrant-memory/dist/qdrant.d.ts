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
    store(text: string, opts: {
        owner: string;
        visibility?: "private" | "family" | "custom";
        accessList?: string[];
        category?: string;
        metadata?: Record<string, unknown>;
    }): Promise<string>;
    search(query: string, opts: {
        caller: string;
        limit?: number;
        category?: string;
        scoreThreshold?: number;
    }): Promise<{
        results: MemoryPoint[];
        denied: MemoryPoint[];
    }>;
    grantAccess(memoryQuery: string, opts: {
        granter: string;
        grantee: string;
    }): Promise<{
        granted: number;
        memoryIds: string[];
    }>;
    revokeAccess(memoryQuery: string, opts: {
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
        caller: string;
        limit?: number;
        scoreThreshold?: number;
    }): Promise<number>;
    getStats(): Promise<{
        totalPoints: number;
        totalAlerts: number;
        status: string;
    }>;
}
