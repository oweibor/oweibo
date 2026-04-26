// packages/browser-tool/src/stealth/UserAgentRotator.ts
// Rotates user-agent strings drawn from a representative pool of real browser
// UAs. Used by LocalPlaywrightBackend and PersistentProfileBackend to vary the
// UA on each new context without requiring external network calls.

export interface UAEntry {
  ua:        string;
  platform:  'windows' | 'macos' | 'linux';
  chromiumVersion: string;
}

/** Curated pool — all genuine Chrome/Chromium UAs from real browser versions. */
const UA_POOL: UAEntry[] = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', platform: 'windows', chromiumVersion: '124' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', platform: 'windows', chromiumVersion: '123' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', platform: 'macos', chromiumVersion: '124' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', platform: 'macos', chromiumVersion: '123' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', platform: 'linux', chromiumVersion: '124' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', platform: 'linux', chromiumVersion: '122' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', platform: 'windows', chromiumVersion: '122' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', platform: 'macos', chromiumVersion: '122' },
];

export class UserAgentRotator {
  private cursor = 0;

  constructor(private readonly pool: UAEntry[] = UA_POOL) {
    // Shuffle once at construction so instances differ from each other.
    this.pool = [...pool].sort(() => Math.random() - 0.5);
  }

  /** Return the next UA in round-robin order. */
  next(): UAEntry {
    const entry = this.pool[this.cursor % this.pool.length]!;
    this.cursor++;
    return entry;
  }

  /** Return a random UA (useful when round-robin is too predictable). */
  random(): UAEntry {
    return this.pool[Math.floor(Math.random() * this.pool.length)]!;
  }

  /** Filter pool to a specific platform. */
  forPlatform(platform: UAEntry['platform']): UAEntry {
    const filtered = this.pool.filter(e => e.platform === platform);
    if (filtered.length === 0) return this.next();
    return filtered[Math.floor(Math.random() * filtered.length)]!;
  }

  poolSize(): number {
    return this.pool.length;
  }
}
