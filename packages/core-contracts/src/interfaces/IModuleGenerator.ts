import type { ArtifactBundle } from '../types/ArtifactBundle.js';
import type { IModuleManifest } from './IModuleManifest.js';

/** ValidationError — a single failure from IModuleGenerator.validate(). */
export interface ValidationError {
  readonly code: string;
  readonly message: string;
  readonly filePath?: string;
}

/** ValidationResult — returned by IModuleGenerator.validate(). */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly string[];
}

/**
 * IBlueprintReader — the read-only view of the project blueprint that generators receive.
 * Abstracts underlying storage so generators remain pure functions.
 */
export interface IBlueprintReader {
  getScaffoldInput(): import('../types/ScaffoldInput.js').ScaffoldInput;
  readFile(relativePath: string): Promise<string | null>;
  listFiles(glob: string): Promise<readonly string[]>;
}

/**
 * IGeneratorAPI — the write API available to IModuleGenerator.generate() implementations.
 * All operations are scoped to the current generation context.
 *
 * v8: getArchitectOutput / getExecutorOutput added so generators can read agent
 * knowledge written during the swarm's execution for DocumentationAgent.
 */
export interface IGeneratorAPI {
  writeFile(relativePath: string, content: string): Promise<void>;
  appendFile(relativePath: string, content: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  runShellCommand(
    command: string,
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** v8: Read a field from the ArchitectAgent's output payload for this task */
  getArchitectOutput(field: string): unknown;
  /** v8: Read a field from the ExecutorAgent's output payload for this task */
  getExecutorOutput(field: string): unknown;
}

/**
 * IModuleGenerator — contract every factory module must implement.
 * generate() is a pure function — same inputs always produce the same outputs.
 * No shared mutable state → sequential→parallel scheduling is safe.
 *
 * Implementations live in packages/module-* and may ONLY import from
 * @oweibo/core-contracts. Importing from @oweibo/core-engine is a build error
 * (enforced by dependency-cruiser: 'module-cannot-import-core-engine').
 */
export interface IModuleGenerator {
  readonly manifest: IModuleManifest;
  generate(reader: IBlueprintReader, api: IGeneratorAPI): Promise<ArtifactBundle>;
  validate(bundle: ArtifactBundle): ValidationResult;
}
