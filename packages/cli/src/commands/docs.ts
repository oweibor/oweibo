/**
 * oweibo docs — generate comprehensive documentation for any codebase.
 *
 * Usage:
 *   oweibo docs ./my-project
 *   oweibo docs . --self
 *   oweibo docs ./my-project --skip-llm --output ./out/docs
 *   oweibo docs ./my-project --dry-run
 *   oweibo docs ./my-project --only architecture,api-reference
 *   oweibo docs ./my-project --redact-authors
 *
 * Flow:
 *   1. POST /api/v1/docs/generate → { sessionId }
 *   2. GET  /api/v1/docs/stream/:sessionId  (SSE)
 *   3. On completion, report written files
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { api } from '../client.js';
import { DOC_CATEGORY_ICONS, DOC_EVENT_ICONS } from '../render.js';

interface DocsOptions {
  tenant?:         string;
  output?:         string;
  skipLlm?:        boolean;
  dryRun?:         boolean;
  redactAuthors?:  boolean;
  noRedactAuthors?: boolean;
  maxFiles?:       string;
  only?:           string;
  json?:           boolean;
  self?:           boolean;
}

interface GenerateResponse {
  sessionId: string;
  queued:    boolean;
}

interface StatusResponse {
  sessionId:    string;
  status:       string;
  writtenFiles: string[] | null;
  warningCount: number;
}

export function makeDocsCommand(): Command {
  return new Command('docs')
    .description('Generate comprehensive documentation for a codebase')
    .argument('[path]', 'Path to the repository root to analyze (default: current directory)', '.')
    .option('-t, --tenant <id>', 'Tenant ID (defaults to OWEIBO_TENANT_ID env var)')
    .option('-o, --output <dir>', 'Output directory for generated docs (default: <path>/docs)')
    .option('--skip-llm', 'Skip LLM calls — structural analysis only (faster, no AI annotations)', false)
    .option('--dry-run', 'Preview scope and estimated cost without running analysis', false)
    .option('--redact-authors', 'Redact git author PII in changelog (default in SaaS mode)', false)
    .option('--no-redact-authors', 'Preserve author names in changelog (self-hosted only)')
    .option('--max-files <n>', 'Limit the number of files analyzed')
    .option('--only <categories>', 'Comma-separated list of doc categories to render')
    .option('--self', 'Self-document the oweibo monorepo (sets path to repo root)', false)
    .option('--json', 'Output raw JSON', false)
    .action(async (repoPath: string, opts: DocsOptions) => {
      const tenantId   = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      const rootPath   = opts.self ? process.cwd() : repoPath;
      const idempotencyKey = randomUUID();

      const options: Record<string, unknown> = {
        skipLLM:       opts.skipLlm  ?? false,
        dryRun:        opts.dryRun   ?? false,
        redactAuthors: opts.noRedactAuthors ? false : (opts.redactAuthors ?? true),
      };
      if (opts.output)   options['outputDir']  = opts.output;
      if (opts.maxFiles) options['maxFiles']    = parseInt(opts.maxFiles, 10);
      if (opts.only)     options['only']        = opts.only.split(',').map((s) => s.trim());

      if (!opts.json) {
        console.log(`Oweibo Docs  Analyzing: ${rootPath}`);
        if (opts.dryRun) console.log('(dry-run mode — no files will be written)');
      }

      let result: GenerateResponse;
      try {
        result = await api.post<GenerateResponse>(
          '/docs/generate',
          { rootPath, tenantId, options },
        );
      } catch (err) {
        console.error('Failed to start doc generation:', (err as Error).message);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }

      const { sessionId } = result;
      console.log(`Session ID: ${sessionId}`);
      if (!result.queued) {
        console.log('(returning existing session)');
      }

      // Stream events via SSE
      await streamDocEvents(sessionId, tenantId, opts.json ?? false);
    });
}

async function streamDocEvents(
  sessionId: string,
  tenantId:  string,
  json:      boolean,
): Promise<void> {
  const baseUrl   = process.env['OWEIBO_API_URL'] ?? 'http://localhost:3100/api/v1';
  const streamUrl = `${baseUrl}/docs/stream/${sessionId}?tenantId=${encodeURIComponent(tenantId)}`;
  const apiKey    = process.env['OWEIBO_API_KEY'] ?? '';

  try {
    const res = await fetch(streamUrl, {
      headers: { Authorization: apiKey ? `Bearer ${apiKey}` : '' },
    });

    if (!res.ok || !res.body) {
      console.error(`SSE connection failed: HTTP ${res.status}`);
      process.exit(1);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        try {
          const event = JSON.parse(raw) as { type: string; message?: string; payload?: Record<string, unknown> };

          if (json) {
            console.log(raw);
            continue;
          }

          const icon = DOC_EVENT_ICONS[event.type] ?? '';
          const msg  = event.message ?? event.type;
          console.log(`${icon} ${msg}`);

          if (event.type === 'doc-generation-complete') {
            const files = (event.payload?.['writtenFiles'] as string[] | undefined) ?? [];
            if (files.length > 0) {
              console.log(`\nFiles written (${files.length}):`);
              for (const f of files) console.log(`  ${f}`);
            }
            return;
          }

          if (event.type === 'doc-generation-warning') {
            const code = event.payload?.['code'] as string | undefined;
            console.warn(`  Warning: ${code ?? ''} — ${msg}`);
          }
        } catch {
          // unparseable line — skip
        }
      }
    }
  } catch (err) {
    console.error('Streaming error:', (err as Error).message);
    process.exit(1);
  }
}
