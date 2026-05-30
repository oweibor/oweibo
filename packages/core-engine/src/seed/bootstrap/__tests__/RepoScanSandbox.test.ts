/**
 * F.5.10a — RepoScanSandbox unit tests.
 *
 * Container execution is mocked. The DockerRepoSandbox is exercised via
 * the parseSignals helper directly (the actual spawn() path requires
 * docker on PATH and is exercised in the F.5.10b integration test fixture).
 */
import {
  DockerRepoSandbox,
  NullRepoSandbox,
  REPO_SCAN_DEFAULTS,
  RepoScanError,
  parseSignals,
} from '../RepoScanSandbox.js';

describe('parseSignals', () => {
  it('extracts a well-formed signal payload', () => {
    const out = parseSignals(JSON.stringify({
      languages:  ['typescript', 'python'],
      frameworks: ['next.js'],
      fileCount:  4231,
      truncated:  false,
      notes:      ['ok'],
    }));
    expect(out.languages).toEqual(['typescript', 'python']);
    expect(out.frameworks).toEqual(['next.js']);
    expect(out.fileCount).toBe(4231);
    expect(out.truncated).toBe(false);
    expect(out.notes).toEqual(['ok']);
  });

  it('coerces missing fields to safe defaults', () => {
    const out = parseSignals(JSON.stringify({}));
    expect(out.languages).toEqual([]);
    expect(out.frameworks).toEqual([]);
    expect(out.fileCount).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.notes).toEqual([]);
  });

  it('drops non-string entries from string-array fields', () => {
    const out = parseSignals(JSON.stringify({
      languages: ['ts', 42, null, 'py'],
      frameworks: 'not-an-array',
    }));
    expect(out.languages).toEqual(['ts', 'py']);
    expect(out.frameworks).toEqual([]);
  });

  it('throws on empty stdout', () => {
    expect(() => parseSignals('')).toThrow(/empty stdout/);
  });

  it('throws on non-object JSON', () => {
    expect(() => parseSignals('[1,2,3]')).toThrow(/top-level not an object/);
  });
});

describe('DockerRepoSandbox constructor', () => {
  it('throws when image is missing', () => {
    expect(() => new DockerRepoSandbox({ image: '' })).toThrow(/image is required/);
  });
});

describe('DockerRepoSandbox.scan (ENOENT path)', () => {
  it('rejects with container_runtime_unavailable when docker is not on PATH', async () => {
    const sandbox = new DockerRepoSandbox({
      image: 'test/image:latest',
      dockerBinary: '/nonexistent/path/to/docker-binary-that-does-not-exist',
    });
    await expect(sandbox.scan({ repoUrl: 'https://example.com/x.git', timeoutMs: 500 }))
      .rejects.toMatchObject({ reason: 'container_runtime_unavailable' });
  });
});

describe('NullRepoSandbox', () => {
  it('returns empty signals with a note', async () => {
    const out = await new NullRepoSandbox().scan({ repoUrl: 'https://example.com/x.git' });
    expect(out.fileCount).toBe(0);
    expect(out.notes).toEqual(['null-sandbox: no scan performed']);
  });
});

describe('REPO_SCAN_DEFAULTS', () => {
  it('honours the documented security limits', () => {
    expect(REPO_SCAN_DEFAULTS.WALL_CLOCK_MS).toBe(120_000);
    expect(REPO_SCAN_DEFAULTS.MAX_TREE_BYTES).toBe(1024 * 1024 * 1024);
    expect(REPO_SCAN_DEFAULTS.MAX_FILE_COUNT).toBe(100_000);
    expect(REPO_SCAN_DEFAULTS.CLONE_DEPTH).toBe(1);
    expect(REPO_SCAN_DEFAULTS.ALLOWED_EXTENSIONS).toContain('.ts');
    expect(REPO_SCAN_DEFAULTS.ALLOWED_EXTENSIONS).not.toContain('.exe');
    expect(REPO_SCAN_DEFAULTS.ALLOWED_EXTENSIONS).not.toContain('.so');
  });
});

describe('RepoScanError', () => {
  it('carries the structured reason in name + reason field', () => {
    const e = new RepoScanError('wall_clock_exceeded', 'too slow');
    expect(e.name).toBe('RepoScanError');
    expect(e.reason).toBe('wall_clock_exceeded');
    expect(e.message).toContain('wall_clock_exceeded');
  });
});
