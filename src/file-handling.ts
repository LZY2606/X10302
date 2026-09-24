import * as fs from "node:fs";
import * as path from "node:path";

import type { Options } from "./config.ts";
import { EtaFileResolutionError } from "./err.ts";
import type { Eta as EtaCore } from "./internal.ts";

export function readFile(this: EtaCore, path: string): string {
  let res = "";

  try {
    res = fs.readFileSync(path, "utf8");
    // biome-ignore lint/suspicious/noExplicitAny: it's an error
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new EtaFileResolutionError(`Could not find template: ${path}`);
    } else {
      throw err;
    }
  }

  return res;
}

/**
 * Computes the canonical cache identity of a filesystem path.
 *
 * The identity is absolute, normalized (`.`, `..`, duplicate separators and
 * mixed `/` vs `\` spellings are collapsed by `path.resolve`) and has symbolic
 * links resolved, so a symlink and its target — including symlinked views
 * roots like macOS's `/tmp` -> `/private/tmp` — share a single identity.
 *
 * Case policy (explicit): the identity preserves the casing it is given, like
 * Node's own module cache. On case-sensitive filesystems a mismatched casing
 * simply does not resolve; on case-insensitive filesystems each casing gets
 * its own cache entry. Both entries serve the same file, so this is never a
 * correctness hazard, only a potential duplicate entry.
 *
 * When the path does not exist (yet), the normalized absolute path is used so
 * missing templates still fail through the normal `readFile` error path.
 *
 * Results are memoized per Eta instance: like `config.cacheFilepaths`, this
 * assumes the filesystem layout does not change underneath a live instance.
 */
function canonicalizePath(this: EtaCore, filePath: string): string {
  const cached = this.canonicalPathCache[filePath];
  if (cached !== undefined) return cached;

  const absolutePath = path.resolve(filePath);
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(absolutePath);
  } catch {
    canonicalPath = absolutePath;
  }

  this.canonicalPathCache[filePath] = canonicalPath;
  return canonicalPath;
}

export function resolvePath(
  this: EtaCore,
  templatePath: string,
  options?: Partial<Options>,
): string {
  const configuredViews = this.config.views;

  if (!configuredViews) {
    throw new EtaFileResolutionError("Views directory is not defined");
  }

  // Canonical identity of the views root: absolute and symlink-free, so the
  // same directory always produces the same cache keys however it is spelled.
  const views = canonicalizePath.call(this, configuredViews);

  const baseFilePath = options?.filepath;
  const defaultExtension =
    this.config.defaultExtension === undefined
      ? ".eta"
      : this.config.defaultExtension;

  // The includer's canonical path is part of the cache identity, so includes
  // from the same template resolve identically regardless of how the
  // includer's own path was spelled (symlinks, `.` segments, casing, ...).
  const includerPath = baseFilePath
    ? canonicalizePath.call(this, baseFilePath)
    : undefined;

  // How we index cached template paths. Every input that can change the
  // resolution result — includer, include path, views root and default
  // extension — is part of the key, so a configuration change produces a new
  // cache identity instead of polluting entries written under the old config.
  const cacheIndex = JSON.stringify({
    filename: includerPath, // canonical filename of the template which called include()
    path: templatePath,
    views: views,
    ext: defaultExtension,
  });

  templatePath += path.extname(templatePath) ? "" : defaultExtension;

  let resolvedFilePath = "";

  // if the file was included from another template
  if (baseFilePath) {
    // check the cache

    if (this.config.cacheFilepaths && this.filepathCache[cacheIndex]) {
      return this.filepathCache[cacheIndex];
    }

    const absolutePathTest = absolutePathRegExp.exec(templatePath);

    if (absolutePathTest?.length) {
      const formattedPath = templatePath.replace(/^\/*|^\\*/, "");
      resolvedFilePath = path.join(views, formattedPath);
    } else {
      resolvedFilePath = path.join(
        path.dirname(includerPath as string),
        templatePath,
      );
    }
  } else {
    resolvedFilePath = path.join(views, templatePath);
  }

  // Canonical identity of the template file itself. This collapses symlinked
  // views roots, symlinks inside the views directory and different spellings
  // of the same file into one cache key, while still distinguishing files
  // that merely share a name under different roots.
  const canonicalFilePath = canonicalizePath.call(this, resolvedFilePath);

  // Containment is checked against the canonical path, so path traversal and
  // symlinks that would escape the configured views root are both rejected.
  if (dirIsChild(views, canonicalFilePath)) {
    // add resolved path to the cache
    if (baseFilePath && this.config.cacheFilepaths) {
      this.filepathCache[cacheIndex] = canonicalFilePath;
    }

    return canonicalFilePath;
  } else {
    throw new EtaFileResolutionError(
      `Template '${templatePath}' is not in the views directory`,
    );
  }
}

function dirIsChild(parent: string, dir: string) {
  const relative = path.relative(parent, dir);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const absolutePathRegExp = /^\\|^\//;
