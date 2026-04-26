/**
 * IDocTemplateContractSuite (C18, v10.5)
 *
 * Shared contract test suite for IDocTemplate implementations.
 * The IDocTemplate suite includes a real secret-pattern check so plugin-generated
 * content is held to the same standard as built-in templates.
 *
 * Usage:
 *   import { describeIDocTemplateContract } from '@oweibo/core-contracts/testing';
 *
 *   describeIDocTemplateContract(new MyTemplate(), minimalKnowledge, mockCtx);
 */

import type { IDocTemplate, DocTemplateContext } from '../interfaces/IDocTemplate.js';
import type { CodebaseKnowledge } from '../types/CodebaseKnowledge.js';

/** Minimal secret patterns mirrored from DocValidator — kept in sync manually. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:api_?key|access_?token|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi,
  /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i,
  /AKIA[0-9A-Z]{16}/g,
];

/**
 * Call inside a describe block to run the full contract suite against impl.
 * Expects Jest globals — works with ts-jest.
 */
export function describeIDocTemplateContract(
  impl:      IDocTemplate,
  knowledge: CodebaseKnowledge,
  ctx:       DocTemplateContext,
): void {
  describe('IDocTemplate contract', () => {
    it('isApplicable returns ApplicabilityResult with boolean + degradationLevel', () => {
      const result = impl.isApplicable(knowledge);
      expect(result).toBeDefined();
      expect(typeof result.applicable).toBe('boolean');
      expect(['full', 'partial', 'skeleton', 'skipped']).toContain(result.degradationLevel);
    });

    it('render returns RenderedDocument with non-empty rendered string when applicable', async () => {
      const applicability = impl.isApplicable(knowledge);
      if (!applicability.applicable) return; // skip if template says not applicable
      const doc = await impl.render(knowledge, ctx);
      expect(doc).toBeDefined();
      expect(typeof doc.fileName).toBe('string');
      expect(doc.fileName.length).toBeGreaterThan(0);
      expect(typeof doc.rendered).toBe('string');
      expect(doc.rendered.length).toBeGreaterThan(0);
      expect(Array.isArray(doc.sections)).toBe(true);
    });

    it('render respects AbortSignal — rejects when signal aborted before render', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        impl.render(knowledge, ctx, controller.signal),
      ).rejects.toThrow();
    });

    it('render does not write to filesystem directly', async () => {
      const applicability = impl.isApplicable(knowledge);
      if (!applicability.applicable) return;
      // Spy on fs module — if no real fs calls are made this is a no-op check
      // (contract: render returns RenderedDocument, DocExporter handles writing)
      const fsSpy = jest.spyOn(
        await import('fs').then((m) => m.promises),
        'writeFile',
      ).mockResolvedValue(undefined);
      try {
        await impl.render(knowledge, ctx);
        expect(fsSpy).not.toHaveBeenCalled();
      } finally {
        fsSpy.mockRestore();
      }
    });

    it('render output contains no raw secrets matching DocValidator regex patterns', async () => {
      const applicability = impl.isApplicable(knowledge);
      if (!applicability.applicable) return;
      const doc = await impl.render(knowledge, ctx);
      for (const pattern of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        expect(doc.rendered).not.toMatch(pattern);
      }
    });

    it('fileName does not contain path traversal sequences', () => {
      const { fileName } = impl;
      expect(fileName).not.toContain('../');
      expect(fileName).not.toContain('..\\');
      expect(fileName.startsWith('/')).toBe(false);
    });
  });
}
