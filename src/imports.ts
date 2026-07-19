import {
  isInsideDir,
  normalizePath,
  parentDir,
  resolveFrom,
  stemName,
} from "./paths.ts";

/**
 * File name stems that mark a directory's public entry point. Compared
 * without the extension so ".ts", ".tsx", ".js" and friends all count.
 */
export const BARREL_STEMS = ["mod", "index"];

/**
 * Barrel stems the `enforce-mod-file` rule rejects. They stay in
 * {@linkcode BARREL_STEMS} so a project that turns that rule off still has
 * its entry points recognized.
 */
export const INDEX_STEMS = ["index"];

/** Config file names searched for, in priority order. */
const CONFIG_NAMES = ["deno.json", "deno.jsonc"];

/**
 * A single `#`-prefixed entry of the `imports` map in `deno.json`.
 */
export interface ModuleEntry {
  /** The bare specifier, such as `#utils`. */
  specifier: string;
  /** Normalized absolute path the specifier resolves to. */
  target: string;
  /**
   * The directory this module owns. For a barrel such as
   * `./src/utils/mod.ts` this is `./src/utils`, meaning every file below it
   * belongs to the module. For a plain file entry it equals `target`,
   * so the module owns nothing but itself.
   */
  dir: string;
  /** Whether {@linkcode target} is a barrel file rather than a plain module. */
  isBarrel: boolean;
  /** Declaration order in `deno.json`, which defines the layer order. */
  index: number;
}

/**
 * A `#`-prefixed entry ending with a slash, such as `#utils/`,
 * which lets importers reach files inside a module directly.
 */
export interface PrefixEntry {
  /** The prefix specifier including its trailing slash, such as `#utils/`. */
  specifier: string;
  /** Normalized absolute directory the prefix resolves to. */
  target: string;
}

/**
 * The `#`-prefixed portion of a resolved `deno.json` import map.
 */
export interface ImportsConfig {
  /** Normalized absolute path of the config file. */
  configPath: string;
  /** Normalized absolute directory containing the config file. */
  configDir: string;
  /** Exact `#` entries in declaration order. */
  entries: ModuleEntry[];
  /** Lookup from a normalized absolute path to the entry pointing at it. */
  byTarget: Map<string, ModuleEntry>;
  /** Lookup from a bare specifier such as `#utils` to its entry. */
  bySpecifier: Map<string, ModuleEntry>;
  /** Trailing-slash entries, longest specifier first. */
  prefixes: PrefixEntry[];
}

/**
 * Memoizes config lookups per directory. A lint run is short lived, so a
 * config edited mid-run is not picked up until the next run.
 */
const configCache = new Map<string, ImportsConfig | null>();

/**
 * Walks up from a file to find the nearest `deno.json` or `deno.jsonc`
 * and reads its `#`-prefixed imports. Returns `null` when no config exists,
 * when it cannot be read, or when it declares no `#` entries.
 */
export function findImportsConfig(fromFile: string): ImportsConfig | null {
  let dir = parentDir(normalizePath(fromFile));
  const visited: string[] = [];

  while (true) {
    const cached = configCache.get(dir);
    if (cached !== undefined) {
      for (const seen of visited) {
        configCache.set(seen, cached);
      }
      return cached;
    }
    visited.push(dir);

    for (const name of CONFIG_NAMES) {
      const configPath = dir + "/" + name;
      const config = readConfig(configPath, dir);
      if (config !== null) {
        for (const seen of visited) {
          configCache.set(seen, config);
        }
        return config;
      }
    }

    const parent = parentDir(dir);
    if (parent === dir) {
      for (const seen of visited) {
        configCache.set(seen, null);
      }
      return null;
    }
    dir = parent;
  }
}

/**
 * Parses a config file that may use JSONC syntax.
 *
 * This is hand rolled rather than delegating to `@std/jsonc` on purpose.
 * A lint plugin's own imports resolve against the *consuming* project's
 * import map, so any dependency here breaks every project that loads the
 * plugin from a local path instead of JSR.
 */
export function parseConfigText(text: string): unknown {
  let result = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index];

    if (inString) {
      result += char;
      if (char === "\\") {
        result += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      index += 1;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    result += char;
    index += 1;
  }

  // Drop trailing commas, which JSONC allows but JSON.parse rejects.
  return JSON.parse(result.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Reads and parses one candidate config file.
 * Returns `null` when the file is absent, unreadable, or has no `#` entries.
 */
function readConfig(
  configPath: string,
  configDir: string,
): ImportsConfig | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(configPath);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseConfigText(text);
  } catch {
    return null;
  }

  const imports = (parsed as { imports?: unknown } | null)?.imports;
  if (typeof imports !== "object" || imports === null) {
    return null;
  }

  const entries: ModuleEntry[] = [];
  const byTarget = new Map<string, ModuleEntry>();
  const bySpecifier = new Map<string, ModuleEntry>();
  const prefixes: PrefixEntry[] = [];

  for (const [specifier, value] of Object.entries(imports)) {
    if (!specifier.startsWith("#") || typeof value !== "string") {
      continue;
    }
    // Only relative targets point at local files. A "#" alias for a
    // jsr:/npm: package is legitimate but irrelevant to these rules.
    if (!value.startsWith("./") && !value.startsWith("../")) {
      continue;
    }
    const target = resolveFrom(configDir, value);

    if (specifier.endsWith("/")) {
      prefixes.push({
        specifier,
        target: target.endsWith("/") ? target : target + "/",
      });
      continue;
    }

    const isBarrel = BARREL_STEMS.includes(stemName(target));
    const entry: ModuleEntry = {
      specifier,
      target,
      dir: isBarrel ? parentDir(target) : target,
      isBarrel,
      index: entries.length,
    };
    entries.push(entry);
    bySpecifier.set(specifier, entry);
    // First declaration wins when two specifiers share a target.
    if (!byTarget.has(target)) {
      byTarget.set(target, entry);
    }
  }

  if (entries.length === 0 && prefixes.length === 0) {
    return null;
  }

  prefixes.sort((a, b) => b.specifier.length - a.specifier.length);

  return { configPath, configDir, entries, byTarget, bySpecifier, prefixes };
}

/**
 * Finds the module that owns a file, which is the entry with the most
 * specific directory containing it. Returns `null` for files outside
 * every declared module, such as scripts or config files.
 */
export function findOwningEntry(
  config: ImportsConfig,
  filePath: string,
): ModuleEntry | null {
  const path = normalizePath(filePath);
  let best: ModuleEntry | null = null;

  for (const entry of config.entries) {
    const owns = entry.target === path ||
      (entry.isBarrel && isInsideDir(path, entry.dir));
    if (!owns) {
      continue;
    }
    if (best === null || entry.dir.length > best.dir.length) {
      best = entry;
    }
  }

  return best;
}

/**
 * Finds the trailing-slash entry a deep `#` specifier reaches through,
 * such as `#utils/` for `#utils/internal.ts`. Returns `null` when none match.
 */
export function findPrefixEntry(
  config: ImportsConfig,
  specifier: string,
): PrefixEntry | null {
  for (const prefix of config.prefixes) {
    if (specifier.startsWith(prefix.specifier)) {
      return prefix;
    }
  }
  return null;
}
