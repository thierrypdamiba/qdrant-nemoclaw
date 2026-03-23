export interface MemoryPoint {
    id: string;
    text: string;
    metadata: Record<string, unknown>;
    score?: number;
}
export declare class QdrantMemory {
    private client;
    private collection;
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
    ensureCollection(): Promise<void>;
    store(text: string, metadata?: Record<string, unknown>, sessionId?: string): Promise<string>;
    search(query: string, opts?: {
        limit?: number;
        sessionId?: string;
        category?: string;
        scoreThreshold?: number;
    }): Promise<MemoryPoint[]>;
    forget(query: string, opts?: {
        limit?: number;
        scoreThreshold?: number;
    }): Promise<number>;
    getStats(): Promise<{
        totalPoints: number;
        status: string;
    }>;
}
