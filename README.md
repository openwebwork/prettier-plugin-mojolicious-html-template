# prettier-mojolicious-html-template

A [Prettier](https://prettier.io/) plugin for formatting [Mojolicious](https://mojolicious.org/)
`.html.ep` templates (and plain `Mojo::Template` `.mt` files).

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
- Collapses runs of consecutive blank `%` lines down to one, matching how Prettier and `perltidy` both
  collapse blank lines elsewhere.
- Picks up an existing `.perltidyrc` (searched for starting from the template's own directory and walking
  upward) so embedded Perl follows the same style as the rest of a project's Perl code.
- Idempotent for nearly all templates: formatting an already-formatted file produces no changes. A small
  number of shapes are a known exception and currently need a second formatting pass to settle.
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

The plugin registers itself for files ending in `.html.ep` or `.mt`, so no `overrides`/`parser` setting is
normally needed - just run Prettier as usual:

```sh
npx prettier --write "templates/**/*.html.ep"
```

### Options

The plugin uses Prettier's standard options - `printWidth`, `tabWidth`, `useTabs`, etc. - for both the
HTML layout and the width/indentation passed to `perltidy` for the embedded Perl, so the two stay
consistent with each other. `tabWidth` defaults to `4` (matching `perltidy`'s own default) when not set
explicitly.

### Combining with other plugins

Mojolicious templates often also want
[`@awmottaz/prettier-plugin-void-html`](https://www.npmjs.com/package/@awmottaz/prettier-plugin-void-html)
for self-closing void HTML elements. Both can be listed together:

```json
{
    "plugins": ["@awmottaz/prettier-plugin-void-html", "prettier-mojolicious-html-template"]
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
    class => 'bar',
=%>
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
