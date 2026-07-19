/**
 * A `deno lint` plugin whose rules keep a module graph acyclic and layered.
 *
 * A lint plugin only ever sees one file's syntax tree, so it cannot follow
 * imports and cannot detect a cycle on its own. Instead these rules forbid the
 * import patterns that create cycles in the first place, reporting them in the
 * editor.
 */

import {
  findImportsConfig,
  findOwningEntry,
  findPrefixEntry,
  type ImportsConfig,
  type ModuleEntry,
} from "./imports.ts";
import { normalizePath, parentDir, resolveFrom } from "./paths.ts";

/**
 * Every AST node that carries a module specifier,
 * covering static imports, re-exports, and dynamic imports.
 */
type SourceBearingNode =
  | Deno.lint.ImportDeclaration
  | Deno.lint.ExportNamedDeclaration
  | Deno.lint.ExportAllDeclaration
  | Deno.lint.ImportExpression;

/**
 * Builds a visitor that runs `check` for every module specifier in a file,
 * so each rule only describes what to do with one specifier.
 */
function visitSpecifiers(
  check: (node: Deno.lint.StringLiteral, specifier: string) => void,
): Deno.lint.LintVisitor {
  const handle = (node: SourceBearingNode) => {
    const source = node.source;
    // Dynamic imports accept any expression, and a re-export without a
    // specifier has none at all. Only literal strings are analyzable.
    if (source === null || source.type !== "Literal") {
      return;
    }
    if (typeof source.value !== "string") {
      return;
    }
    check(source, source.value);
  };

  return {
    ImportDeclaration: handle,
    ExportNamedDeclaration: handle,
    ExportAllDeclaration: handle,
    ImportExpression: handle,
  };
}

/**
 * Rewrites a specifier while keeping the original quote character.
 */
function quoteLike(
  original: Deno.lint.StringLiteral,
  specifier: string,
): string {
  const quote = original.raw.startsWith("'") ? "'" : '"';
  return quote + specifier + quote;
}

/**
 * Resolves the module a `#` specifier belongs to, whether it is an exact
 * entry such as `#utils` or a deep one such as `#utils/internal.ts`.
 */
function targetModule(
  config: ImportsConfig,
  specifier: string,
): ModuleEntry | null {
  const exact = config.bySpecifier.get(specifier);
  if (exact !== undefined) {
    return exact;
  }
  const prefix = findPrefixEntry(config, specifier);
  if (prefix === null) {
    return null;
  }
  return config.bySpecifier.get(prefix.specifier.slice(0, -1)) ?? null;
}

const noParentImport: Deno.lint.Rule = {
  create(ctx) {
    return visitSpecifiers((node, specifier) => {
      if (!specifier.startsWith("../")) {
        return;
      }

      const config = findImportsConfig(ctx.filename);
      const resolved = resolveFrom(
        parentDir(normalizePath(ctx.filename)),
        specifier,
      );
      const entry = config?.byTarget.get(resolved);

      if (entry === undefined) {
        ctx.report({
          node,
          message:
            "Parent relative imports are not allowed. Import through a package export instead.",
          hint:
            `No "#" entry in deno.json points at "${resolved}". Add one, or move the shared code into a module that already has an entry.`,
        });
        return;
      }

      ctx.report({
        node,
        message:
          `Parent relative imports are not allowed. Use "${entry.specifier}" instead.`,
        fix(fixer) {
          return fixer.replaceText(node, quoteLike(node, entry.specifier));
        },
      });
    });
  },
};

const noBarrelBypass: Deno.lint.Rule = {
  create(ctx) {
    return visitSpecifiers((node, specifier) => {
      if (!specifier.startsWith("#")) {
        return;
      }

      const config = findImportsConfig(ctx.filename);
      if (config === null || config.bySpecifier.has(specifier)) {
        return;
      }

      const prefix = findPrefixEntry(config, specifier);
      if (prefix === null) {
        return;
      }

      const owner = config.bySpecifier.get(prefix.specifier.slice(0, -1));
      const suggestion = owner === undefined
        ? "the module's entry point"
        : `"${owner.specifier}"`;

      ctx.report({
        node,
        message:
          `"${specifier}" reaches into module internals. Import from ${suggestion} instead.`,
        hint:
          "Whatever this file needs should be re-exported from the module's entry point, so the module keeps one public surface.",
      });
    });
  },
};

const enforceLayerOrder: Deno.lint.Rule = {
  create(ctx) {
    return visitSpecifiers((node, specifier) => {
      if (!specifier.startsWith("#")) {
        return;
      }

      const config = findImportsConfig(ctx.filename);
      if (config === null) {
        return;
      }

      const owner = findOwningEntry(config, ctx.filename);
      const target = targetModule(config, specifier);
      if (owner === null || target === null) {
        return;
      }

      if (target.index === owner.index) {
        ctx.report({
          node,
          message:
            `"${owner.specifier}" must not import itself. Use a same-folder relative import instead.`,
          hint:
            "Importing your own entry point from inside the module is a circular import waiting to happen.",
        });
        return;
      }

      if (target.index > owner.index) {
        ctx.report({
          node,
          message:
            `"${owner.specifier}" must not import "${target.specifier}", which is declared after it in deno.json.`,
          hint:
            `A module may only import modules declared before it. Either move "${target.specifier}" above "${owner.specifier}" in the deno.json imports, or move the shared code down into a lower module.`,
        });
      }
    });
  },
};

/**
 * Lint rules that keep a Deno module graph acyclic and layered,
 * complementing the circular dependency CLI in this package.
 *
 * Enable it in `deno.json`:
 *
 * ```json
 * {
 *   "lint": {
 *     "plugins": ["jsr:@cunarist/deno-dependency-check/lint"]
 *   }
 * }
 * ```
 */
const plugin: Deno.lint.Plugin = {
  name: "dependency-check",
  rules: {
    "no-parent-import": noParentImport,
    "no-barrel-bypass": noBarrelBypass,
    "enforce-layer-order": enforceLayerOrder,
  },
};

export default plugin;
