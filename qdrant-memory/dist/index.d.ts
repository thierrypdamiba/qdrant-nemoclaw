import { type TObject, type TProperties } from "@sinclair/typebox";
interface PluginApi {
    registerTool: (factory: (ctx: ToolContext) => AgentTool[] | null, opts?: {
        names?: string[];
    }) => void;
    registerCommand: (def: {
        name: string;
        description: string;
        handler: (args: string) => {
            text: string;
        };
    }) => void;
    pluginConfig?: Record<string, unknown>;
    logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
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
    execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
        details: Record<string, unknown>;
    }>;
}
declare function register(api: PluginApi): void;
declare const _default: {
    id: string;
    name: string;
    description: string;
    register: typeof register;
};
export default _default;
