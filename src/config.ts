import type { AstObject } from "./parse.ts";
import { XMLEscape } from "./utils.ts";

type trimConfig = "nl" | "slurp" | false;

export interface Options {
  /** Compile to async function */
  async?: boolean;

  /** Absolute path to template file */
  filepath?: string;
}

export interface EtaConfig {
  /** Whether or not to automatically XML-escape interpolations. Default true */
  autoEscape: boolean;

  /** Apply a filter function defined on the class to every interpolation or raw interpolation */
  autoFilter: boolean;

  /** Configure automatic whitespace trimming. Default `[false, 'nl']` */
  autoTrim: trimConfig | [trimConfig, trimConfig];

  /** Whether or not to cache templates if `name` or `filename` is passed */
  cache: boolean;

  /** Holds cache of resolved filepaths. Set to `false` to disable.
   * Keys include the includer's canonical path, the include path, the
   * canonical views root and the default extension, so changing `views` or
   * `defaultExtension` creates new cache identities instead of polluting
   * entries written under the previous configuration. */
  cacheFilepaths: boolean;

  /** Object specifying custom tags. Keys are tag prefixes, values are functions which take tag content and return a string. */
  customTags: Record<string, (content: string, data: unknown) => string>;

  /** Whether to pretty-format error messages (introduces runtime penalties) */
  debug: boolean;

  /** Function to XML-sanitize interpolations */
  escapeFunction: (str: unknown) => string;

  /** Function applied to all interpolations when autoFilter is true */
  filterFunction: (val: unknown) => string;

  /** Name of the function that can be used in template code to output text to the result (like EJS's `outputFunctionName`). */
  outputFunctionName: string;

  /** Raw JS code inserted in the template function. Useful for declaring global variables for user templates */
  functionHeader: string;

  /** Parsing options */
  parse: {
    /** Which prefix to use for evaluation. Default `""`, does not support `"-"` or `"_"` */
    exec: string;

    /** Which prefix to use for interpolation. Default `"="`, does not support `"-"` or `"_"` */
    interpolate: string;

    /** Which prefix to use for raw interpolation. Default `"~"`, does not support `"-"` or `"_"` */
    raw: string;
  };

  /** Array of plugins */
  plugins: Array<{
    processFnString?: (fnString: string, env?: EtaConfig) => string;
    processAST?: (ast: AstObject[], env?: EtaConfig) => AstObject[];
    processTemplate?: (fnString: string, env?: EtaConfig) => string;
  }>;

  /** Remove empty lines and whitespace between lines */
  rmWhitespace: boolean;

  /** Delimiters: by default `['<%', '%>']` */
  tags: [string, string];

  /** Make data available on the global object instead of varName */
  useWith: boolean;

  /** Name of the data object. Default `it` */
  varName: string;

  /** Directory that contains templates.
   * Template paths are resolved to a canonical identity (absolute, symlinks
   * resolved) confined to this directory: names that escape the root — via
   * `..` segments or symlinks pointing outside — are rejected with an
   * `EtaFileResolutionError`. Template names use `/` as separator; a leading
   * `/` or `\` makes the name relative to the views root. Cache identities
   * preserve casing (like Node's module cache): on case-sensitive filesystems
   * a wrong casing does not resolve, on case-insensitive filesystems each
   * casing gets its own entry. */
  views?: string;

  /** Control template file extension defaults. Default `.eta`. Part of the
   * filepath cache identity, so switching it never reuses stale resolutions. */
  defaultExtension?: string;
}

/* END TYPES */

/** Eta's base (global) configuration */
const defaultConfig: EtaConfig = {
  autoEscape: true,
  autoFilter: false,
  autoTrim: [false, "nl"],
  cache: false,
  cacheFilepaths: true,
  customTags: {},
  debug: false,
  escapeFunction: XMLEscape,
  // default filter function (not used unless enables) just stringifies the input
  filterFunction: (val) => String(val),
  outputFunctionName: "output",
  functionHeader: "",
  parse: {
    exec: "",
    interpolate: "=",
    raw: "~",
  },
  plugins: [],
  rmWhitespace: false,
  tags: ["<%", "%>"],
  useWith: false,
  varName: "it",
  defaultExtension: ".eta",
};

export { defaultConfig };
