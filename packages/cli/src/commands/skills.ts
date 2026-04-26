/**
 * oweibo skills — manage SKILL.md files (§22 skills system).
 *
 * Subcommands:
 *   list                  — list all installed skills
 *   sources               — list configured skill sources
 *   info <name>           — show skill detail
 *   new <name>            — scaffold a new SKILL.md in .oweibo/skills/
 *   delete <name>         — remove a skill
 *   doctor                — validate all installed skills
 *   add <source>          — add a remote skill source
 *   pull                  — pull/update skills from all sources
 *   remove <source>       — remove a remote skill source
 */
import { Command } from 'commander';
import { api } from '../client.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Skill {
  name: string;
  description?: string;
  tags?: string[];
  applies_to?: string[];
  source: string;
  size?: number;
}

interface SkillSource {
  url: string;
  type: 'git' | 'npm' | 'local';
  lastPulled?: string;
}

export function makeSkillsCommand(): Command {
  const skills = new Command('skills')
    .description('Manage oweibo SKILL.md files');

  skills
    .command('list')
    .description('List all installed skills')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const list = await api.get<Skill[]>(`/skills?tenantId=${tenantId}`);
        if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
        if (list.length === 0) { console.log('No skills installed.'); return; }
        console.log(`Installed skills (${list.length}):\n`);
        for (const s of list) {
          const tags = s.tags?.join(', ') ?? '';
          console.log(`  ${s.name.padEnd(30)} ${(s.description ?? '').slice(0, 50)}${tags ? ` [${tags}]` : ''}`);
        }
      } catch (err) {
        console.error('Failed to list skills:', (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('sources')
    .description('List configured skill sources')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const sources = await api.get<SkillSource[]>(`/skills/sources?tenantId=${tenantId}`);
        if (opts.json) { console.log(JSON.stringify(sources, null, 2)); return; }
        if (sources.length === 0) { console.log('No skill sources configured.'); return; }
        for (const s of sources) {
          const last = s.lastPulled ? `(last pulled: ${new Date(s.lastPulled).toLocaleDateString()})` : '';
          console.log(`  [${s.type}] ${s.url} ${last}`);
        }
      } catch (err) {
        console.error('Failed to list sources:', (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('info <name>')
    .description('Show detail for a skill')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (name: string, opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const skill = await api.get<Skill & { content: string }>(`/skills/${encodeURIComponent(name)}?tenantId=${tenantId}`);
        if (opts.json) { console.log(JSON.stringify(skill, null, 2)); return; }
        console.log(`Name:        ${skill.name}`);
        console.log(`Description: ${skill.description ?? '(none)'}`);
        console.log(`Tags:        ${(skill.tags ?? []).join(', ') || '(none)'}`);
        console.log(`Applies to:  ${(skill.applies_to ?? []).join(', ') || 'any'}`);
        console.log(`Source:      ${skill.source}`);
        console.log(`\n--- Content ---\n`);
        console.log(skill.content);
      } catch (err) {
        console.error(`Failed to get skill ${name}:`, (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('new <name>')
    .description('Scaffold a new SKILL.md in .oweibo/skills/')
    .option('-d, --description <text>', 'Skill description')
    .option('--applies-to <types>', 'Comma-separated file types (e.g. .ts,.tsx)')
    .action((name: string, opts: { description?: string; appliesTo?: string }) => {
      const skillDir = join(process.cwd(), '.oweibo', 'skills');
      if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });

      const skillFile = join(skillDir, `${name}.md`);
      if (existsSync(skillFile)) {
        console.error(`Skill already exists: ${skillFile}`);
        process.exit(1);
      }

      const appliesToYaml = opts.appliesTo
        ? opts.appliesTo.split(',').map(t => `  - "${t.trim()}"`).join('\n')
        : '  - ".ts"\n  - ".tsx"';

      const content = `---
name: ${name}
description: ${opts.description ?? 'Add a brief description here'}
tags:
  - custom
applies_to:
${appliesToYaml}
---

# ${name}

<!-- Describe the skill here. This content is injected into the LLM system prompt
     when this skill is active. Be specific and provide examples. -->

## Rules

1. <!-- Add your first rule -->
2. <!-- Add your second rule -->

## Examples

<!-- Optional: add code examples that illustrate the expected behaviour -->
`;

      writeFileSync(skillFile, content, 'utf-8');
      console.log(`Created: ${skillFile}`);
      console.log(`Edit the file, then restart oweibo to activate.`);
    });

  skills
    .command('delete <name>')
    .description('Remove a skill by name')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (name: string, opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        await api.delete(`/skills/${encodeURIComponent(name)}?tenantId=${tenantId}`);
        if (opts.json) console.log(JSON.stringify({ deleted: true, name }));
        else console.log(`✓ Skill ${name} deleted`);
      } catch (err) {
        console.error(`Failed to delete skill ${name}:`, (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('doctor')
    .description('Validate all installed skills for frontmatter and format issues')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const result = await api.post<{ valid: boolean; issues: Array<{ skill: string; issue: string }> }>(
          `/skills/doctor`, { tenantId }
        );
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        if (result.valid) { console.log('✓ All skills are valid'); return; }
        console.error(`${result.issues.length} issue(s) found:\n`);
        for (const i of result.issues) console.error(`  ${i.skill}: ${i.issue}`);
        process.exit(1);
      } catch (err) {
        console.error('Failed to run doctor:', (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('add <source>')
    .description('Add a remote skill source (git URL or npm package name)')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--type <type>', 'Source type: git | npm (auto-detected if omitted)')
    .option('--json', 'Output raw JSON')
    .action(async (source: string, opts: { tenant?: string; type?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const result = await api.post<SkillSource>('/skills/sources', { tenantId, url: source, type: opts.type });
        if (opts.json) console.log(JSON.stringify(result));
        else console.log(`✓ Source added: ${result.url}`);
      } catch (err) {
        console.error('Failed to add source:', (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('pull')
    .description('Pull and sync skills from all configured sources')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const result = await api.post<{ pulled: number; errors: string[] }>('/skills/pull', { tenantId });
        if (opts.json) console.log(JSON.stringify(result));
        else {
          console.log(`✓ Pulled ${result.pulled} skill(s)`);
          if (result.errors.length > 0) {
            console.error(`${result.errors.length} error(s):`);
            result.errors.forEach(e => console.error(`  ${e}`));
          }
        }
      } catch (err) {
        console.error('Failed to pull skills:', (err as Error).message);
        process.exit(1);
      }
    });

  skills
    .command('remove <source>')
    .description('Remove a remote skill source')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (source: string, opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        await api.delete(`/skills/sources/${encodeURIComponent(source)}?tenantId=${tenantId}`);
        if (opts.json) console.log(JSON.stringify({ removed: true, source }));
        else console.log(`✓ Source removed: ${source}`);
      } catch (err) {
        console.error('Failed to remove source:', (err as Error).message);
        process.exit(1);
      }
    });

  return skills;
}
