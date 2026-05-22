/**
 * T.2.d: GoalTemplateCatalog — versioned, in-repo registry of platform-
 * curated goal templates.
 *
 * Each template has:
 *   - templateId: stable key
 *   - triggerSummary: short prose used to embed + match against incoming
 *     user goals
 *   - subGoalSkeleton: pre-baked ISubGoal[] that seeds the decomposer
 *   - applicableTo: optional template / industry filters
 *
 * Catalog files live at `./goal-templates/*.json` and ship as part of the
 * package's dist tree. A separate platform admin tool upserts them into
 * `oweibo.goal_templates` (writes are restricted to platform_admin via
 * the table's RLS policy); the runtime matcher reads from the DB.
 *
 * The in-memory catalog object is the *source of truth* for the JSON
 * shape; the DB is a read-optimized projection.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ISubGoal } from '@oweibo/core-contracts';

export interface GoalTemplate {
  readonly templateId: string;
  readonly catalogVersion: string;
  readonly triggerSummary: string;
  readonly subGoalSkeleton: readonly ISubGoal[];
  readonly applicableTo: {
    readonly templates: readonly string[];
    readonly industries?: readonly string[];
  };
}

export interface CatalogFilter {
  readonly templateSlug: string;
  readonly industry?: string;
}

export class GoalTemplateCatalog {
  private constructor(private readonly entries: readonly GoalTemplate[]) {}

  static async loadFromDirectory(dir: string): Promise<GoalTemplateCatalog> {
    const files = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    const all: GoalTemplate[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) {
        throw new Error(`GoalTemplateCatalog: ${f} missing entries[]`);
      }
      for (const e of parsed.entries) {
        validateTemplate(e, f);
        all.push(e as GoalTemplate);
      }
    }
    assertTemplateIdsUnique(all);
    return new GoalTemplateCatalog(all);
  }

  static fromEntries(entries: readonly GoalTemplate[]): GoalTemplateCatalog {
    assertTemplateIdsUnique(entries);
    return new GoalTemplateCatalog(entries);
  }

  static defaultDirectory(): string {
    return path.join(__dirname, 'goal-templates');
  }

  forTenant(filter: CatalogFilter): GoalTemplate[] {
    return this.entries.filter((t) => {
      const templates = t.applicableTo.templates;
      if (!templates.includes('*') && !templates.includes(filter.templateSlug)) return false;
      const industries = t.applicableTo.industries;
      if (industries && industries.length > 0) {
        if (!filter.industry) return false;
        if (!industries.includes(filter.industry)) return false;
      }
      return true;
    });
  }

  get size(): number {
    return this.entries.length;
  }

  all(): readonly GoalTemplate[] {
    return this.entries;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function validateTemplate(e: unknown, source: string): asserts e is GoalTemplate {
  if (!e || typeof e !== 'object') {
    throw new Error(`GoalTemplateCatalog: ${source} contains a non-object entry`);
  }
  const o = e as Record<string, unknown>;
  for (const k of ['templateId', 'catalogVersion', 'triggerSummary'] as const) {
    if (typeof o[k] !== 'string' || o[k] === '') {
      throw new Error(`GoalTemplateCatalog: ${source} entry missing required string field ${k}`);
    }
  }
  if (!Array.isArray(o.subGoalSkeleton) || o.subGoalSkeleton.length === 0) {
    throw new Error(`GoalTemplateCatalog: ${source} entry has empty subGoalSkeleton`);
  }
  const at = o.applicableTo as Record<string, unknown> | undefined;
  if (!at || !Array.isArray(at.templates)) {
    throw new Error(`GoalTemplateCatalog: ${source} entry missing applicableTo.templates`);
  }
}

function assertTemplateIdsUnique(entries: readonly GoalTemplate[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.templateId)) {
      throw new Error(`GoalTemplateCatalog: duplicate templateId ${e.templateId}`);
    }
    seen.add(e.templateId);
  }
}
