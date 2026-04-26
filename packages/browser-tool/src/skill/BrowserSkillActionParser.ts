// packages/browser-tool/src/skill/BrowserSkillActionParser.ts
// Parses skill YAML/JSON action lists and validates each action against
// BrowserActionSchema before they're queued for BrowserTool dispatch (M5).
import * as yaml from 'js-yaml';
import { BrowserActionSchema } from '../tool/BrowserActionSchema.js';
import type { BrowserAction } from '@oweibo/core-contracts';

export interface ParsedSkillActions {
  actions: BrowserAction[];
  errors:  string[];
}

export class BrowserSkillActionParser {
  parse(source: string): ParsedSkillActions {
    let raw: unknown;
    try { raw = yaml.load(source); }
    catch (e) { return { actions: [], errors: [`yaml load failed: ${(e as Error).message}`] }; }

    if (!Array.isArray(raw)) return { actions: [], errors: ['top-level must be a list of actions'] };

    const actions: BrowserAction[] = [];
    const errors:  string[]        = [];
    raw.forEach((item, i) => {
      const r = BrowserActionSchema.safeParse(item);
      if (r.success) actions.push(r.data as BrowserAction);
      else           errors.push(`action[${i}]: ${r.error.message}`);
    });
    return { actions, errors };
  }
}
