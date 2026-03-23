const NVIDIA_EMBEDDINGS_URL = "https://integrate.api.nvidia.com/v1/embeddings";
export async function embed(texts, opts) {
    const model = opts.model || "nvidia/nv-embedqa-e5-v5";
    const inputType = opts.inputType || "query";
    const res = await fetch(NVIDIA_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({
            input: texts,
            model,
            input_type: inputType,
            encoding_format: "float",
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`NVIDIA embeddings API error ${res.status}: ${body}`);
    }
    const data = (await res.json());
    return data.data.map((d) => d.embedding);
}
export async function embedSingle(text, opts) {
    const results = await embed([text], opts);
    return results[0];
}
