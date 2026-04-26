export declare class VideoReaper {
    private readonly dir;
    private readonly retentionDays;
    constructor(dir: string, retentionDays?: number);
    reap(): Promise<number>;
}
export declare class HarReaper {
    private readonly dir;
    private readonly retentionDays;
    constructor(dir: string, retentionDays?: number);
    reap(): Promise<number>;
}
export declare class PdfReaper {
    private readonly dir;
    private readonly retentionDays;
    constructor(dir: string, retentionDays?: number);
    reap(): Promise<number>;
}
export declare class ClamAvFreshnessJob {
    private readonly clamAvSocketPath;
    constructor(clamAvSocketPath: string);
    run(): Promise<{
        ok: boolean;
        freshness: string;
    }>;
}
//# sourceMappingURL=reapers.d.ts.map