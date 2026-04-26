import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IDocTemplate, ApplicabilityResult, RenderedDocument, DocTemplateContext } from '@oweibo/core-contracts';
import type { CodebaseKnowledge } from '@oweibo/core-contracts';

const MAX_COMMITS = 500;

interface CommitEntry {
  hash:    string;
  subject: string;
  email:   string;
  author:  string;
  date:    string;
}

/**
 * ChangelogDocTemplate — Git log with GDPR-compliant author PII redaction (C13, v10.5).
 *
 * When redactAuthors=true (SaaS default): author name and email → '[redacted]'.
 * When redactAuthors=false (self-hosted CLI): author identity preserved.
 */
export class ChangelogDocTemplate implements IDocTemplate {
  readonly category = 'changelog' as const;
  readonly fileName = 'changelog.md';

  constructor(
    private readonly redactAuthors: boolean = true,
    private readonly authorMap:     Map<string, string> = new Map(),
  ) {}

  isApplicable(k: CodebaseKnowledge): ApplicabilityResult {
    const gitDir = path.join(k.rootPath, '.git');
    if (!existsSync(gitDir)) {
      return { applicable: false, degradationLevel: 'skipped', reason: 'No .git directory found at rootPath' };
    }
    return { applicable: true, degradationLevel: 'full' };
  }

  async render(k: CodebaseKnowledge, _ctx: DocTemplateContext, signal?: AbortSignal): Promise<RenderedDocument> {
    signal?.throwIfAborted();

    let commits: CommitEntry[] = [];
    try {
      commits = await this.gitLog(k.rootPath, MAX_COMMITS, signal);
    } catch {
      const rendered = '# Changelog\n\n_Could not read git history._\n';
      return {
        fileName: this.fileName, category: this.category, title: 'Changelog',
        sections: [{ id: 'changelog', title: 'Changelog', content: rendered, order: 0 }],
        rendered,
      };
    }

    signal?.throwIfAborted();

    const lines: string[] = ['# Changelog', '', `${commits.length} commits (capped at ${MAX_COMMITS}).`, ''];
    lines.push('| Hash | Date | Author | Subject |');
    lines.push('|------|------|--------|---------|');

    for (const c of commits) {
      const author = this.resolveAuthor(c.email, c.author);
      lines.push(`| \`${c.hash.slice(0, 8)}\` | ${c.date.slice(0, 10)} | ${author} | ${escapeMarkdown(c.subject)} |`);
    }
    lines.push('');

    const rendered = lines.join('\n');
    return {
      fileName: this.fileName,
      category: this.category,
      title:    'Changelog',
      sections: [{ id: 'changelog', title: 'Changelog', content: rendered, order: 0 }],
      rendered,
    };
  }

  private resolveAuthor(email: string, name: string): string {
    if (!this.redactAuthors) return escapeMarkdown(name);
    return this.authorMap.get(email) ?? '[redacted]';
  }

  private gitLog(cwd: string, maxCommits: number, signal?: AbortSignal): Promise<CommitEntry[]> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }

      const args = ['log', `--max-count=${maxCommits}`, '--format=%H|%s|%ae|%an|%aI'];
      const proc = spawn('git', args, { cwd, stdio: 'pipe' });
      let out = '';

      const onAbort = (): void => {
        proc.kill();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) { reject(new Error(`git log exited ${code}`)); return; }
        const entries = out.trim().split('\n').filter(Boolean).map((line) => {
          const [hash = '', subject = '', email = '', author = '', date = ''] = line.split('|');
          return { hash, subject, email, author, date };
        });
        resolve(entries);
      });
      proc.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }
}

function escapeMarkdown(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
