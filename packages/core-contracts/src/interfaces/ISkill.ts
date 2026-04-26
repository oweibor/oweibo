/**
 * ISkill — zero-dependency skill shape (NEW v9.4 §22).
 * Skills are prompt-time procedural knowledge injected into every agent prompt
 * between ProjectRulesLoader output and the base system prompt.
 *
 * Cross-harness compatible: any SKILL.md that works in Claude Code or Cursor
 * works here without modification.
 *
 * Skills are ORTHOGONAL to Plugins:
 *   Plugin = runtime capability module (installed/removed at build time)
 *   Skill  = prompt-time procedural knowledge (injected at inference time)
 *
 * SkillRegistry MUST NEVER import PluginRegistry (enforced by dependency-cruiser rule
 * 'skill-registry-cannot-import-plugin-registry').
 */
export interface ISkill {
  /** Unique identifier — derived from YAML frontmatter `name` or directory name */
  readonly id: string;
  /** Human-readable name from YAML frontmatter, or directory name fallback */
  readonly name: string;
  /** One-line description for semantic selection (from frontmatter or first paragraph) */
  readonly description: string;
  /** Absolute path to the SKILL.md source file */
  readonly filePath: string;
  /**
   * Source directory of origin — used for ID collision resolution by priority:
   * '.oweibo/skills' > '.skills' > 'skills' > 'top-level' > 'remote'
   */
  readonly source: '.oweibo/skills' | '.skills' | 'skills' | 'top-level' | 'remote';
  /** Full markdown content of the SKILL.md file (YAML frontmatter stripped, truncated to 3000 chars) */
  readonly content: string;
  /** SHA-256 of the raw SKILL.md content — used for change detection and Qdrant upsert deduplication */
  readonly contentHash: string;
  /** Tags from YAML frontmatter `tags:` array — used for filtering and CLI display */
  readonly tags: readonly string[];
  /**
   * Which task mode(s) this skill applies to.
   * 'general-coding' — injected only for general-coding tasks (default for cross-harness compat)
   * 'factory'        — injected only for factory pipeline tasks
   * 'both'           — injected for all task modes
   */
  readonly appliesTo: 'general-coding' | 'factory' | 'both';
  /**
   * @deprecated Use filePath. Kept for backward compatibility with v9.4.0 callers.
   * Will be removed in v9.5.
   */
  readonly sourcePath?: string;
  /**
   * Estimated token count — computed by ModelRouter tokenizer, not word count.
   * Used by prompt assembler to respect context window budget.
   */
  readonly estimatedTokens?: number;
  /**
   * Qdrant vector embedding point ID for cosine similarity lookup.
   * Set by SkillRegistry after the skill has been indexed.
   */
  readonly qdrantPointId?: string;
}
