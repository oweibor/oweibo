/**
 * Contract test: verifies this module package exports a valid IModuleGenerator.
 * Structural smoke test only — behaviour is validated in integration tests.
 */
import { describe, it, expect } from 'vitest';

describe('module-compliance contract', () => {
  it('default export is an IModuleGenerator', async () => {
    const mod = await import('../index.js');
    const GeneratorClass = mod.default ?? Object.values(mod)[0];
    expect(typeof GeneratorClass).toBe('function');
    const instance = new (GeneratorClass as new () => { manifest: unknown; generate: unknown; validate: unknown })();
    expect(typeof instance.manifest).toBe('object');
    expect(typeof instance.generate).toBe('function');
    expect(typeof instance.validate).toBe('function');
  });

  it('manifest declares required fields', async () => {
    const mod = await import('../index.js');
    const GeneratorClass = mod.default ?? Object.values(mod)[0];
    const instance = new (GeneratorClass as new () => { manifest: Record<string, unknown> })();
    const { manifest } = instance;
    expect(typeof manifest.name).toBe('string');
    expect(typeof manifest.version).toBe('string');
    expect(Array.isArray(manifest.emits)).toBe(true);
    expect(Array.isArray(manifest.consumes)).toBe(true);
  });
});
