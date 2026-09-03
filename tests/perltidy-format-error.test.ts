import { test, expect } from 'vitest';
import * as prettier from 'prettier';

import plugin from '../src/index.js';
import { PerltidyFormatError } from '../src/mojo/perltidy.js';

// Genuinely broken Perl inside a self-contained marker (an inline `<%= %>` expression, not a
// structural if/for/etc. marker - see the regression test below for why that distinction matters)
// must fail the whole format() call, matching how prettier itself refuses to format an entire file
// it can't parse, rather than leaving that one marker untouched while reformatting everything else.
test('format() rejects with PerltidyFormatError for a genuinely broken self-contained marker', async () => {
    await expect(
        prettier.format('<div><%= 1 + ) %></div>\n', {
            filepath: 'broken.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).rejects.toThrow(PerltidyFormatError);
});

// Genuinely broken Perl inside a bare-`%`-line region (see registerRegion/flattenNode: several bare
// `%` lines get reconstructed into one complete Perl program before being sent to perltidy) must
// fail the same way.
test('format() rejects with PerltidyFormatError for a genuinely broken pure-Perl region', async () => {
    await expect(
        prettier.format('<div>\n% my $x = (;\n% my $y = 2;\n</div>\n', {
            filepath: 'broken-region.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).rejects.toThrow(PerltidyFormatError);
});

// Regression guard: a structural marker's own body (an `if`/`for`/`}`/`} else {` fragment using
// tag-form `<% %>` delimiters) is *never* a complete, balanced Perl fragment by itself - perltidy
// genuinely, unconditionally fails to parse every one of these in isolation, regardless of whether
// the author's Perl is fine (confirmed directly: even `if ($x) {` alone, wrapped exactly the way
// runPerltidy wraps it for depth-aware formatting, still fails). An earlier version of the
// perltidy-unavailable/format-error validation treated every such failure as fatal, which would have
// made ordinary, correctly-written control flow like this fail format() outright. It must not.
test('a well-formed control-flow marker with messy spacing still formats normally', async () => {
    const output = await prettier.format('<div>\n<% if($x){ =%>\nok\n<% } =%>\n</div>\n', {
        filepath: 'control-flow.html.ep',
        parser: 'mojolicious-html-template',
        plugins: [plugin]
    });
    expect(output).toBe('<div>\n    <% if($x){ =%>\n        ok\n    <% } =%>\n</div>\n');
});
