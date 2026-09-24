import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Eta } from "../../src/index";

/**
 * Shared fixtures for the path-resolution / cache-identity contract tests.
 *
 * Everything lives in a fresh OS temp directory (which is itself symlinked on
 * some platforms, e.g. macOS `/var` -> `/private/var`), so the tests exercise
 * canonicalization through the same temp-dir overrides users hit in practice.
 */

export interface PathIdentityFixture {
  tmp: string;
  viewsA: string;
  viewsB: string;
  /** canonical (realpath) form of viewsA — cache identities use this */
  viewsAReal: string;
  outside: string;
  /** true when the platform allowed creating the symlinks */
  symlinksSupported: boolean;
  canonical: (p: string) => string;
  cleanup: () => void;
}

const FILES: Array<[string, string]> = [
  ["viewsA/simple.eta", "Hi <%= it.name %>!"],
  ["viewsA/shared.eta", "Shared"],
  ["viewsA/sub/nested.eta", "Nested[<%~ include('../shared') %>|<%~ include('./sibling') %>]"],
  ["viewsA/sub/sibling.eta", "Sibling"],
  ["viewsA/partial.eta", "P-eta"],
  ["viewsA/partial.tmpl", "P-tmpl"],
  ["viewsA/uses-partial.eta", "Partial: <%~ include('./partial') %>"],
  ["viewsA/layout.eta", "Layout[<%~ it.body %>]"],
  ["viewsA/uses-layout.eta", "<% layout('./layout') %>Body"],
  ["viewsA/index.eta", "A index"],
  ["viewsA/CaseSensitive.eta", "Casey"],
  ["viewsA/uses-escape.eta", "<%~ include('../outside/secret') %>"],
  ["viewsA/uses-precompiled.eta", "Pre[<%~ include('@greeting') %>]"],
  ["viewsB/index.eta", "B index"],
  ["outside/secret.eta", "SECRET"],
];

const SYMLINKS: Array<[string, string]> = [
  // [link path (relative to tmp), target (relative to the link's directory)]
  ["viewsA/link-to-simple.eta", "simple.eta"],
  ["viewsA/sublink", "sub"],
  ["viewsA/escape-link.eta", "../outside/secret.eta"],
  ["viewsLink", "viewsA"],
];

export function createPathIdentityFixture(): PathIdentityFixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-path-identity-"));
  const viewsA = path.join(tmp, "viewsA");
  const viewsB = path.join(tmp, "viewsB");
  const outside = path.join(tmp, "outside");

  for (const [rel, content] of FILES) {
    const filePath = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  let symlinksSupported = true;
  for (const [relLink, target] of SYMLINKS) {
    try {
      fs.symlinkSync(target, path.join(tmp, relLink));
    } catch {
      symlinksSupported = false;
    }
  }

  return {
    tmp,
    viewsA,
    viewsB,
    viewsAReal: fs.realpathSync(viewsA),
    outside,
    symlinksSupported,
    canonical: (p: string) => fs.realpathSync(p),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * Wraps `eta.readFile` (the public seam every file load goes through) to
 * record the exact paths read, giving the tests a cache-hit/miss guard.
 */
export function countReads(eta: Eta): string[] {
  const reads: string[] = [];
  const original = eta.readFile.bind(eta);
  eta.readFile = (p: string) => {
    reads.push(p);
    return original(p);
  };
  return reads;
}

/** Counts how many times `p` appears in `reads`. */
export function readCount(reads: string[], p: string): number {
  return reads.filter((r) => r === p).length;
}
