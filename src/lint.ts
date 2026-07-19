/**
 * A `deno lint` plugin whose rules keep a module graph acyclic and layered.
 *
 * A lint plugin only ever sees one file's syntax tree, so it cannot follow
 * imports and cannot detect a cycle on its own. Instead these rules forbid the
 * import patterns that create cycles in the first place, reporting them in the
 * editor.
 *
 * @module
 */

import {
  BARREL_STEMS,
  findImportsConfig,
  findOwningEntry,
  findPrefixEntry,
  type ImportsConfig,
  INDEX_STEMS,
  type ModuleEntry,
} from "./imports.ts";
import { normalizePath, parentDir, resolveFrom, stemName } from "./paths.ts";

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

      if (target.index < owner.index) {
        ctx.report({
          node,
          message:
            `"${owner.specifier}" must not import "${target.specifier}", which is declared above it in deno.json.`,
          hint:
            `A module may only import modules declared below it. Either move "${target.specifier}" below "${owner.specifier}" in the deno.json imports, or move the shared code into a module declared below both.`,
        });
      }
    });
  },
};

const enforceModFile: Deno.lint.Rule = {
  create(ctx) {
    const specifiers = visitSpecifiers((node, specifier) => {
      // Only paths this project controls. A package may ship whatever
      // file names it likes.
      if (!specifier.startsWith(".") && !specifier.startsWith("#")) {
        return;
      }
      if (!INDEX_STEMS.includes(stemName(specifier))) {
        return;
      }
      ctx.report({
        node,
        message: `"${specifier}" points at an index file.`,
        hint:
          'Module entry points are named "mod.ts" here. Rename the target and update this specifier.',
      });
    });

    return {
      ...specifiers,
      Program(node) {
        if (!INDEX_STEMS.includes(stemName(normalizePath(ctx.filename)))) {
          return;
        }
        ctx.report({
          node,
          message: 'A module entry point must be named "mod.ts".',
          hint:
            'Deno projects use "mod.ts" rather than the Node convention. One name everywhere means a module\'s entry point is never ambiguous.',
        });
      },
    };
  },
};

const noRelativeBypass: Deno.lint.Rule = {
  create(ctx) {
    return visitSpecifiers((node, specifier) => {
      // Parent imports belong to "no-parent-import", and bare or "#"
      // specifiers never walk the file tree.
      if (!specifier.startsWith("./")) {
        return;
      }

      const segments = specifier.slice(2).split("/").filter(
        (segment) => segment !== "" && segment !== ".",
      );
      // A single segment is a sibling file, which is always fine.
      if (segments.length < 2) {
        return;
      }
      if (
        segments.length === 2 && BARREL_STEMS.includes(stemName(segments[1]))
      ) {
        return;
      }

      ctx.report({
        node,
        message: `"${specifier}" reaches past the entry point of "./${
          segments[0]
        }".`,
        hint:
          `A relative import may descend one level at most, into that folder's entry point. Import "./${
            segments[0]
          }/mod.ts" and re-export whatever this file needs from there.`,
      });
    });
  },
};

/** The three import groups, in the order they must appear. */
const IMPORT_GROUPS = ["package", '"#" alias', "relative"];

/**
 * Classifies a specifier into its {@linkcode IMPORT_GROUPS} index. Anything
 * that is neither a `#` alias nor a path is a package, which covers bare
 * names, `jsr:`, `npm:`, `node:` and remote URLs alike.
 */
function importGroup(specifier: string): number {
  if (specifier.startsWith("#")) {
    return 1;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return 2;
  }
  return 0;
}

/**
 * Orders specifiers by code point rather than locale, so the result does not
 * depend on collation rules that quietly ignore punctuation.
 */
function compareSpecifiers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders imported names case insensitively, unlike {@linkcode
 * compareSpecifiers}. Specifiers are lowercase paths where only punctuation is
 * ambiguous, but a member list mixes `PascalCase` types, `camelCase` functions
 * and `SCREAMING_CASE` constants. Sorting those by code point would clump them
 * by case, which hides the alphabetical order a reader is scanning for.
 */
function compareMembers(a: string, b: string): number {
  const lowered = a.toLowerCase() < b.toLowerCase()
    ? -1
    : a.toLowerCase() > b.toLowerCase()
    ? 1
    : 0;
  return lowered !== 0 ? lowered : compareSpecifiers(a, b);
}

/**
 * The names inside the braces of an import, in source order. Default and
 * namespace bindings sit outside the braces and are left alone.
 */
function namedSpecifiers(
  node: Deno.lint.ImportDeclaration,
): Deno.lint.ImportSpecifier[] {
  return node.specifiers.filter((specifier) =>
    specifier.type === "ImportSpecifier"
  ) as Deno.lint.ImportSpecifier[];
}

/** The name a member is sorted by, which is the one written first. */
function memberName(specifier: Deno.lint.ImportSpecifier): string {
  const imported = specifier.imported;
  return imported.type === "Identifier" ? imported.name : specifier.local.name;
}

