import type { CodeLanguage, SymbolInfo, ImportInfo } from '@oweibo/core-contracts';

export interface DocAnalysisCacheEntry {
  readonly fileHash:    string;
  readonly language:    CodeLanguage;
  readonly richSymbols: readonly SymbolInfo[];
  readonly imports:     readonly ImportInfo[];
  readonly exports:     readonly SymbolInfo[];
  readonly complexity:  number;
  readonly lineCount:   number;
  readonly lastIndexed: string; // ISO 8601 UTC
}

export interface ICacheBackend {
  /**
   * Atomic read-modify-write over the full entry map.
   * The callback receives the current entries (or {}) and returns the updated map.
   */
  transaction(
    key: string,
    fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>,
  ): Promise<void>;

  get(key: string): Promise<DocAnalysisCacheEntry | undefined>;
  getAll(): Promise<Record<string, DocAnalysisCacheEntry>>;
  clear(): Promise<void>;
}
