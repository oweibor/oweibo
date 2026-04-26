export interface UAEntry {
    ua: string;
    platform: 'windows' | 'macos' | 'linux';
    chromiumVersion: string;
}
export declare class UserAgentRotator {
    private readonly pool;
    private cursor;
    constructor(pool?: UAEntry[]);
    /** Return the next UA in round-robin order. */
    next(): UAEntry;
    /** Return a random UA (useful when round-robin is too predictable). */
    random(): UAEntry;
    /** Filter pool to a specific platform. */
    forPlatform(platform: UAEntry['platform']): UAEntry;
    poolSize(): number;
}
//# sourceMappingURL=UserAgentRotator.d.ts.map