# prettier-mojolicious-html-template

A [Prettier](https://prettier.io/) plugin for formatting [Mojolicious](https://mojolicious.org/)
`.html.ep` and `.html.epl` templates.

Mojolicious templates mix HTML with embedded Perl, using `<% %>`/`<%= %>`/`<%== %>` tags and `%`-prefixed
control lines. Prettier has no native way to format that mixture. This plugin parses the Mojo template
syntax, hands the surrounding HTML to Prettier's own HTML formatter, and (optionally) reformats the
embedded Perl with [`perltidy`](https://metacpan.org/pod/Perl::Tidy) - so the whole file comes out
consistently formatted, with the HTML and the Perl each laid out by the tool that actually understands it.

## Features

- Formats the HTML structure of a template using Prettier's built-in HTML printer, exactly as it would
  format a plain `.html` file.
- Reformats the Perl inside every marker - `<% %>`, `<%= %>`, `<%== %>`, and `%`/`%=`/`%==` control
  lines - with `perltidy`, whether the marker sits alone on its own line, inline with surrounding HTML, or
  inside `<pre>`.
- Understands Mojolicious's block syntax (`% ... {` / `% }`, `begin`/`end`) well enough to indent nested
  control flow to match the surrounding HTML depth.
- Lets a `<%`-delimited Block's content lay out on one line when it fits, or wrap normally when it
  doesn't - but _how_ that decision gets made differs by what the Block wraps, matching each tool's own
  convention: a `begin`/`end` Block wraps ordinary markup, so it collapses whenever it fits, the same way
  Prettier lays out any HTML element, regardless of how the source was originally written. A `{`/`}`
  control-flow Block wraps genuine Perl, so instead it preserves whichever the author already wrote -
  `if (...) { ... }` on one line stays one line if it still fits; the same code across several lines stays
  several lines even if it would now fit joined - matching how `perltidy` treats real Perl. A bare
  `%`-opened Block always stays multi-line either way, since Mojolicious requires each bare `%` control
  line to start its own physical line.
- Collapses runs of consecutive blank `%` lines down to one, matching how Prettier and `perltidy` both
  collapse blank lines elsewhere.
- Normalizes void HTML elements (`<br>`, `<input>`, `<img>`, etc.) to the bare, non-self-closing form, and
  expands any non-void element that ends up self-closing into a real open/close pair - a non-void
  element's self-closing slash doesn't actually close it in HTML5, so Prettier's own default of preserving
  it is misleading output.
- Picks up an existing `.perltidyrc` (searched for starting from the template's own directory and walking
  upward) so embedded Perl follows the same style as the rest of a project's Perl code.
- Idempotent: formatting an already-formatted file produces no changes.
- Degrades gracefully if `perltidy` isn't installed - the HTML still gets formatted; embedded Perl is left
  as written, with a one-time warning.

## Installation

```sh
npm install --save-dev prettier-mojolicious-html-template
```

Requires Prettier `^3.9.4` as a peer dependency. Older Prettier 3.x releases (3.8.3, for example) are
currently known not to work; broadening support to earlier 3.x versions is a goal but not yet done.

## Usage

Add the plugin to your Prettier configuration. In `.prettierrc`:

```json
{
    "plugins": ["prettier-mojolicious-html-template"]
}
```

The plugin registers itself for files ending in `.html.ep` or `.html.epl`, so no `overrides`/`parser`
setting is normally needed - just run Prettier as usual:

```sh
npx prettier --write "templates/**/*.html.ep"
```

### Options

The plugin uses Prettier's standard options - `printWidth`, `tabWidth`, `useTabs`, etc. - for both the
HTML layout and the width/indentation passed to `perltidy` for the embedded Perl, so the two stay
consistent with each other. `tabWidth` defaults to `4` (matching `perltidy`'s own default) when not set
explicitly.

### Combining with other plugins

This plugin normalizes void HTML elements itself (see Features above), so
[`@awmottaz/prettier-plugin-void-html`](https://www.npmjs.com/package/@awmottaz/prettier-plugin-void-html)
isn't needed for `.html.ep`/`.html.epl` files and **shouldn't be loaded globally alongside this one** - both
plugins register their own printer for Prettier's `html` AST format under the same name, and this plugin
relies internally on that same format to lay out the HTML surrounding each Mojo marker. Loading both means
the _other_ plugin's printer - not Prettier's own - ends up handling that internal step too, and its own
Doc-shape assumptions don't anticipate a void element sitting glued against a marker placeholder rather
than a real HTML sibling, corrupting the output.

If a project also has genuine `.html` files that want `@awmottaz/prettier-plugin-void-html`, scope each
plugin to its own file pattern with `overrides` instead of listing both globally:

```json
{
    "overrides": [
        { "files": "*.html", "options": { "plugins": ["@awmottaz/prettier-plugin-void-html"] } },
        { "files": "*.html.ep", "options": { "plugins": ["prettier-mojolicious-html-template"] } }
    ]
}
```

## Example

Input:

```html+ep
% my @items = (1, 2, 3);
<ul>
% for my $item (@items) {
<li><%= $item %></li>
% }
</ul>
```

Formatted:

```html+ep
% my @items = ( 1, 2, 3 );
<ul>
    % for my $item (@items) {
        <li><%= $item %></li>
    % }
</ul>
```

Perl inside a tag-form marker gets tidied the same way `perltidy` would format it on its own:

```html+ep
<%= tag 'div',
  id=>'foo',
    class    =>   'bar',
=%>
```

becomes

```html+ep
<%= tag 'div',
    id    => 'foo',
    class => 'bar', =%>
```

A `<%`-delimited control-flow Block preserves whichever line count the author wrote, the same way
`perltidy` treats real Perl - written on one line, it stays one line as long as it still fits:

```html+ep
<% if ($showThis) { %>this is shown<% } %>
```

but written across several lines, it stays that way even though it would now fit joined:

```html+ep
<% if ($showThis) { %>
    this is shown
<% } %>
```

## Requirements

- Node.js.
- [`perltidy`](https://metacpan.org/pod/Perl::Tidy) (the `perl` interpreter with `Perl::Tidy` installed)
  on `PATH`, for embedded Perl to be reformatted. Without it, the plugin still formats the surrounding
  HTML and leaves Perl content as-is.

## Development

```sh
git clone <this repository>
cd prettier-mojolicious-html-template
npm install
```

### Build

```sh
npm run build
```

This regenerates the Lezer grammar (`src/mojo/mojo.grammar.js`) from `src/mojo/mojo.grammar`, then
compiles TypeScript to `dist/`. Use `npm run watch` for incremental rebuilds while developing.

### Test

```sh
npm test
```

Runs the fixture-based format tests under `tests/format/` (each `<name>.html.ep` is formatted and
compared against `<name>.expected.html.ep`, or a stored snapshot if no expected file exists). `npm run
test:watch` reruns on change; `npm run test:update` refreshes snapshots.

### Lint and format

```sh
npm run lint:check     # eslint, no fixes
npm run lint           # eslint --fix
npm run format:check   # prettier --check
npm run format         # prettier --write
```

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint:check`, `build`, and `test` on every push and
pull request against `main`.

## License

[LGPL-3.0-or-later](https://www.gnu.org/licenses/lgpl-3.0.html)
