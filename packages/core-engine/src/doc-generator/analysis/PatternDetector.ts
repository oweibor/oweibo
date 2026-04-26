import type { FileAnalysis, SymbolInfo } from '@oweibo/core-contracts';

export type PatternKind =
  | 'repository'
  | 'service-layer'
  | 'factory'
  | 'observer-event-driven'
  | 'pipeline-middleware'
  | 'strategy'
  | 'singleton'
  | 'dependency-injection'
  | 'cqrs'
  | 'monorepo'
  | 'layered-architecture'
  | 'hexagonal-architecture';

export interface DetectedPattern {
  readonly kind:       PatternKind;
  readonly confidence: number;
  /** File paths that contributed to this detection. */
  readonly evidence:   readonly string[];
  readonly description: string;
}

export interface PatternDetectorOptions {
  /** Minimum confidence to include a pattern. Default: 0.7 */
  readonly minConfidence?: number;
}

const DEFAULTS: Required<PatternDetectorOptions> = {
  minConfidence: 0.7,
};

/**
 * PatternDetector — pure heuristic pattern detection over FileAnalysis results.
 *
 * No LLM calls. Confidence thresholds are empirically tuned per-pattern
 * to balance precision and recall.
 */
export class PatternDetector {
  private readonly minConfidence: number;

  constructor(options: PatternDetectorOptions = {}) {
    this.minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
  }

  detect(
    files:         readonly FileAnalysis[],
    fsEntries?:    readonly string[], // optional list of all file paths for structure heuristics
  ): readonly DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const all = fsEntries ?? files.map((f) => f.filePath);

    const maybeAdd = (p: DetectedPattern) => {
      if (p.confidence >= this.minConfidence) patterns.push(p);
    };

    maybeAdd(this.detectMonorepo(all));
    maybeAdd(this.detectLayered(all));
    maybeAdd(this.detectHexagonal(all));
    maybeAdd(this.detectRepository(files));
    maybeAdd(this.detectServiceLayer(files));
    maybeAdd(this.detectFactory(files));
    maybeAdd(this.detectObserver(files));
    maybeAdd(this.detectPipeline(files));
    maybeAdd(this.detectSingleton(files));
    maybeAdd(this.detectCqrs(files));
    maybeAdd(this.detectDI(files));
    maybeAdd(this.detectStrategy(files));

