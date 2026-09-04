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

// A region's own failure is deliberately *never* fatal (see registerRegion's own comment on why) -
// this is intentional, not a gap: a region is only *usually* complete, balanced Perl by construction,
// and a real, found-in-the-wild template proved the exception isn't rare. `flattenNode`/`registerRegion`
// join several bare `%` lines into one program before sending it to perltidy, but the region-scan can
// truncate that program at either edge when a structural marker there spans multiple physical lines -
// this case is the region ending right where a `%`-opened impure Block's own condition continues (see
// the passing case below); a genuinely broken region just falls back to raw passthrough, the same way
// any other marker perltidy can't safely reformat already does.
test('a genuinely broken pure-Perl region does not fail format(), just falls back to raw passthrough', async () => {
    const source = '<div>\n% my $x = (;\n% my $y = 2;\n</div>\n';
    const output = await prettier.format(source, {
        filepath: 'broken-region.html.ep',
        parser: 'mojolicious-html-template',
        plugins: [plugin]
    });
    // Indentation still shifts to match nesting depth - only the (unparseable) content itself stays
    // exactly as written.
    expect(output).toBe('<div>\n    % my $x = (;\n% my $y = 2;\n</div>\n');
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

// Regression guard for a second false positive found after the one above: a bare-`%`-line `if`
// condition split across two physical lines (valid Perl - Mojo::Template concatenates consecutive
// `%` lines into one program), where the *second* line also opens a Block containing real HTML. The
// Block's own content disqualifies it from `isPureBlock`, so the region-scan absorbs only the first
// line into a "region" - an artificially truncated, unmatched-paren fragment perltidy genuinely can't
// parse, even though the real, complete source is fine. This must not fail format().
test('a multi-line bare-% condition continuing into an impure Block still formats without error', async () => {
    const source =
        '<div>\n' +
        '    <div>\n' +
        "        % if (ref $grader->{pg}{flags}{ANSWER_ENTRY_ORDER} eq 'ARRAY'\n" +
        '        % && @{ $grader->{pg}{flags}{ANSWER_ENTRY_ORDER} } > 1) {\n' +
        '            <span>placeholder</span>\n' +
        '        % }\n' +
        '    </div>\n' +
        '</div>\n';
    await expect(
        prettier.format(source, {
            filepath: 'continuation.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).resolves.not.toThrow();
});

// The actual requirement behind the fixture above: not just "doesn't crash", but the identical
// condition, written either on one long bare-`%` line or split across two, must format to the exact
// same output - Mojo::Template treats them as the same program, so prettier must too. Also checked for
// idempotency: reformatting the already-formatted output must be a no-op (found directly: an earlier
// version of this combining logic was stable for this exact shape but not for one involving a nested
// pure Block - see `tests/format/bare-percent-open-marker-wraps-when-long` and the region-scan's own
// `regionNodes.every((n) => n.type !== 'Block')` restriction).
test('a one-line and a manually pre-wrapped two-line % if condition format identically', async () => {
    const oneLine =
        '<div>\n' +
        '    <div>\n' +
        "        % if (ref $grader->{pg}{flags}{ANSWER_ENTRY_ORDER} eq 'ARRAY' && @{ $grader->{pg}{flags}{ANSWER_ENTRY_ORDER} } > 1) {\n" +
        '            <span>placeholder</span>\n' +
        '        % }\n' +
        '    </div>\n' +
        '</div>\n';
    const twoLine =
        '<div>\n' +
        '    <div>\n' +
        "        % if (ref $grader->{pg}{flags}{ANSWER_ENTRY_ORDER} eq 'ARRAY'\n" +
        '        % && @{ $grader->{pg}{flags}{ANSWER_ENTRY_ORDER} } > 1) {\n' +
        '            <span>placeholder</span>\n' +
        '        % }\n' +
        '    </div>\n' +
        '</div>\n';
    const options = {
        filepath: 'converge.html.ep',
        parser: 'mojolicious-html-template' as const,
        plugins: [plugin],
        tabWidth: 4,
        printWidth: 120
    };
    const [fromOneLine, fromTwoLine] = await Promise.all([
        prettier.format(oneLine, options),
        prettier.format(twoLine, options)
    ]);
    expect(fromTwoLine).toBe(fromOneLine);
    await expect(prettier.format(fromOneLine, options)).resolves.toBe(fromOneLine);
});

// A real, found-in-the-wild shape that motivated dropping region hard-validation entirely: a
// multi-line `} elsif (...) {` continuation, real Perl control flow, where the CloseMarker that opens
// the continuation ("} elsif (cond1" - starts with `}`, so it's classified as closing the *previous*
// branch, not opening a new one) sits *before* the region even starts, not just after it. The
// region-scan's own truncation tracking only ever looks at what a region is followed by, so it had no
// way to know this region also needed context from what preceded it. Found via a real-corpus sweep
// (three separate real webwork2 templates hit this exact shape) after truncation-tracking was first
// added - this must not fail format().
test('a multi-line % } elsif (...) { continuation does not fail format()', async () => {
    const source =
        '<div>\n' +
        '\t% if ($a) {\n' +
        '\t\t<span>a</span>\n' +
        '\t% } elsif (($b || $c)\n' +
        '\t% && $d\n' +
        '\t\t% && ($e || $f))\n' +
        '\t% {\n' +
        '\t\t<span>g</span>\n' +
        '\t% }\n' +
        '</div>\n';
    await expect(
        prettier.format(source, {
            filepath: 'elsif-continuation.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).resolves.not.toThrow();
});

// A bare-`%`-line `if (...) {` inside an otherwise-impure Block (real HTML inside it) is a
// structural marker perltidy can't validate on its own in general (see MarkerInfo.structural's own
// comment) - except this exact shape, where appending a single synthetic `}` closes the one brace it
// opens with no ambiguity. A genuinely broken condition here must still fail format() even though
// most structural markers are exempt from hard validation.
test('a genuinely broken bare-% if condition still fails, even though most structural markers are exempt', async () => {
    const source =
        '<div>\n' +
        '    % if (some_function_call_missing_its_closing_paren_and_also_long_enough_to_need_wrapping( {\n' +
        '        <span>x</span>\n' +
        '    % }\n' +
        '</div>\n';
    await expect(
        prettier.format(source, {
            filepath: 'broken-bare-if.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).rejects.toThrow(PerltidyFormatError);
});

// A bare-% `if (...) {` that already fits within printWidth must be left completely untouched -
// reformatting it anyway would silently normalize the condition's own spacing (`if($x)` -> `if ($x)`),
// a cosmetic change nobody asked for. Only a condition that's actually too long pays that cost, in
// exchange for wrapping at all (see the `bare-percent-open-marker-wraps-when-long` format fixture).
test('a short bare-% if condition that already fits is left untouched', async () => {
    const source = '<div>\n    % if($x){\n        <span>x</span>\n    % }\n</div>\n';
    const output = await prettier.format(source, {
        filepath: 'short-bare-if.html.ep',
        parser: 'mojolicious-html-template',
        plugins: [plugin]
    });
    expect(output).toBe(source);
});
