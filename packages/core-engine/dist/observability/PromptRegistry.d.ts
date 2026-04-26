export interface PromptVersion {
    readonly text: string;
    readonly version: number;
    readonly name: string;
    readonly labels?: readonly string[];
}
export declare class PromptRegistry {
    private readonly langfuseSecretKey?;
    private readonly langfusePublicKey?;
    private readonly cache;
    constructor(langfuseSecretKey?: string | undefined, langfusePublicKey?: string | undefined);
    get(promptName: string): Promise<PromptVersion>;
    set(promptName: string, text: string): Promise<void>;
    invalidate(promptName: string): void;
    invalidateAll(): void;
    /** Seed all builtin prompts into Langfuse on first startup */
    seedBuiltins(): Promise<void>;
    private fetchFromLangfuse;
}
//# sourceMappingURL=PromptRegistry.d.ts.map