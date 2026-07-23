# Deno Import Check

Keep a Deno module graph free of cycles and clearly layered.

This package ships two complementary halves:

|                 | Runs as     | Catches                                               |
| --------------- | ----------- | ----------------------------------------------------- |
| **CLI**         | `deno run`  | Circular dependencies anywhere in the module graph    |
| **Lint plugin** | `deno lint` | Parent imports, barrel bypasses, and layer violations |

They are split this way because a Deno lint plugin only ever sees one file's
syntax tree. It cannot follow imports, so it cannot detect a cycle. The CLI
resolves the whole graph and finds cycles after the fact; the lint rules stop
the import patterns that create cycles in the first place, right in the editor.

## CLI

```shell
deno run -A jsr:@cunarist/deno-import-check somefile.ts someotherfile.ts
```

Pass every entry point your project has. They are merged into one graph, so a
module reachable from the tests but not from the app still counts as reached —
which matters for the unused alias check below.

The process exits with code 0 on success and 1 on failure, so it drops straight
into CI or a pre-commit hook.

✅ **No dependency graph problems:**

```
📦 2 modules
📁 2 local modules
✅ No circular dependencies found
✅ Every "#" internal import alias is used
```

❌ **Dependency graph problems found:**

```
📦 2 modules
📁 2 local modules
🚨 1 circular dependencies detected
■ ./examples/mod-b.ts ▶ ./examples/mod-d.ts ▶ ./examples/mod-b.ts
🚨 1 unused "#" internal import alias in deno.json
■ #legacy
```

Under the hood it reads `deno info --json` for the complete module graph, walks
it depth first to find cycles, and reports each one as a path. Only local
modules are traversed, so remote and JSR dependencies are ignored.

## Lint plugin

```json
{
  "lint": {
    "plugins": ["jsr:@cunarist/deno-import-check/lint"]
  }
}
```

Then run `deno lint`, or `deno lint --fix` to apply the automatic fixes.

To drop a rule, name it in `rules.exclude`:

```json
{
  "lint": {
    "plugins": ["jsr:@cunarist/deno-import-check/lint"],
    "rules": { "exclude": ["import-check/no-absolute-import"] }
  }
}
```

Every rule is also exported by name, so you can build a plugin holding only the
ones you want, alongside rules of your own. Point `plugins` at your own file
instead of this package.

```ts
// lint.ts
import {
  enforceLayerOrder,
  noParentImport,
} from "jsr:@cunarist/deno-import-check/lint";

const plugin: Deno.lint.Plugin = {
  name: "my-rules",
  rules: {
    "no-parent-import": noParentImport,
    "enforce-layer-order": enforceLayerOrder,
  },
};

export default plugin;
```

The exported names are the camel case form of the rule names below.

The rules read the `#` entries of the `imports` map in the nearest `deno.json`,
which declare what the modules are. A file belongs to the module whose directory
contains it, so an entry pointing at a barrel owns everything beside it, while
one pointing at a plain file owns only that file.

### `no-parent-import`

Bans `../` specifiers. Reaching up and back down couples two modules through
their file layout instead of their public surface, which is how import cycles
usually start.

```ts
import { utils } from "../utils/mod.ts"; // error
import { utils } from "#utils"; // correct
import { helper } from "./helper.ts"; // correct, same folder
```

**Automatically fixable.** When the resolved path matches a declared entry, the
rule rewrites the specifier for you and keeps your quote style. When nothing
matches, it reports the resolved path and leaves the fix to you — either add an
entry for it, or move the shared code into a module that already has one.

### `no-absolute-import`

Bans specifiers starting with `/` or `file:`. A leading slash resolves against
the file system root rather than the project root, a `file:` URL hard codes one
machine's layout, and both slip past every path rule here.

```ts
import { utils } from "/src/utils/mod.ts"; // error, file system root
import { utils } from "file:///home/me/src/utils/mod.ts"; // error, one machine
import { utils } from "#utils"; // correct
```

### `prefer-alias-import`

The `./` counterpart. When a relative path crosses into another folder and that
folder's file is already declared as a `#` entry, use the alias.

