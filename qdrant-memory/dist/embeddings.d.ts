export declare function embed(texts: string[], opts: {
    apiKey: string;
    model?: string;
    inputType?: "query" | "passage";
}): Promise<number[][]>;
export declare function embedSingle(text: string, opts: {
    apiKey: string;
    model?: string;
    inputType?: "query" | "passage";
}): Promise<number[]>;
