import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseConfigText } from "#imports";
import plugin from "#lint";
import { normalizePath, parentDir } from "#paths";

const FIXTURE = parentDir(normalizePath(import.meta.url)) + "/fixture";

/**
 * Runs the plugin against a source string as if it lived at the given path
 * inside the fixture project, and keeps only diagnostics of one rule.
 */
function lint(
  relativePath: string,
  source: string,
  rule: string,
): Deno.lint.Diagnostic[] {
  const diagnostics = Deno.lint.runPlugin(
    plugin,
    `${FIXTURE}/${relativePath}`,
    source,
  );
  return diagnostics.filter((d) => d.id === `dependency-check/${rule}`);
}

/** Applies the reported fixes to the source, right to left. */
function applyFixes(
  source: string,
  diagnostics: Deno.lint.Diagnostic[],
): string {
  const fixes = diagnostics.flatMap((d) => d.fix ?? []);
  fixes.sort((a, b) => b.range[0] - a.range[0]);
  let result = source;
  for (const fix of fixes) {
    result = result.slice(0, fix.range[0]) + (fix.text ?? "") +
      result.slice(fix.range[1]);
  }
  return result;
}

Deno.test("no-parent-import replaces a parent import with its package export", () => {
  const source = `import { utils } from "../utils/mod.ts";\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `Use "#utils" instead`);
  assertEquals(applyFixes(source, found), `import { utils } from "#utils";\n`);
});

Deno.test("no-parent-import preserves the original quote style", () => {
  const source = `import { utils } from '../utils/mod.ts';\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(applyFixes(source, found), `import { utils } from '#utils';\n`);
});

Deno.test("no-parent-import covers re-exports and dynamic imports", () => {
  const source = `export * from "../utils/mod.ts";\n` +
    `export { utils } from "../utils/mod.ts";\n` +
    `const mod = await import("../utils/mod.ts");\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 3);
});

Deno.test("no-parent-import reports without a fix when no entry matches", () => {
  const source = `import { thing } from "../unmapped/mod.ts";\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 1);
  assertEquals(found[0].fix ?? [], []);
  assertStringIncludes(found[0].hint ?? "", 'No "#" entry');
});

Deno.test("no-parent-import ignores same-folder and package imports", () => {
  const source = `import { internal } from "./internal.ts";\n` +
    `import { utils } from "#utils";\n` +
    `import { html } from "#lit";\n`;
  const found = lint("src/components/mod.ts", source, "no-parent-import");

  assertEquals(found.length, 0);
});

Deno.test("no-barrel-bypass rejects reaching past a module entry point", () => {
  const source = `import { internal } from "#components/internal.ts";\n`;
  const found = lint("src/app-store.ts", source, "no-barrel-bypass");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `Import from "#components" instead`);
});

Deno.test("no-barrel-bypass allows the exact module specifier", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint("src/app-store.ts", source, "no-barrel-bypass");

  assertEquals(found.length, 0);
});

Deno.test("enforce-layer-order rejects importing an earlier module", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(
    found[0].message,
    `"#utils" must not import "#components"`,
  );
});

Deno.test("enforce-layer-order allows importing a later module", () => {
  const source = `import { utils } from "#utils";\n` +
    `import type { Thing } from "#types";\n`;
  const found = lint("src/components/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 0);
});

Deno.test("enforce-layer-order rejects a module importing its own entry point", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint(
    "src/components/internal.ts",
    source,
    "enforce-layer-order",
  );

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, "must not import itself");
});

Deno.test("enforce-layer-order treats a deep specifier as its owning module", () => {
  const source = `import { internal } from "#components/internal.ts";\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `must not import "#components"`);
});

Deno.test("enforce-layer-order ignores files outside every declared module", () => {
  const source = `import { components } from "#components";\n`;
  const found = lint("scripts/build.ts", source, "enforce-layer-order");

  assertEquals(found.length, 0);
});

// Deno parses deno.json as JSONC regardless of its extension, so a real
// project's config may contain comments and trailing commas even though the
// fixture above is plain JSON.
Deno.test("config parsing tolerates JSONC comments and trailing commas", () => {
  const text = `{
  // A line comment.
  "imports": {
    "#utils": "./src/utils/mod.ts",
    /* A block comment. */
    "#types": "./src/types/mod.ts",
  },
}`;

  assertEquals(parseConfigText(text), {
    imports: {
      "#utils": "./src/utils/mod.ts",
      "#types": "./src/types/mod.ts",
    },
  });
});

Deno.test("config parsing leaves comment-like text inside strings alone", () => {
  const text = `{
  "imports": {
    "#a": "./src/a//b.ts",
    "#b": "./src/c/*d*/e.ts",
    "#c": "./src/quote\\"//x.ts"
  }
}`;

  assertEquals(parseConfigText(text), {
    imports: {
      "#a": "./src/a//b.ts",
      "#b": "./src/c/*d*/e.ts",
      "#c": './src/quote"//x.ts',
    },
  });
});

Deno.test("a JSONC config on disk is read end to end", () => {
  // Guards the wiring, not just the parser: a config with comments is written
  // to a temp project so this fails if the plugin ever calls JSON.parse.
  const dir = normalizePath(Deno.makeTempDirSync());
  Deno.mkdirSync(`${dir}/src/utils`, { recursive: true });
  Deno.writeTextFileSync(
    `${dir}/deno.json`,
    `{\n  // Layered bottom up.\n  "imports": {\n    "#utils": "./src/utils/mod.ts",\n  },\n}\n`,
  );

  const source = `import { utils } from "../utils/mod.ts";\n`;
  const found = Deno.lint.runPlugin(
    plugin,
    `${dir}/src/components/mod.ts`,
    source,
  ).filter((d) => d.id === "dependency-check/no-parent-import");

  assertEquals(found.length, 1);
  assertEquals(applyFixes(source, found), `import { utils } from "#utils";\n`);

  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a file entry owns only itself, not its whole directory", () => {
  // "#app-store" maps to "./src/app-store.ts", so "src" must not become a
  // module directory that swallows every sibling.
  const source = `import { components } from "#components";\n`;
  const found = lint("src/utils/mod.ts", source, "enforce-layer-order");

  assertEquals(found.length, 1);
  assertStringIncludes(found[0].message, `"#utils" must not import`);
});
