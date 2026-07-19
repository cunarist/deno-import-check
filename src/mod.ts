/**
 * A CLI that finds circular dependencies in a Deno module graph.
 *
 * It reads `deno info --json` for the entry points you pass, merges them into
 * one graph, and runs two checks. It walks the graph depth first and prints
 * every cycle it finds as a path, then compares the `#` entries declared in
 * `deno.json` against the specifiers the graph actually imports and prints the
 * ones nothing reaches. Only local modules are traversed, so remote and JSR
 * dependencies are ignored.
 *
 * Pass every root the project has. An alias imported only by files outside the
 * graph is reported as unused, so leaving the tests out produces noise.
 *
 * The process exits with code 0 when both checks pass and 1 when either does
 * not, which makes it usable directly in CI or a pre-commit hook.
 *
 * @module
 */

import { findImportsConfig } from "./imports.ts";
import { normalizePath, resolveFrom, toRelativePath } from "./paths.ts";

interface Dependency {
  specifier: string;
  code?: {
    specifier: string;
  };
  type?: {
    specifier: string;
  };
}

interface Module {
  kind?: string;
  local?: string;
  specifier: string;
  dependencies?: Dependency[];
}

interface DenoInfoJson {
  modules: Module[];
}

/**
 * The main function that finds circular dependencies
 * in the given Deno info JSON.
 */
function findCycles(info: DenoInfoJson): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const moduleMap = new Map<string, Module>();
  for (const module of info.modules) {
    if (module.local) {
      const normalizedPath = normalizePath(module.local);
      moduleMap.set(normalizedPath, module);
      const normalizedSpecifier = normalizePath(module.specifier);
      moduleMap.set(normalizedSpecifier, module);
    }
  }

  function dfs(moduleSpecifier: string, path: string[]): void {
    const normalizedSpecifier = normalizePath(moduleSpecifier);

    if (recursionStack.has(normalizedSpecifier)) {
      const cycleStart = path.indexOf(normalizedSpecifier);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }

    if (visited.has(normalizedSpecifier)) {
      return;
    }

    visited.add(normalizedSpecifier);
    recursionStack.add(normalizedSpecifier);

    const module = moduleMap.get(normalizedSpecifier);
    if (module?.dependencies) {
      for (const dep of module.dependencies) {
        const targets: string[] = [];

        if (dep.code?.specifier) {
          targets.push(dep.code.specifier);
        }
        if (dep.type?.specifier) {
          targets.push(dep.type.specifier);
        }

        for (const target of targets) {
          const normalizedTarget = normalizePath(target);
          if (moduleMap.has(normalizedTarget)) {
            dfs(target, [...path, normalizedTarget]);
          }
        }
      }
    }

    recursionStack.delete(normalizedSpecifier);
  }

  for (const module of info.modules) {
    if (module.local) {
      const normalizedPath = normalizePath(module.local);
      if (!visited.has(normalizedPath)) {
        dfs(module.specifier, [normalizedPath]);
      }
    }
  }

  return cycles;
}

/** Runs `deno info --json` for one entry point. */
async function readGraph(file: string): Promise<DenoInfoJson> {
  const cmd = new Deno.Command("deno", {
    args: ["info", file, "--json"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(1);
  }
  return JSON.parse(new TextDecoder().decode(stdout));
}

/**
 * Collects every `#` specifier as it was written in source. `deno info`
 * reports the raw text alongside the resolved path, so an alias can be
 * matched against the `imports` map without re-parsing any file.
 */
function usedAliases(info: DenoInfoJson): Set<string> {
  const used = new Set<string>();
  for (const module of info.modules) {
    for (const dependency of module.dependencies ?? []) {
      if (dependency.specifier.startsWith("#")) {
        used.add(dependency.specifier);
      }
    }
  }
  return used;
}

/**
 * Reports `#` entries that no module in the graph imports. An exact entry
 * counts as used only when written exactly, while a trailing-slash entry
 * counts as used by any specifier that begins with it.
 */
function findUnusedAliases(fromFile: string, used: Set<string>): string[] {
  const config = findImportsConfig(fromFile);
  if (config === null) {
    return [];
  }

  const unused: string[] = [];
  for (const entry of config.entries) {
    if (!used.has(entry.specifier)) {
      unused.push(entry.specifier);
    }
  }
  for (const prefix of config.prefixes) {
    const reached = [...used].some((specifier) =>
      specifier.startsWith(prefix.specifier)
    );
    if (!reached) {
      unused.push(prefix.specifier);
    }
  }
  return unused;
}

async function main() {
  const files = Deno.args;
  if (files.length === 0) {
    console.error("Error: Pass at least one entry point");
    Deno.exit(1);
  }
  for (const file of files) {
    try {
      await Deno.stat(file);
    } catch {
      console.error(
        `Error: File '${file}' does not exist or is not accessible`,
      );
      Deno.exit(1);
    }
  }

  // Every entry point contributes to one graph, so a module reachable from
  // the tests but not from the app still counts as reached.
  const modules = new Map<string, Module>();
  for (const file of files) {
    for (const module of (await readGraph(file)).modules) {
      modules.set(module.specifier, module);
    }
  }
  const json: DenoInfoJson = { modules: [...modules.values()] };

  const localModulesCount = json.modules.filter((m) => m.local).length;
  console.log(`\u{1f4e6} ${json.modules.length} modules`);
  console.log(`\u{1f4c1} ${localModulesCount} local modules`);

  let failed = false;

  const cycles = findCycles(json);
  if (cycles.length === 0) {
    console.log("\u{2705} No circular dependencies found");
  } else {
    const currentDir = normalizePath(Deno.cwd());
    console.log(`\u{1f6a8} ${cycles.length} circular dependencies detected`);
    for (const cycle of cycles) {
      const relativeCycle = cycle.map((c) => toRelativePath(c, currentDir));
      const dimmedCycle = relativeCycle.map((c) => `\x1b[2m${c}\x1b[22m`);
      console.log("\u{25a0} " + dimmedCycle.join(" \u{25b6} "));
    }
    failed = true;
  }

  // The config is found by walking up from a file, so the entry point has to
  // be absolute. A bare "src/mod.ts" would walk up from "src" and stop.
  const entryPath = resolveFrom(normalizePath(Deno.cwd()), files[0]);
  const unused = findUnusedAliases(entryPath, usedAliases(json));
  if (unused.length === 0) {
    console.log('\u{2705} Every "#" internal import alias is used');
  } else {
    const plural = unused.length === 1 ? "alias" : "aliases";
    console.log(
      `\u{1f6a8} ${unused.length} unused "#" internal import ${plural} in deno.json`,
    );
    for (const specifier of unused) {
      console.log(`\u{25a0} \x1b[2m${specifier}\x1b[22m`);
    }
    failed = true;
  }

  if (failed) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
