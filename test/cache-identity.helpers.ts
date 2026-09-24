import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Eta, type EtaConfig } from "../src/index";

/**
 * Shared fixtures for the template path resolution / cache identity suites.
 *
 * Everything lives under a fresh os.tmpdir() directory; no external services.
 */

export interface IdentityFixture {
  /** Lexical temp root (may itself be reached through a symlink, e.g. macOS /var). */
  root: string;
  viewsA: string;
  viewsB: string;
  /** Canonical path of a file inside viewsA. */
  canonical: (...segments: string[]) => string;
  /** Whether symlinks could be created in this environment. */
  symlinks: boolean;
  cleanup: () => void;
}

export function createIdentityFixture(): IdentityFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-cache-identity-"));
  const viewsA = path.join(root, "views-a");
  const viewsB = path.join(root, "views-b");

  fs.mkdirSync(path.join(viewsA, "sub"), { recursive: true });
  fs.mkdirSync(viewsB, { recursive: true });

  const write = (rel: string, content: string) =>
    fs.writeFileSync(path.join(root, rel), content);

  // Nested include chain: index -> sub/page -> sub/widget (includer-relative).
  write("views-a/index.eta", "A:index[<%~ include('./sub/page') %>]");
  write("views-a/sub/page.eta", "A:sub/page[<%~ include('./widget') %>]");
  write("views-a/sub/widget.eta", "A:sub/widget(<%= it.name %>)");
  // Shadow candidate: a same-named file at the views root that the nested
  // include above must NOT resolve to.
  write("views-a/widget.eta", "A:root/widget");
  // Same template name in two different roots.
  write("views-a/page.eta", "A:root/page");
  write("views-b/page.eta", "B:page");
  // Extension-omission and config-switch targets.
  write("views-a/shared.eta", "A:shared");
  write("views-a/shared.tmpl", "A:shared-tmpl");
  // Layout chain.
  write(
    "views-a/with-layout.eta",
    "<% layout('./layout-main') %>L:<%= it.name %>",
  );
  write("views-a/layout-main.eta", "M[<%~ it.body %>]");
  // A file outside every views root (traversal / symlink-escape target).
  write("secret.eta", "SECRET-OUTSIDE-VIEWS");

  let symlinks = true;
  try {
    // Symlink inside the root pointing at a file inside the same root.
    fs.symlinkSync("shared.eta", path.join(viewsA, "alias-shared.eta"));
    // Symlink inside the root escaping to a file outside the root.
    fs.symlinkSync(
      path.join("..", "secret.eta"),
      path.join(viewsA, "escape-link.eta"),
    );
  } catch {
    symlinks = false;
  }

  return {
    root,
    viewsA,
    viewsB,
    canonical: (...segments: string[]) =>
      fs.realpathSync(path.join(viewsA, ...segments)),
    symlinks,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Wraps a real Eta instance and counts readFile calls (= cache misses).
 * readFile is Eta's documented public override point for file loading, so
 * this observes the production path without touching internal state.
 */
export function withReadCounter<T extends Partial<EtaConfig>>(
  config: T,
): { eta: Eta; reads: string[] } {
  const eta = new Eta(config);
  const reads: string[] = [];
  const original = eta.readFile;
  eta.readFile = (filePath: string) => {
    reads.push(filePath);
    return original.call(eta, filePath);
  };
  return { eta, reads };
}

export function readsOf(reads: string[], canonicalFile: string): number {
  return reads.filter((p) => p === canonicalFile).length;
}

/** Probe the filesystem's case sensitivity (explicit policy in tests). */
export function probeCaseSensitivity(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-case-probe-"));
  const probe = path.join(dir, "probe-file");
  fs.writeFileSync(probe, "x");
  const caseSensitive = !fs.existsSync(path.join(dir, "PROBE-FILE"));
  fs.rmSync(dir, { recursive: true, force: true });
  return caseSensitive;
}