```ts
import { thing } from "./components/mod.ts"; // error, that is "#components"
import { thing } from "#components"; // correct
import { helper } from "./helper.ts"; // correct, same folder
```

Same-folder siblings are left alone, since that is the form every other rule
recommends. One spelling per module keeps `deno.json` the single source of
truth, and stops `enforce-layer-order` from being sidestepped by writing a path
instead of an alias.

**Automatically fixable.**

### `no-barrel-bypass`

Bans reaching past a module's entry point through a trailing-slash mapping such
as `"#components/": "./src/components/"`.

```ts
import { thing } from "#components/internal.ts"; // error
import { thing } from "#components"; // correct
```

Whatever the importer needs should be re-exported from the entry point, so each
module keeps exactly one public surface. If you declare no trailing-slash
mappings at all, this rule never fires.

### `no-relative-bypass`

The same principle for relative paths. A `./` specifier may descend one level at
most, and only into that folder's entry point.

```ts
import { helper } from "./helper.ts"; // correct, sibling
import { thing } from "./sub/mod.ts"; // correct, child entry point
import { thing } from "./sub/internal.ts"; // error, past the entry point
import { thing } from "./sub/deep/mod.ts"; // error, two levels down
```

Together with `no-parent-import` this leaves exactly two ways to reach another
module: a sibling file, or a `#` entry.

### `enforce-mod-file`

Entry points must be named `mod.ts`, the Deno convention. Both the file name and
any specifier pointing at an index file are reported.

```ts
// in ./src/utils/index.ts — error, rename the file to mod.ts

import { thing } from "./sub/index.ts"; // error
import { thing } from "./sub/mod.ts"; // correct
import { html } from "npm:lit/index.js"; // fine, not your file
```

Turning this rule off still leaves `index.ts` recognized as an entry point
everywhere else, so a project on the Node convention loses nothing but this
check.

### `enforce-import-order`

Imports go in three groups separated by a blank line, each sorted
alphabetically: packages, then `#` aliases, then relative paths.

```ts
import { assertEquals } from "@std/assert";
import { z } from "npm:zod";

import { Button } from "#components";
import { format } from "#utils";

import { helper } from "./helper.ts";
```

The groups run from most distant to most local, so the shape of a file's
dependencies is visible before reading a single statement. Anything that is
neither a `#` alias nor a path counts as a package, which covers bare names,
`jsr:`, `npm:`, `node:` and remote URLs alike.

**Automatically fixable**, unless a comment or another statement sits between
the imports. Those are reported without a fix, so nothing gets discarded.

Names inside the braces are sorted too, ignoring case and any `type` modifier. A
default or namespace binding sits outside the braces and stays where it is.

```ts
import plugin, { baseName, type ModuleEntry, normalizePath } from "#paths";
```

Specifiers are ordered by code point, so punctuation such as `#` and `@` counts.
Names are ordered case insensitively, so `PascalCase` types are not clumped
ahead of `camelCase` functions.

### `enforce-layer-order`

Treats the order of `#` entries in `deno.json` as the layer order, top layer
first: **a module may only import modules declared below it.**

```json
{
  "imports": {
    "#components": "./src/components/mod.ts",
    "#utils": "./src/utils/mod.ts",
    "#types": "./src/types/mod.ts"
  }
}
```

```ts
// in ./src/components/mod.ts — declared first, so everything is below it
import { format } from "#utils"; // correct
import type { User } from "#types"; // correct

// in ./src/utils/mod.ts
import type { User } from "#types"; // correct, declared below
import { Button } from "#components"; // error, declared above
```

To fix a violation, either reorder the two entries or move the shared code into
a module further down.

A module importing its own entry point is flagged too, since that is a cycle
waiting to happen — use a same-folder relative import instead:

```ts
// in ./src/utils/format.ts
import { helper } from "#utils"; // error, importing its own module
import { helper } from "./helper.ts"; // correct
```

This makes cycles between modules structurally impossible rather than merely
detectable, which is why it pairs with the CLI instead of duplicating it. The
ordering is deliberately implicit in the config so there is nothing extra to
keep in sync; ordering the `imports` map top-down doubles as documentation.

## License

MIT
