export declare class SafeBrowsingClient {
    private readonly apiKey;
    private readonly cache;
    constructor(apiKey: string);
    check(url: string): Promise<'safe' | 'unsafe'>;
}
//# sourceMappingURL=SafeBrowsingClient.d.ts.map