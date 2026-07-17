# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Prettier plugin that formats Mojolicious `.html.ep` template files (Perl's Mojolicious web framework
embeds Perl in HTML using `%`-prefixed lines and `<% %>` blocks).

The intended end goal (not yet implemented) is to run the embedded Perl through `perltidy` instead of
leaving it untouched. The current implementation gets the structural piece right first — correct
parsing/nesting of Mojo control-flow and correct blending with real HTML formatting/indentation — with
raw-Perl-text passthrough as a placeholder for the eventual `perltidy` integration.

## Commands

- `npm run generate-grammar` — regenerate `src/mojo/mojo.grammar.js`/`.terms.js` from `src/mojo/mojo.grammar`
  via `lezer-generator`. These two files are gitignored (not committed) and regenerated automatically as
  a `pre*` hook before `build`/`test`/`test:watch`/`test:update` - but if you're running `tsc`/`vitest`
  directly rather than through an npm script, run this first or those generated files won't exist.
- `npm run build` — compile TypeScript (`tsc`) from `src/` to `dist/` (grammar regenerated first)
- `npm run watch` — compile in watch mode (does _not_ regenerate the grammar - run `generate-grammar`
  manually first if `mojo.grammar` itself changed)
- `npm run lint` / `npm run lint:check` — ESLint with/without `--fix`
- `npm run format` / `npm run format:check` — Prettier with/without `--write`
- `npm test` — run the Vitest suite once (grammar regenerated first); `npm run test:watch` for watch mode
- `npm run test:update` — regenerate snapshots (run after an intentional formatting-output change)

To run a single test file, pass its path to vitest directly, e.g.
`npx vitest run tests/format/control-lines/jsfmt.spec.ts` (grammar must already be generated - run
`npm run generate-grammar` first if going this route instead of `npm test`).

CI (`.github/workflows/ci.yml`) runs format:check, lint:check, build, and test on push/PR.

## Architecture

The entry point `src/index.ts` assembles a parser and printer from `src/mojo/`:

- **`mojo.grammar`** is a hand-written [Lezer](https://lezer.codemirror.net/) grammar (compiled by
  `lezer-generator` into `mojo.grammar.js`/`mojo.grammar.terms.js`, gitignored — see Commands above).
  It defines `Block { OpenMarker item* (MidMarker item*)* CloseMarker }`: Mojo control-flow (`%`-prefixed
  lines, `<% ... %>` tags) forms a genuinely _nested_ tree, not a flat token stream. `tokens.ts` is the
  external tokenizer that classifies each control line/tag as `OpenMarker`/`CloseMarker`/`MidMarker`
  (ends with `{`/`begin`, starts with `}`/`end`, or both, e.g. `} else {`) or `PlainMarker`; it's also
  string/comment-aware (borrowing the lexical shape of the sibling `codemirror-lang-perl` project) so a
  literal `%>` inside a Perl string like `<%= "50%>" %>` isn't mistaken for the tag's real closing
  delimiter. `ast.ts` converts the resulting Lezer `Tree` into a plain `MojoNode` object tree (`{ type,
start, end, text, children }`) that's simple to walk without needing a `TreeCursor`.
- **`printer.ts`** does essentially all the real work through `embed()`, not `print()` (`print()` is
  practically unreachable — `embed()` fully handles the root `Program` node and prettier never
  recurses into children). It builds a single-file HTML "skeleton": every Mojo marker becomes a unique
  placeholder token (Unicode Private-Use-Area sentinels, so real template content can never collide with
  one), and everything between a Block's markers gets wrapped in `<ol data-mojo-wrapper>...</ol>`. This
  goes to prettier's real HTML parser/printer as _one_ `textToDoc()` call for the whole file (not one
  call per fragment — see below for why that matters), then the result is flattened to a string via
  `doc.printer.printDocToString()` and post-processed line by line: lines that are exactly the wrapper
  tag are dropped, everything else has its markers substituted back to their raw Perl text.

Two non-obvious design points worth knowing before changing this:

- **Why one combined HTML parse instead of `embed()` per `Text` node**: an earlier version called
  `embed()`/`textToDoc()` independently for each `Text` fragment between markers. That breaks badly
  whenever an HTML tag's content is interrupted by a marker - `<p>Hello, <%= $name %>!</p>` split into
  three independent fragments, each parsed as its own incomplete HTML document, so prettier's HTML
  parser auto-closed `<p>Hello,` immediately and produced garbled, duplicated tags. Building one
  skeleton and parsing it once (with markers as inert placeholders) fixes this, since HTML tag matching
  then sees the whole file.
- **Why `<ol data-mojo-wrapper>` and not a made-up tag name**: prettier's HTML printer only forces an
  element's children onto their own indented lines _unconditionally_ for a handful of real tags
  (`ul`/`ol`/`table`/`select` - tested empirically); an unrecognized custom element is treated as inline
  and collapses onto one line whenever its content is short enough to fit, which silently broke short
  `begin`/`end` blocks. Since `<ol>` is a real HTML element, prettier's own formatter naturally indents
  its children relative to it (and does so again for each level of _nested_ blocks) - no manual
  depth/indent bookkeeping needed on this plugin's side at all. The tradeoff: the closing `</ol>` is
  matched as plain text during substitution, so a genuine `<ol>...</ol>` elsewhere in a real template is
  a real (if unlikely) collision risk that a future iteration should close off, e.g. by doing the
  substitution via the Doc tree's own structure instead of text matching.

