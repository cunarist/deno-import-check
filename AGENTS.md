# Agent Notes

`@cunarist/deno-dependency-check` keeps a Deno module graph acyclic and layered.
It ships two surfaces from one package:

- **CLI** (`src/mod.ts`, the `.` export) resolves the whole module graph through
  `deno info --json` and reports cycles.
- **Lint plugin** (`src/lint.ts`, the `./lint` export) bans the import patterns
  that create cycles.

The split is not arbitrary. A Deno lint plugin only ever sees one file's syntax
tree, so it cannot follow imports and therefore cannot detect a cycle. Do not
try to move cycle detection into the plugin.

## Verification

Run all four before considering a change done:

```shell
deno fmt
deno lint
deno check src/*.ts tests/*.ts
deno test -A
```

Before a release, also run `deno publish --dry-run` to confirm the package still
builds and that `publish.exclude` keeps `examples` and `tests` out.

## File naming

**Every file under `src/` uses kebab-case**: lowercase, words separated by
hyphens, never underscores or camelCase. `import-graph.ts`, not
`import_graph.ts` or `importGraph.ts`.

Test files follow the same rule. `deno test` only discovers files matching its
own patterns, so use `<name>.test.ts` — Deno also accepts `<name>_test.ts`, but
that underscore is the one thing this convention exists to avoid.

A module's entry point is always `mod.ts`, never `index.ts`. The
`enforce-mod-file` rule enforces this. `index` stays in `BARREL_STEMS` so that
projects which turn the rule off keep working — do not remove it from there.

Entry point names are matched by stem, so `.ts`, `.tsx`, `.js` and the rest are
never distinguished. Add extensions to nothing; add stems to `BARREL_STEMS`.

## Import order

Packages, then `#` aliases, then relative paths, each group separated by a
blank line and sorted by code point. `enforce-import-order` enforces this and
fixes it with `deno lint --fix`.

Do not add a third-party import sorter alongside it. `@ayk/lint-import-order`
was removed for this reason: it classifies `#` specifiers as external packages,
so the two plugins fight over the same lines and each undoes the other's fix.

## The plugin must have zero dependencies

`src/lint.ts` and everything it imports must not import any external package.

A lint plugin's own imports resolve against the **consuming** project's import
map, not this package's. Adding a dependency here works when the plugin is
loaded from JSR but breaks every project that loads it from a local path or
vendors it, with an error like:

```
Import "@std/jsonc" not a dependency and not in import map
```

This is why `parseConfigText` in `src/imports.ts` is a hand-rolled JSONC parser
instead of a call to `@std/jsonc`. Do not "simplify" it into `JSON.parse`
either: Deno parses `deno.json` as JSONC regardless of its extension, so a
config with a single comment would fail to parse, `findImportsConfig` would
return `null`, and all three rules would silently stop reporting anything. The
`a JSONC config on disk is read end to end` test guards that wiring.

## Layer order

The `#`-prefixed entries of the `imports` map in `deno.json` are the single
source of truth for module structure. Their **declaration order is the layer
order**, top layer first: a module may only import modules declared below it.
Order the map top-down so it doubles as documentation.

This repo dogfoods its own plugin, so `deno.json` lists `#lint`, `#imports`,
and `#paths` in dependency order, and `deno lint` runs the rules in
`src/lint.ts` against this codebase.

## ASCII only

The `prefer-ascii` lint rule is enabled, so non-ASCII characters in source must
be written as escapes: `"\u{1f4e6}"`, not the literal emoji. This applies to
`src/`, not to `README.md`.

## Publishing

JSR has no rename operation. The package was renamed from
`@cunarist/deno-circular-deps`, which stays frozen at 0.2.1. Version bumps are
manual edits to `deno.json` followed by `deno publish`.
