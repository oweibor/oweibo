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
export declare function makeSkillsCommand(): Command;
//# sourceMappingURL=skills.d.ts.map