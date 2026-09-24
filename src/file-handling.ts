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

export function resolvePath(
  this: EtaCore,
  templatePath: string,
  options?: Partial<Options>,
): string {
  const config = this.config;

  if (!config.views) {
    throw new EtaFileResolutionError("Views directory is not defined");
  }

  // Normalize the views root to an absolute path so that the resolved
  // identity does not depend on the process cwd or on how the root was spelled.
  const views = path.resolve(config.views);

  // Canonical views root (symlinks and on-disk casing resolved). All
  // resolution happens in this space so that an includer's canonical path
  // and the configured root are always comparable. Falls back to the lexical
  // root when the views directory does not exist (yet).
  const realViews = tryRealpath(views) ?? views;

  // The including template's own path, canonicalized the same way so that
  // relative includes resolve inside the same space as the views root.
  const baseFilePath = options?.filepath
    ? (tryRealpath(path.resolve(options.filepath)) ??
      path.resolve(options.filepath))
    : undefined;

  const defaultExtension =
    config.defaultExtension === undefined ? ".eta" : config.defaultExtension;

  // How we index cached template paths. Every config value that can change
  // the resolution result is part of the key, so a config change (e.g. a new
  // `views` root or `defaultExtension`) produces a new identity instead of
  // polluting entries created under the old config.
  const cacheIndex = JSON.stringify({
    filename: baseFilePath, // filename of the template which called includeFile()
    path: templatePath,
    views,
    ext: defaultExtension,
  });

  if (config.cacheFilepaths && this.filepathCache[cacheIndex]) {
    return this.filepathCache[cacheIndex];
  }

  // Template names accept both POSIX and Windows separators; both are
  // normalized so that `sub/tpl` and `sub\tpl` denote the same template.
  let normalizedName = templatePath.replace(/\\/g, "/");

  if (!path.posix.extname(normalizedName)) normalizedName += defaultExtension;

  let resolvedFilePath = "";

  // A leading separator means "relative to the views root", matching Eta's
  // historical treatment of absolute-looking template names. Otherwise, a
  // template included from another template resolves relative to the
  // including file's directory.
  if (baseFilePath && !normalizedName.startsWith("/")) {
    resolvedFilePath = path.join(path.dirname(baseFilePath), normalizedName);
  } else {
    resolvedFilePath = path.join(realViews, normalizedName.replace(/^\/+/, ""));
  }

  // Lexical containment: reject `..` traversal outside the views root. Both
  // the configured and the canonical root are accepted here; the canonical
  // check below is the authoritative boundary for files that exist.
  if (
    !dirIsChild(views, resolvedFilePath) &&
    !dirIsChild(realViews, resolvedFilePath)
  ) {
    throw new EtaFileResolutionError(
      `Template '${templatePath}' is not in the views directory`,
    );
  }

  // Canonical identity: resolve symlinks and on-disk casing so that the same
  // file always maps to a single cache key, no matter how its path was
  // spelled. On case-sensitive filesystems different casing stays distinct;
  // on case-insensitive filesystems (macOS, Windows) casing variants unify.
  const canonicalPath = tryRealpath(resolvedFilePath);

  if (canonicalPath === null) {
    // The file does not exist (yet). Return the lexical path so readFile can
    // raise the standard resolution error, and cache nothing: a failed lookup
    // leaves no state behind and the same input can be retried later.
    return resolvedFilePath;
  }

  // Real containment: a symlink inside the views root may not escape it.
  if (!dirIsChild(realViews, canonicalPath)) {
    throw new EtaFileResolutionError(
      `Template '${templatePath}' is not in the views directory`,
    );
  }

  // Only successful, canonical resolutions are cached.
  if (config.cacheFilepaths) {
    this.filepathCache[cacheIndex] = canonicalPath;
  }

  return canonicalPath;
}

function dirIsChild(parent: string, dir: string) {
  const relative = path.relative(parent, dir);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}
