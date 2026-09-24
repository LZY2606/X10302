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
  const views = this.config.views;

  if (!views) {
    throw new EtaFileResolutionError("Views directory is not defined");
  }

  const baseFilePath = options?.filepath;
  const defaultExtension =
    this.config.defaultExtension === undefined
      ? ".eta"
      : this.config.defaultExtension;

  // Normalize the views root so equivalent spellings (e.g. "views", "views/",
  // "./views") produce the same cache identity.
  const viewsRoot = path.resolve(views);

  // How we index cached template paths. The key captures every input that
  // influences resolution: the includer filename, the raw template path as
  // written, the views root, and the default extension. Changing any of them
  // (e.g. via `configure()`) produces a new identity instead of polluting
  // entries created under the old configuration.
  const cacheIndex = JSON.stringify({
    filename: baseFilePath, // filename of the template which called includeFile()
    path: templatePath,
    views: viewsRoot,
    extension: defaultExtension,
  });

  if (this.config.cacheFilepaths && this.filepathCache[cacheIndex]) {
    return this.filepathCache[cacheIndex];
  }

  templatePath += path.extname(templatePath) ? "" : defaultExtension;

  let resolvedFilePath = "";

  // A leading "/" or "\" always means "relative to the views root", on every
  // platform. Other separators are platform-native: "/" works everywhere,
  // while "\" is a separator only on Windows (on POSIX it is a valid
  // filename character).
  if (baseFilePath && !absolutePathRegExp.test(templatePath)) {
    // the template was included from another template using a relative path:
    // resolve it against the includer's directory
    resolvedFilePath = path.resolve(path.dirname(baseFilePath), templatePath);
  } else {
    const rootRelativePath = templatePath.replace(/^[\\/]+/, "");
    resolvedFilePath = path.resolve(viewsRoot, rootRelativePath);
  }

  // Canonicalize the identity: follow symlinks and adopt on-disk letter
  // casing, so the same file always maps to a single cache identity
  // (including on case-insensitive filesystems) and different files never
  // share one. The containment check runs against the *real* paths, so
  // symlinks are allowed only while their target stays inside the real
  // views root.
  const realViewsRoot = realpathSafe(viewsRoot) ?? viewsRoot;
  const realFilePath = realpathSafe(resolvedFilePath);

  if (realFilePath !== null) {
    if (!dirIsChild(realViewsRoot, realFilePath)) {
      throw new EtaFileResolutionError(
        `Template '${templatePath}' is not in the views directory`,
      );
    }

    // add resolved path to the cache
    if (this.config.cacheFilepaths) {
      this.filepathCache[cacheIndex] = realFilePath;
    }

    return realFilePath;
  }

  // The file does not exist (yet). Fall back to a textual containment check
  // and let `readFile` raise the not-found error. Nothing is cached here, so
  // a failed load leaves no stale identity behind and an identical retry
  // after the file appears resolves cleanly.
  if (dirIsChild(viewsRoot, resolvedFilePath)) {
    return resolvedFilePath;
  }

  throw new EtaFileResolutionError(
    `Template '${templatePath}' is not in the views directory`,
  );
}

function realpathSafe(path: string): string | null {
  try {
    return fs.realpathSync(path);
  } catch {
    return null;
  }
}

function dirIsChild(parent: string, dir: string) {
  const relative = path.relative(parent, dir);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const absolutePathRegExp = /^\\|^\//;
