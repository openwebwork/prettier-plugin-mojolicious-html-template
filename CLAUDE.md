# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Prettier plugin that formats Mojolicious `.html.ep` template files (Perl's Mojolicious web framework
embeds Perl in HTML using `%`-prefixed lines and `<% %>` blocks). The project is an early, crude first
attempt (see initial commit) — expect the implementation to be incomplete.

The intended end goal (not yet implemented) is to format the HTML the way Prettier already does, but
run the embedded Perl through `perltidy` instead of leaving it untouched, with the Perl's indentation
folded into the surrounding HTML's indentation rather than substituted back verbatim.

## Commands

- `npm run build` — compile TypeScript (`tsc`) from `src/` to `dist/`
- `npm run watch` — compile in watch mode
- `npm run lint` / `npm run lint:check` — ESLint with/without `--fix`
- `npm run format` / `npm run format:check` — Prettier with/without `--write`
- `npm test` — run the Vitest suite once; `npm run test:watch` for watch mode
- `npm run test:update` — regenerate snapshots (run after an intentional formatting-output change)

To run a single test file, pass its path to vitest directly, e.g.
`npx vitest run tests/format/control-lines/jsfmt.spec.ts`.

CI (`.github/workflows/ci.yml`) runs format:check, lint:check, build, and test on push/PR.

## Architecture

The single entry point is `src/index.ts`. Since Prettier's built-in HTML parser doesn't understand
Mojolicious's embedded-Perl syntax, the plugin works around this with a placeholder substitution
strategy rather than a real Mojolicious grammar:

1. **`preprocess()`** runs before Prettier's HTML parser sees the source. It regex-replaces Mojolicious
   syntax with HTML-comment placeholders (`<!--MOJO_LINE_N-->` for whole `%`-prefixed lines,
   `<!--MOJO_BLOCK_N-->` for inline `<% %>` / `<%= %>` / `<%== %>` blocks), stashing the original text
   in a module-level `placeholders` array keyed by insertion order.
2. Parsing and formatting is then delegated entirely to Prettier's built-in HTML parser/printer
   (`prettier/plugins/html`), spread into this plugin's `parsers`/`printers` exports so the plugin
   inherits standard HTML formatting behavior.
3. **`print()`** walks the resulting Prettier `doc` tree with `doc.utils.mapDoc` and substitutes each
   placeholder comment back with its original Mojolicious source text, after the HTML formatter has
   already decided line breaks/indentation around it.

Because `placeholders` is module-level mutable state reset at the start of `preprocess()`, this plugin
assumes one file is preprocessed and printed at a time — it is not safe for concurrent formatting of
multiple files in the same process.

The ESLint config's ignore list references `src/pg.grammar.terms.js`, a generated-grammar file that
doesn't exist yet — anticipate a future move to a real parser/grammar rather than the current
regex-and-placeholder approach.

## Testing

Tests follow the fixture-based "run_spec" pattern used by most Prettier plugins: each case is a
directory under `tests/format/<case-name>/` containing a `jsfmt.spec.ts` (just calls
`runSpec(import.meta.dirname, ['mojolicious-html-template'])`) plus one or more input fixture files
(e.g. `*.html.ep`). The shared harness in `tests/run-spec.ts` discovers every non-spec file in that
directory, formats it through this plugin, and snapshot-tests the result — so adding a new test case
is just adding a new fixture file (or a new directory) rather than writing a bespoke test.

Snapshots currently reflect the crude placeholder-based formatter's real output, warts and all (e.g.
loss of original indentation on `%` control lines, and inline `<%= %>` expressions getting wrapped
onto their own lines by the HTML printer) — these are known, expected gaps given the project's current
stage, not test bugs.

## TypeScript / module setup

- Pure ESM (`"type": "module"`), compiled with `module`/`moduleResolution: NodeNext`, target `ESNext`.
- `prettier` is a peer dependency (`^3.9.4`), not a regular dependency.
- Two tsconfigs: `tsconfig.json` is the primary config — `src/**/*` only, emits to `dist/` — and is what
  `npm run build`/`watch` compile with. `tsconfig.test.json` extends it for type-checking (`src/**/*`
  plus `tests/**/*`, `noEmit`, `types: ["node"]` for the test harness's `node:fs`/`import.meta.dirname`
  usage). ESLint's `parserOptions.project` lists both files explicitly (`projectService`'s auto-discovery
  only looks for the standard-named `tsconfig.json`, so it wouldn't find the test one on its own). Keep
  both in sync if compiler options change.