Three more mechanisms in `printer.ts`, all found by testing against a realistic multi-construct
template rather than isolated cases (worth doing again for any future change here):

- **Empty separator wrapper** (`visitSequence`): a `Text` node that's nothing but whitespace spanning a
  newline, sitting between two markers/blocks with no real HTML tag involved, is purely structural (it
  exists only to preserve line breaks/blank lines in the source). Left alone, prettier's HTML printer
  treats a run of such "loose" content as ordinary reflowable prose and collapses every line onto one -
  e.g. several bare top-level `%` statements would all end up on the same line. An empty
  `<ol data-mojo-wrapper></ol>` spliced into the gap anchors the boundary (block-level siblings keep
  their exact blank-line/single-newline spacing) without adding any visible content itself.
- **Padding marker placeholders to their real length** (`registerMarker`): prettier decides whether e.g.
  a `<div>`'s content fits on one line using whatever's in the _skeleton_ - the short placeholder token,
  not the real Perl text that gets substituted in afterward. Padding each placeholder out to roughly its
  marker's real first-line length makes that fits-decision realistic, so `<div><%= a long expression %></div>`
  correctly stays multi-line instead of silently collapsing.
- **The separate marker wrapper for own-line `PlainMarker`s** (`MARKER_WRAPPER_OPEN_TAG`): padding alone
  doesn't fully fix the fits problem, because a bare placeholder is still just plain _text_ to HTML, and
  plain text always reflows to fit the available width regardless of source formatting - unlike a real
  _element_, whose original single-line-vs-multi-line placement prettier's HTML printer preserves
  (verified empirically: `<div>\ntext\n</div>` collapses, `<div>\n<span>text</span>\n</div>` doesn't,
  even though both fit easily). So a `PlainMarker` the user wrote alone on its own line (e.g.
  `<%= file_field ... =%>` as a `<div>`'s only child) is wrapped too - in a _second_, distinct
  `<ol data-mojo-marker>` wrapper, not the content one, since wrapping it in a real element is what makes
  HTML respect its own-line placement. Reusing the content wrapper would be wrong here: that one adds a
  real indent level (correct for a Block's content, which really is nested one level deeper than its
  markers), but a bare marker's own line shouldn't move at all - so `stripWrappersAndSubstitute` tracks
  which wrapper kind is currently open with a small stack (both share the literal `</ol>` closing text,
  since closing tags can't carry a disambiguating attribute) and cancels back out the one indent level
  HTML added for the marker wrapper specifically. Structural markers (Open/Mid/Close) don't need this -
  their own-line separation from siblings is already handled by the empty separator wrapper above.

`/home/rice/Projects/Javascript/CodeMirror/codemirror-lang-mt` (a sibling project, not a dependency of
this one) is a more complete, battle-tested Lezer grammar for Mojolicious templates that this project's
grammar design was informed by - it parses full real Perl expression/statement syntax and treats HTML as
skippable `Text` overlaid separately (the reverse structural priority from this plugin, which treats
Perl markers as the "special" nodes and HTML as the primary formatted content). It targets `.mt`
(`Mojo::Template`) rather than Mojolicious's `.html.ep` specifically - the tag syntax is the same since
both go through the same `Mojo::Template` engine, but `<%=`/`<%==` escaping semantics are swapped between
the two (irrelevant for formatting, since this plugin never evaluates escaping). Its sibling
`codemirror-lang-perl` project is what `tokens.ts`'s string/comment-skipping logic is modeled on.

## Testing

Tests follow the fixture-based "run_spec" pattern used by most Prettier plugins: each case is a
directory under `tests/format/<case-name>/` containing a `jsfmt.spec.ts` (just calls
`runSpec(import.meta.dirname, ['mojolicious-html-template'])`) plus one or more input fixture files
(e.g. `*.html.ep`). The shared harness in `tests/run-spec.ts` discovers every non-spec file in that
directory and formats it through this plugin; if a same-named `*.expected.*` file exists alongside it,
output must match that file exactly (a real assertion of specific target behavior), otherwise it falls
back to snapshot-testing whatever the formatter currently produces.

## TypeScript / module setup

- Pure ESM (`"type": "module"`), compiled with `module`/`moduleResolution: NodeNext`, target `ESNext`.
- `prettier` is a peer dependency (`^3.9.4`), not a regular dependency.
- Two tsconfigs: `tsconfig.json` is the primary config — `src/**/*` only, emits to `dist/` — and is what
  `npm run build`/`watch` compile with. `tsconfig.test.json` extends it for type-checking (`src/**/*`
  plus `tests/**/*`, `noEmit`, `types: ["node"]` for the test harness's `node:fs`/`import.meta.dirname`
  usage). ESLint's `parserOptions.project` lists both files explicitly (`projectService`'s auto-discovery
  only looks for the standard-named `tsconfig.json`, so it wouldn't find the test one on its own). Keep
  both in sync if compiler options change.
- `allowJs`/`checkJs: false` are on so `tsc` picks up and copies the generated (gitignored)
  `mojo.grammar.js`/`mojo.grammar.terms.js` into `dist/` alongside the compiled TypeScript, inferring
  their exported types automatically - no hand-written `.d.ts` sidecars needed for them.