const enforceImportOrder: Deno.lint.Rule = {
  create(ctx) {
    return {
      "Program:exit"(program) {
        const body = program.body;
        const imports = body.filter((statement) =>
          statement.type === "ImportDeclaration"
        ) as Deno.lint.ImportDeclaration[];
        if (imports.length === 0) {
          return;
        }

        for (const node of imports) {
          const members = namedSpecifiers(node);
          for (let i = 1; i < members.length; i += 1) {
            const name = memberName(members[i]);
            const previousName = memberName(members[i - 1]);
            if (compareMembers(name, previousName) >= 0) {
              continue;
            }
            ctx.report({
              node: members[i],
              message: `"${name}" must come before "${previousName}".`,
              hint:
                "Imported names are sorted alphabetically, ignoring case and any \"type\" modifier.",
              ...fixMemberOrder(ctx, members),
            });
            return;
          }
        }

        if (imports.length < 2) {
          return;
        }

        const text = ctx.sourceCode.text;
        const entries = imports.map((node) => ({
          node,
          specifier: node.source.value as string,
          group: importGroup(node.source.value as string),
        }));

        for (let i = 1; i < entries.length; i += 1) {
          const previous = entries[i - 1];
          const current = entries[i];
          const between = text.slice(
            previous.node.range[1],
            current.node.range[0],
          );
          const blankLine = (between.match(/\n/g) ?? []).length >= 2;

          let problem: string | null = null;
          if (current.group < previous.group) {
            problem =
              `${IMPORT_GROUPS[current.group]} imports must come before ${
                IMPORT_GROUPS[previous.group]
              } imports.`;
          } else if (current.group > previous.group && !blankLine) {
            problem = `A blank line must separate ${
              IMPORT_GROUPS[previous.group]
            } imports from ${IMPORT_GROUPS[current.group]} imports.`;
          } else if (current.group === previous.group && blankLine) {
            problem = `${
              IMPORT_GROUPS[current.group]
            } imports must not be split by a blank line.`;
          } else if (
            current.group === previous.group &&
            compareSpecifiers(current.specifier, previous.specifier) < 0
          ) {
            problem =
              `"${current.specifier}" must come before "${previous.specifier}".`;
          }

          if (problem === null) {
            continue;
          }

          ctx.report({
            node: current.node,
            message: problem,
            hint:
              "Imports go in three groups separated by a blank line: packages, then \"#\" aliases, then relative paths. Each group is sorted alphabetically.",
            ...fixImportBlock(ctx, body, entries),
          });
          return;
        }
      },
    };
  },
};

/**
 * Rewrites the braces of one import in sorted order, preserving whether the
 * list was written on one line or spread across several.
 */
function fixMemberOrder(
  ctx: Deno.lint.RuleContext,
  members: Deno.lint.ImportSpecifier[],
): { fix?: (fixer: Deno.lint.Fixer) => Deno.lint.Fix } {
  const text = ctx.sourceCode.text;
  const start = members[0].range[0];
  const end = members[members.length - 1].range[1];

  const commented = ctx.sourceCode.getAllComments().some((comment) =>
    comment.range[0] >= start && comment.range[1] <= end
  );
  if (commented) {
    return {};
  }

  const sorted = [...members].sort((a, b) =>
    compareMembers(memberName(a), memberName(b))
  );
  // Match the existing layout rather than reflowing it, so a list deno fmt
  // already broke across lines stays broken.
  const multiline = text.slice(start, end).includes("\n");
  const indent = multiline
    ? text.slice(text.lastIndexOf("\n", start) + 1, start)
    : "";
  const separator = multiline ? ",\n" + indent : ", ";
  const replacement = sorted.map((member) => ctx.sourceCode.getText(member))
    .join(separator);

  return {
    fix: (fixer) => fixer.replaceTextRange([start, end], replacement),
  };
}

/**
 * Builds the whole-block rewrite for {@linkcode enforceImportOrder}, but only
 * when nothing would be lost. Comments inside the block have no home in the
 * rewritten text, and statements interleaved between imports would be erased
 * by a single range replacement, so both cases report without a fix.
 */
function fixImportBlock(
  ctx: Deno.lint.RuleContext,
  body: Deno.lint.Statement[],
  entries: { node: Deno.lint.ImportDeclaration; specifier: string }[],
): { fix?: (fixer: Deno.lint.Fixer) => Deno.lint.Fix } {
  const first = entries[0].node;
  const last = entries[entries.length - 1].node;
  const start = first.range[0];
  const end = last.range[1];

  const contiguous = body.indexOf(last) - body.indexOf(first) + 1 ===
    entries.length;
  if (!contiguous) {
    return {};
  }

  const commented = ctx.sourceCode.getAllComments().some((comment) =>
    comment.range[0] >= start && comment.range[1] <= end
  );
  if (commented) {
    return {};
  }

  const sorted = [...entries].sort((a, b) =>
    importGroup(a.specifier) - importGroup(b.specifier) ||
    compareSpecifiers(a.specifier, b.specifier)
  );

  let replacement = "";
  let previousGroup: number | null = null;
  for (const entry of sorted) {
    const group = importGroup(entry.specifier);
    if (previousGroup !== null) {
      replacement += group === previousGroup ? "\n" : "\n\n";
    }
    replacement += ctx.sourceCode.getText(entry.node);
    previousGroup = group;
  }

  return {
    fix: (fixer) => fixer.replaceTextRange([start, end], replacement),
  };
}

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
    "no-relative-bypass": noRelativeBypass,
    "enforce-mod-file": enforceModFile,
    "enforce-import-order": enforceImportOrder,
    "enforce-layer-order": enforceLayerOrder,
  },
};

export default plugin;