    return patterns;
  }

  // ── Structural (FS-based) ───────────────────────────────────────────────────

  private detectMonorepo(paths: readonly string[]): DetectedPattern {
    const hasWorkspace = paths.some(
      (p) => p.endsWith('pnpm-workspace.yaml') || p.endsWith('lerna.json') || p.endsWith('nx.json'),
    );
    return {
      kind: 'monorepo',
      confidence: hasWorkspace ? 0.95 : 0,
      evidence: paths.filter((p) => p.endsWith('pnpm-workspace.yaml') || p.endsWith('lerna.json')),
      description: 'Multi-package monorepo workspace',
    };
  }

  private detectLayered(paths: readonly string[]): DetectedPattern {
    const layers = ['controllers', 'services', 'repositories', 'models', 'domain', 'infrastructure'];
    const found = layers.filter((l) => paths.some((p) => p.includes(`/${l}/`) || p.includes(`\\${l}\\`)));
    const confidence = found.length >= 3 ? 0.75 : found.length >= 2 ? 0.5 : 0;
    return {
      kind: 'layered-architecture',
      confidence,
      evidence: found.map((l) => paths.find((p) => p.includes(l))!).filter(Boolean),
      description: `Layered architecture with ${found.join(', ')} directories`,
    };
  }

  private detectHexagonal(paths: readonly string[]): DetectedPattern {
    const hasPorts    = paths.some((p) => /\/ports\//.test(p) || /\\ports\\/.test(p));
    const hasAdapters = paths.some((p) => /\/adapters\//.test(p) || /\\adapters\\/.test(p));
    const confidence  = hasPorts && hasAdapters ? 0.80 : 0;
    return {
      kind: 'hexagonal-architecture',
      confidence,
      evidence: paths.filter((p) => /\/(ports|adapters)\//.test(p)),
      description: 'Hexagonal (ports & adapters) architecture',
    };
  }

  // ── Symbol-based ────────────────────────────────────────────────────────────

  private detectRepository(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasName   = /[Rr]epository/.test(f.filePath);
      const hasCrud   = f.exports.some((s) => /^(find|create|save|update|delete|remove)/i.test(s.name));
      if (hasName && hasCrud) evidence.push(f.filePath);
    }
    return {
      kind: 'repository',
      confidence: evidence.length > 0 ? 0.75 : 0,
      evidence,
      description: 'Repository pattern (CRUD abstraction over persistence)',
    };
  }

  private detectServiceLayer(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasName = /[Ss]ervice/.test(f.filePath);
      const hasDI   = f.exports.some((s) => s.kind === 'class' && (s.members?.length ?? 0) > 0);
      if (hasName && hasDI) evidence.push(f.filePath);
    }
    return {
      kind: 'service-layer',
      confidence: evidence.length > 0 ? 0.65 : 0,
      evidence,
      description: 'Service layer (business logic separated from controllers and persistence)',
    };
  }

  private detectFactory(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasFactory = f.exports.some(
        (s) => /^(create|build|make|produce)[A-Z]/.test(s.name) && s.kind === 'function',
      );
      if (hasFactory) evidence.push(f.filePath);
    }
    return {
      kind: 'factory',
      confidence: evidence.length >= 2 ? 0.80 : evidence.length === 1 ? 0.55 : 0,
      evidence,
      description: 'Factory pattern (create* functions returning instances)',
    };
  }

  private detectObserver(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasEmitter = f.imports.some((i) => i.source === 'events' || /EventEmitter/i.test(i.source));
      const hasOnEmit  = f.exports.some((s) => s.members?.some((m) => m.name === 'on' || m.name === 'emit'));
      if (hasEmitter || hasOnEmit) evidence.push(f.filePath);
    }
    return {
      kind: 'observer-event-driven',
      confidence: evidence.length > 0 ? 0.70 : 0,
      evidence,
      description: 'Observer / event-driven pattern (EventEmitter or on/emit pairs)',
    };
  }

  private detectPipeline(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasMiddleware = f.exports.some(
        (s) => s.kind === 'function' && /[Mm]iddleware|[Hh]andler|[Ii]nterceptor/.test(s.name),
      );
      if (hasMiddleware) evidence.push(f.filePath);
    }
    return {
      kind: 'pipeline-middleware',
      confidence: evidence.length >= 2 ? 0.70 : 0,
      evidence,
      description: 'Pipeline / middleware chain pattern',
    };
  }

  private detectSingleton(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasSingleton = f.exports.some((s) => {
        if (s.kind !== 'class') return false;
        const members = s.members ?? [];
        return members.some(
          (m) => m.name === 'getInstance' && m.visibility === 'public',
        ) && members.some((m) => m.visibility === 'private' && m.name === 'instance');
      });
      if (hasSingleton) evidence.push(f.filePath);
    }
    return {
      kind: 'singleton',
      confidence: evidence.length > 0 ? 0.85 : 0,
      evidence,
      description: 'Singleton pattern (private constructor + getInstance())',
    };
  }

  private detectDI(files: readonly FileAnalysis[]): DetectedPattern {
    const evidence: string[] = [];
    for (const f of files) {
      const hasInject = f.exports.some(
        (s) => s.kind === 'class' && (s.decorators?.some((d) => /Inject|Injectable|Component|Service/i.test(d)) ?? false),
      );
      if (hasInject) evidence.push(f.filePath);
    }
    return {
      kind: 'dependency-injection',
      confidence: evidence.length > 0 ? 0.60 : 0,
      evidence,
      description: 'Dependency injection (constructor injection or DI decorators)',
    };
  }

  private detectCqrs(files: readonly FileAnalysis[]): DetectedPattern {
    const hasCommands = files.some((f) => /[Cc]ommand/.test(f.filePath) && f.exports.length > 0);
    const hasQueries  = files.some((f) => /[Qq]uery/.test(f.filePath) && f.exports.length > 0);
    const evidence    = files.filter((f) => /[Cc]ommand|[Qq]uery/.test(f.filePath)).map((f) => f.filePath);
    return {
      kind: 'cqrs',
      confidence: hasCommands && hasQueries ? 0.80 : 0,
      evidence,
      description: 'CQRS pattern (separate Command and Query files)',
    };
  }

  private detectStrategy(files: readonly FileAnalysis[]): DetectedPattern {
    const interfaces: SymbolInfo[] = files.flatMap((f) =>
      f.exports.filter((s) => s.kind === 'interface'),
    );
    const evidence: string[] = [];
    for (const iface of interfaces) {
      const implementations = files.filter((f) =>
        f.exports.some(
          (s) => s.kind === 'class' && s.members?.some((m) => m.name === iface.name),
        ) || f.dependencies.some((d) => d === iface.filePath),
      );
      if (implementations.length >= 2) {
        evidence.push(iface.filePath);
      }
    }
    return {
      kind: 'strategy',
      confidence: evidence.length > 0 ? 0.75 : 0,
      evidence,
      description: 'Strategy pattern (interface + 2+ implementations)',
    };
  }
}
