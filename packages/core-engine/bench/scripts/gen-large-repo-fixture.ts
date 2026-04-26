/**
 * gen-large-repo-fixture.ts — generates a synthetic large-repo fixture for benchmarks.
 *
 * Output: bench/fixtures/large-repo/ containing ~500 TypeScript + ~100 Python source files.
 *
 * Usage:  npx ts-node bench/scripts/gen-large-repo-fixture.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR     = path.join(__dirname, '..', 'fixtures', 'large-repo');
const TS_MODULES  = 20;   // number of sub-packages, each with 25 TS files
const TS_PER_PKG  = 25;
const PY_FILES    = 100;

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  // TypeScript packages
  for (let m = 0; m < TS_MODULES; m++) {
    const pkgDir = path.join(OUT_DIR, `packages`, `pkg-${m}`, `src`);
    await fs.mkdir(pkgDir, { recursive: true });
    for (let f = 0; f < TS_PER_PKG; f++) {
      await fs.writeFile(
        path.join(pkgDir, `Service${f}.ts`),
        generateTsFile(m, f),
        'utf-8',
      );
    }
  }

  // Python files
  const pyDir = path.join(OUT_DIR, 'python');
  await fs.mkdir(pyDir, { recursive: true });
  for (let f = 0; f < PY_FILES; f++) {
    await fs.writeFile(path.join(pyDir, `module${f}.py`), generatePyFile(f), 'utf-8');
  }

  const total = TS_MODULES * TS_PER_PKG + PY_FILES;
  console.log(`Generated ${total} files in ${OUT_DIR}`);
}

function generateTsFile(pkg: number, idx: number): string {
  return `/**
 * Auto-generated benchmark fixture: pkg-${pkg}/Service${idx}.ts
 */
import { EventEmitter } from 'node:events';

export interface IService${idx} {
  execute(id: string): Promise<string>;
}

export class Service${idx} extends EventEmitter implements IService${idx} {
  constructor(private readonly dep: IService${idx - 1 >= 0 ? idx - 1 : idx}) {
    super();
  }

  async execute(id: string): Promise<string> {
    if (!id) {
      throw new Error('id required');
    }
    this.emit('executed', id);
    return \`result-\${id}\`;
  }
}
`;
}

function generatePyFile(idx: number): string {
  return `# Auto-generated benchmark fixture: module${idx}.py

class Handler${idx}:
    """Handles requests for module ${idx}."""

    def __init__(self, dep: 'Handler${idx - 1 >= 0 ? idx - 1 : idx}' = None):
        self.dep = dep

    def handle(self, request: dict) -> dict:
        if not request:
            raise ValueError("request required")
        return {"result": f"handled-{request.get('id', 'unknown')}"}

def process_${idx}(data: list) -> list:
    """Process a list of items."""
    return [Handler${idx}().handle(item) for item in data if item]
`;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
