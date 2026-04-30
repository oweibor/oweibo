/**
 * Unit tests for OllamaEmbedder — verify HTTP request shape and response
 * handling without hitting a real Ollama server.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { OllamaEmbedder } from '../OllamaEmbedder.js';

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = jest.fn() as any;
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockFetch(body: unknown, ok = true, status = 200): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global.fetch as any).mockResolvedValue({
    ok, status,
    json: async () => body,
  });
}

describe('OllamaEmbedder.embed', () => {
  it('POSTs model + prompt to /api/embeddings and returns the embedding', async () => {
    mockFetch({ embedding: [0.1, 0.2, 0.3] });
    const e = new OllamaEmbedder({ baseUrl: 'http://ollama:11434', model: 'nomic-embed-text' });

    const v = await e.embed('hello');
    expect(v).toEqual([0.1, 0.2, 0.3]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://ollama:11434/api/embeddings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ model: 'nomic-embed-text', prompt: 'hello' });
  });

  it('throws on non-2xx response', async () => {
    mockFetch({}, false, 500);
    const e = new OllamaEmbedder({ baseUrl: 'http://ollama:11434', model: 'm' });
    await expect(e.embed('x')).rejects.toThrow(/HTTP 500/);
  });

  it('throws when response is missing the embedding field', async () => {
    mockFetch({});
    const e = new OllamaEmbedder({ baseUrl: 'http://ollama:11434', model: 'm' });
    await expect(e.embed('x')).rejects.toThrow(/missing or empty/);
  });

  it('throws when embedding is empty array', async () => {
    mockFetch({ embedding: [] });
    const e = new OllamaEmbedder({ baseUrl: 'http://ollama:11434', model: 'm' });
    await expect(e.embed('x')).rejects.toThrow(/missing or empty/);
  });

  it('asEmbedder returns a plain function compatible with QdrantSemanticStore', async () => {
    mockFetch({ embedding: [1, 2] });
    const e = new OllamaEmbedder({ baseUrl: 'http://o', model: 'm' });
    const fn = e.asEmbedder();
    expect(typeof fn).toBe('function');
    expect(await fn('hi')).toEqual([1, 2]);
  });

  it('dimension() returns the configured value (default 768)', () => {
    expect(new OllamaEmbedder({ baseUrl: 'x', model: 'y' }).dimension()).toBe(768);
    expect(new OllamaEmbedder({ baseUrl: 'x', model: 'y', dimension: 1536 }).dimension()).toBe(1536);
  });
});
