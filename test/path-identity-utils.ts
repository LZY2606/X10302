import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Eta } from "../src/index";

/** Files are declared as { relativePath: content } and written under a fresh temp dir. */
export type ViewsSpec = Record<string, string>;

const createdDirs: string[] = [];

export function makeViews(files: ViewsSpec): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-identity-"));
  createdDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

export function writeFiles(root: string, files: ViewsSpec): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function cleanupViews(): void {
  while (createdDirs.length) {
    const dir = createdDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Canonical on-disk identity of a path (symlinks + letter casing resolved). */
export function canon(p: string): string {
  return fs.realpathSync(p);
}

export interface Instrumentation {
  /** Number of times each file path was read from disk. */
  reads: Map<string, number>;
  readsOf(absPath: string): number;
  totalReads(): number;
  /** Number of template compilations. */
  compileCount(): number;
}

/**
 * Counts reads and compilations performed through the instance's own public
 * surface (`eta.readFile` / `eta.compile`), i.e. the exact functions the
 * production render path calls. A cache hit is observed as a render that
 * performs no read/compile.
 */
export function instrument(eta: Eta): Instrumentation {
  const reads = new Map<string, number>();
  let compiles = 0;

  const originalReadFile = eta.readFile;
  eta.readFile = (p: string): string => {
    reads.set(p, (reads.get(p) ?? 0) + 1);
    return originalReadFile.call(eta, p);
  };

  const originalCompile = eta.compile;
  eta.compile = function (this: Eta, ...args: Parameters<Eta["compile"]>) {
    compiles++;
    return originalCompile.apply(this, args);
  } as Eta["compile"];

  return {
    reads,
    readsOf: (absPath: string) => reads.get(absPath) ?? 0,
    totalReads: () => [...reads.values()].reduce((sum, n) => sum + n, 0),
    compileCount: () => compiles,
  };
}

/** Sorted cache keys, for order-insensitive identity comparison. */
export function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

export function sortedTemplateKeys(eta: Eta): string[] {
  const store = eta.templatesSync as unknown as {
    cache: Record<string, unknown>;
  };
  return sortedKeys(store.cache);
}
