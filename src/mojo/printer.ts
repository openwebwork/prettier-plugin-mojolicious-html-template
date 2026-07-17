import { dirname } from 'node:path';
import { doc, type AstPath, type Doc, type Options } from 'prettier';
import type { MojoNode } from './ast.js';
import { findPerltidyrc, runPerltidy } from './perltidy.js';

const isStructuralMarker = (type: string): boolean =>
    type === 'OpenMarker' || type === 'MidMarker' || type === 'CloseMarker';

// Unicode Private Use Area sentinels so a placeholder can never collide with real template content,
// while still being one contiguous whitespace-free "word" that HTML's text-wrapping won't split. The
// filler character used to pad a placeholder out to roughly its marker's real length (see
// `registerMarker`) is another PUA codepoint for the same reason.
const MARKER_OPEN = `${String.fromCharCode(0xe000)}MOJO`;
const MARKER_CLOSE = String.fromCharCode(0xe001);
const MARKER_PAD = String.fromCharCode(0xe002);

// `<ol data-mojo-wrapper>` rather than a made-up tag name: prettier's HTML printer only forces an
// element's children onto their own indented lines unconditionally for a handful of tags
// (list/table/select-like containers - `ul`/`ol`/`table`/`select` all qualify, tested empirically);
// an unrecognized custom tag is treated as inline and its content collapses onto one line whenever
// it's short enough to fit, which is wrong for Perl control-flow blocks that should always get their
// own line regardless of width. The `data-mojo-wrapper` attribute keeps the *opening* tag unambiguous
// from a real `<ol>` the template's own HTML might contain; the closing `</ol>` is still just plain
// text, so a genuine `<ol>...</ol>` elsewhere in the template is a real (if unlikely) collision risk
// with this approach that a future iteration should close off, e.g. by doing the substitution via
// the Doc tree's own structure instead of text matching.
const WRAPPER_OPEN_TAG = '<ol data-mojo-wrapper>';
const WRAPPER_CLOSE_TAG = '</ol>';

// A second, distinct wrapper used only around a single own-line `PlainMarker` (see `registerMarker`)
// - it needs the same "look like a real element so HTML preserves my own-line placement" trick as
// the content wrapper above, but *without* the extra indent level: unlike a Block's content, which
// really is nested one level deeper than its markers, a bare marker's own line shouldn't move at
// all. `</ol>` is shared as the closing tag for both (closing tags never carry attributes to
// disambiguate with), so `stripWrappersAndSubstitute` matches them up with a small stack instead of
// by text alone, and cancels out exactly the one indent level HTML added for this wrapper's content.
const MARKER_WRAPPER_OPEN_TAG = '<ol data-mojo-marker>';

// A third wrapper, nested directly inside the content wrapper around every Block's content (not just
// own-line markers - see `flush` below). Works around a specific quirk of `ul`/`ol`/`table`/`select`'s
// unconditional-multiline forcing: when one of their *direct* children is an inline element glued
// (no separating whitespace) to trailing bare text - `<i><%= $points %> Points</i>:` - prettier's HTML
// printer splits the closing tag mid-delimiter (`</i` on one line, `>:` on the next) even when the
// content trivially fits on one line (reproduces at any printWidth, so it isn't a fits decision). A
// block-level real element sidesteps this (verified empirically against every existing content shape:
// bare block tags, nested Blocks, the own-line marker wrapper) without `<ol>`'s "unconditional" quirk -
// unlike an unrecognized/inline element (e.g. `<span>`), it also doesn't pad short collapsed content
// with extra spaces. `<address>` specifically (rather than a common tag like `<div>`) minimizes the
// chance of colliding with a real tag the template already uses: unlike the ol-based wrappers above,
// which `<ol>`'s unconditional forcing guarantees always land alone on their own output line (so a
// whole-line match is unambiguous), this one can collapse onto the same line as its content when short
// enough to fit - so `stripWrappersAndSubstitute` has to strip its tag text out of a line rather than
// only ever dropping whole lines, and a same-named genuine tag collapsed onto that same line would be
// stripped right along with it.
const CONTENT_INNER_OPEN_TAG = '<address data-mojo-inner>';
const CONTENT_INNER_CLOSE_TAG = '</address>';

// An own-line marker that's syntactically complete in isolation - tag-form (`<% %>`/`<%= %>`/
// `<%== %>`, always terminated by an explicit `%>`/`=%>`) or `%=`/`%==` percent-lines (always
// terminated by end-of-line, since Mojo::Template has no way to continue an "auto-output"
// percent-line onto a next line) - gets `reformat` populated so `stripWrappersAndSubstitute` knows to
// run it through `perltidy`. Bare `%` lines and structural markers are excluded: a bare `%` line can
// legitimately be one piece of a Perl statement that continues across several consecutive `%`-lines
// (`% my $var` / `% = 'value';`), and structural markers are fragments of a larger `{`/`}`/`begin`/
// `end` chain - neither is safe to reformat as an isolated, one-node unit the way this pass does.
interface MarkerInfo {
    text: string;
    reformat?: { prefix: string; body: string; suffix: string };
}

// Splits a reformat-eligible own-line `PlainMarker`'s raw text into its delimiter and body, or
// returns `undefined` for a shape this phase doesn't handle (a bare `%` line, or anything malformed).
const splitMarkerDelimiters = (text: string): { prefix: string; body: string; suffix: string } | undefined => {
    if (text.startsWith('<%')) {
        const prefix = text.startsWith('<%==') ? '<%==' : text.startsWith('<%=') ? '<%=' : '<%';
        const rest = text.slice(prefix.length);
        const suffix = rest.endsWith('=%>') ? '=%>' : rest.endsWith('%>') ? '%>' : undefined;
        return suffix ? { prefix, body: rest.slice(0, rest.length - suffix.length).trim(), suffix } : undefined;
    }
    if (text.startsWith('%=')) {
        const prefix = text.startsWith('%==') ? '%==' : '%=';
        return { prefix, body: text.slice(prefix.length).trim(), suffix: '' };
    }
    return undefined;
};

interface Skeleton {
    skeleton: string;
    markers: MarkerInfo[];
}

// Builds a plain-HTML "skeleton" string standing in for the whole template: every Mojo marker
// (OpenMarker/CloseMarker/MidMarker/PlainMarker) becomes a unique placeholder token, and everything
// that sits between a Block's markers gets wrapped in the synthetic element above. Feeding this to
// prettier's real HTML parser/printer as a single combined parse (rather than one `embed()` call per
// fragment) is what lets it correctly match up tags that span across Mojo markers (an opening `<ul>`
// and its `</ul>` in a later fragment, etc).
const buildSkeleton = (programNode: MojoNode): Skeleton => {
    // The full original source text (the Program node's own slice is the whole file), used to check
    // whether a marker sits alone on its own source line - see `isOwnLine` below.
    const source = programNode.text;
    const markers: MarkerInfo[] = [];
    let skeleton = '';
    let counter = 0;

    // True if nothing but horizontal whitespace separates `node` from the newlines (or file
    // boundaries) on either side of it - i.e. the user wrote it alone on its own line, as opposed to
    // embedded inline with surrounding text (`Hello, <%= $name %>!`).
    const isOwnLine = (node: MojoNode): boolean => {
        let i = node.start - 1;
        while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
        let j = node.end;
        while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
        return (i < 0 || source[i] === '\n') && (j >= source.length || source[j] === '\n');
    };

    const registerMarker = (node: MojoNode) => {
        const id = counter++;
        const ownLine = isOwnLine(node);
        const reformat = node.type === 'PlainMarker' && ownLine ? splitMarkerDelimiters(node.text) : undefined;
        markers[id] = { text: node.text, reformat };
        // Pad the placeholder out to (roughly) the real marker text's length so prettier's HTML
        // printer makes the same line-wrap/fits decisions it would make with the real text - not
        // "this short token obviously fits on one line", which was silently collapsing e.g.
        // `<div><%= a fairly long expression %></div>` onto one line before this text is
        // substituted back in and turns out not to fit at all. For a marker that's itself multi-line,
        // only the first line's length is used: the real text will force its own line breaks once
        // substituted back in regardless of what surrounding elements decided, and padding out to the
        // *total* character count (across every line) would wildly overstate how long any single
        // rendered line actually is.
        const firstLine = node.text.split('\n', 1)[0];
        const overhead = MARKER_OPEN.length + id.toString().length + MARKER_CLOSE.length;
        const padding = MARKER_PAD.repeat(Math.max(0, firstLine.length - overhead));
        const placeholder = `${MARKER_OPEN}${id.toString()}${padding}${MARKER_CLOSE}`;

        // A bare placeholder is just plain text as far as HTML is concerned, and prettier's HTML
        // printer reflows plain text to fit the available width regardless of how it looked in the
        // source - unlike a real element, whose original single-line-vs-multi-line placement it
        // preserves. A `PlainMarker` (an expression tag, not part of any `{`/`begin` nesting) that the
        // user wrote alone on its own line - e.g. `<%= file_field ... =%>` as a `<div>`'s only child -
        // needs that same "respect how I wrote it" treatment, which means it needs to look like a real
        // element to HTML: wrapping it forces it to keep its own line the same way real markup would.
        // Structural markers (Open/Mid/Close) don't need this: their own-line separation from sibling
        // content is already handled by the empty-wrapper-separator logic in `visitSequence` below.
        skeleton +=
            node.type === 'PlainMarker' && ownLine
                ? `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`
                : placeholder;
    };

    // A run of sibling nodes - either a Block's whole child list, or the content between two of a
    // Block's markers. A `Text` node here that's nothing but whitespace spanning a newline is purely
    // structural (there to preserve line breaks/blank lines between Mojo markers that don't
    // themselves sit inside any real HTML tag), and by construction of the tokenizer can only occur
    // adjacent to markers/blocks in the first place (a real HTML-to-HTML gap never becomes its own
    // Text node - it stays part of one continuous run). Left alone, prettier's HTML printer treats
    // such a run as ordinary reflowable prose and collapses every line onto one, so an empty wrapper
    // is spliced in to anchor the boundary - it's dropped again during substitution, contributing
    // nothing to the final output but forcing HTML to preserve the surrounding line breaks.
    const visitSequence = (nodes: MojoNode[]) => {
        for (const node of nodes) {
            if (node.type === 'Text') {
                skeleton += node.text;
                if (node.text.trim() === '' && node.text.includes('\n')) {
                    skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
                }
                continue;
            }
            visitNode(node);
        }
    };

    const visitNode = (node: MojoNode) => {
        if (node.type === 'Block') {
            let group: MojoNode[] = [];
            const flush = () => {
                if (group.length === 0) return;
                skeleton += WRAPPER_OPEN_TAG + CONTENT_INNER_OPEN_TAG;
                visitSequence(group);
                skeleton += CONTENT_INNER_CLOSE_TAG + WRAPPER_CLOSE_TAG;
                group = [];
            };

            for (const child of node.children) {
                if (isStructuralMarker(child.type)) {
                    flush();
                    registerMarker(child);
                } else {
                    group.push(child); // Text, PlainMarker, or a nested Block
                }
            }
            flush();
            return;
        }

        // PlainMarker (wherever it occurs), or a structural marker directly at the Program level.
        registerMarker(node);
    };

    visitSequence(programNode.children);

    return { skeleton, markers };
};

const MARKER_RE = new RegExp(`${MARKER_OPEN}(\\d+)${MARKER_PAD}*${MARKER_CLOSE}`, 'g');

// Substitutes marker placeholders back to their real Perl text on a single already-indented output
// line. Only the marker's first line gets the surrounding indent prepended; a multi-line marker's
// continuation lines are left exactly as originally written, preserving whatever relative
// indentation the user themselves already gave their own multi-line Perl expression rather than
// flattening it to a uniform re-indent - this project doesn't understand Perl syntax well enough to
// re-derive that indentation correctly itself (that's the eventual job of a real `perltidy` pass).
const substituteMarkers = (line: string, markers: MarkerInfo[]): string =>
    line.replace(MARKER_RE, (_, id: string) => markers[Number(id)].text);

// Matches a line whose content (already stripped of wrapper tags) is *entirely* one marker
// placeholder and nothing else - the shape every own-line marker's dedicated line always has, thanks
// to the `MARKER_WRAPPER_OPEN_TAG`/content-wrapper mechanisms above guaranteeing isolation. Used to
// gate the `perltidy` reformatting path below, so it never fires for a marker embedded inline with
// other text on the same line.
const SOLE_MARKER_RE = new RegExp(`^${MARKER_OPEN}(\\d+)${MARKER_PAD}*${MARKER_CLOSE}$`);

// Walks the fully-formatted HTML skeleton line by line: a line that (once trimmed) is exactly one of
// the wrapper tags is pure scaffolding and is dropped outright. For the content wrapper, no manual
// depth bookkeeping is needed to get its content indented one level deeper, since `<ol>` is a real
// HTML element and prettier's own HTML formatter already indents an element's children relative to
// it (and does so again for each further level of *nested* blocks, since each is its own nested
// `<ol>`), exactly like it would for any other element - but the *marker* wrapper needs that one
// level of indent it also picked up canceled back out again (see its definition above), tracked via
// a small stack since both wrappers share the same `</ol>` closing text. Every other line is left
// exactly as HTML formatted it, with only its marker placeholders substituted back in.
interface PerltidyContext {
    perltidyrcPath: string | undefined;
    useTabs: boolean;
    tabWidth: number;
    printWidth: number;
}

const stripWrappersAndSubstitute = async (
    formatted: string,
    markers: MarkerInfo[],
    indentUnit: string,
    perltidyContext: PerltidyContext
): Promise<string> => {
    const lines = formatted.split('\n');
    const output: string[] = [];
    const stack: ('content' | 'marker' | 'inner')[] = [];

    const emptySeparator = WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === emptySeparator) continue; // empty content-wrapper separator, collapsed onto one line
        if (trimmed === WRAPPER_OPEN_TAG) {
            stack.push('content');
            continue;
        }
        if (trimmed === MARKER_WRAPPER_OPEN_TAG) {
            stack.push('marker');
            continue;
        }
        if (trimmed === CONTENT_INNER_OPEN_TAG) {
            stack.push('inner');
            continue;
        }
        if (trimmed === WRAPPER_CLOSE_TAG || trimmed === CONTENT_INNER_CLOSE_TAG) {
            stack.pop();
            continue;
        }

        // Unlike the ol-based wrappers above (always forced onto their own line by <ol>'s
        // unconditional-multiline behavior), <div data-mojo-inner> is an ordinary element and can
        // collapse onto the same line as its content when that's short enough to fit - in which case
        // it never added a separate indent level to cancel, so just strip its tag text in place
        // rather than touching the stack.
        let content = trimmed;
        if (content.includes(CONTENT_INNER_OPEN_TAG) || content.includes(CONTENT_INNER_CLOSE_TAG)) {
            content = content.split(CONTENT_INNER_OPEN_TAG).join('').split(CONTENT_INNER_CLOSE_TAG).join('');
        }

        // Each currently-open 'inner'/'marker' wrapper added one indent level HTML would otherwise
        // keep (only 'content' levels are genuine Block nesting and should be preserved) - an own-line
        // PlainMarker nests both at once (content -> inner -> marker), so both must be canceled, not
        // just the innermost.
        const cancelLevels = stack.filter((entry) => entry === 'marker' || entry === 'inner').length;
        let indent = line.slice(0, line.length - line.trimStart().length);
        // One `indentUnit` per level, not `cancelLevels * indentUnit.length` characters sliced off the
        // end - with `useTabs`, HTML indents by one literal tab character per level regardless of
        // `tabWidth` (which only controls how wide a tab is *displayed*, not how many characters one
        // indent level consumes), so slicing by character count would strip the wrong amount.
        for (let i = 0; i < cancelLevels && indent.startsWith(indentUnit); i++)
            indent = indent.slice(indentUnit.length);

        // A line that's *entirely* one reformat-eligible marker's placeholder (see `SOLE_MARKER_RE`
        // and `MarkerInfo`) gets run through `perltidy` instead of the plain text substitution below.
        // `depth` (how many `indentUnit`s deep this marker's own line sits) drives the brace-wrapping
        // trick in `runPerltidy` that makes perltidy's own indentation/line-wrapping account for the
        // surrounding HTML structure - see CLAUDE.local.md and src/mojo/perltidy.ts.
        const soleMatch = SOLE_MARKER_RE.exec(content);
        const marker = soleMatch ? markers[Number(soleMatch[1])] : undefined;
        if (marker?.reformat) {
            const { prefix, body, suffix } = marker.reformat;
            const depth = indentUnit.length === 0 ? 0 : indent.length / indentUnit.length;
            const perltidyLines = await runPerltidy(body, {
                configPath: perltidyContext.perltidyrcPath,
                depth,
                useTabs: perltidyContext.useTabs,
                tabWidth: perltidyContext.tabWidth,
                printWidth: perltidyContext.printWidth
            });
            // A percent-line (`%=`/`%==`) marker can never safely become multi-line - Mojo::Template
            // only treats a line as Perl if it starts with `%`, so a continuation line without one
            // would be parsed as literal HTML output - so that combination is treated the same as a
            // failed `perltidy` run: fall through to the raw-passthrough substitution below.
            const isPercentForm = prefix.startsWith('%');
            if (perltidyLines && !(isPercentForm && perltidyLines.length > 1)) {
                const suffixPart = suffix ? ` ${suffix}` : '';
                if (perltidyLines.length === 1) {
                    output.push(`${indent}${prefix} ${perltidyLines[0]}${suffixPart}`);
                } else {
                    // Only the first line needs `indent` prepended (its own copy was stripped by
                    // `runPerltidy` so it could be glued onto the delimiter instead) and the closing
                    // delimiter is synthetic, not part of perltidy's output at all - every other line
                    // already carries its full real indentation, `depth` levels deep, courtesy of the
                    // brace-wrapping `runPerltidy` did; prepending `indent` again would double it.
                    output.push(`${indent}${prefix} ${perltidyLines[0]}`);
                    output.push(...perltidyLines.slice(1));
                    output.push(`${indent}${suffix}`);
                }
                continue;
            }
        }

        output.push(line === '' ? '' : indent + substituteMarkers(content, markers));
    }

    return output.join('\n');
};

// print() is effectively unreachable: embed() below fully handles the root (Program) node, and
// prettier never needs to fall back to printing children individually.
export const printMojoNode = (path: AstPath<MojoNode>): Doc => path.node.text;

export const embed = (path: AstPath<MojoNode>, options: Options) => {
    if (path.node.type !== 'Program') return null;

    return async (textToDoc: (text: string, opts: Options) => Promise<Doc>): Promise<Doc> => {
        const { skeleton, markers } = buildSkeleton(path.node);
        const htmlDoc = await textToDoc(skeleton, { parser: 'html' });
        // By the time prettier actually calls embed(), `options` is the fully-resolved options
        // object (every field populated with its default), even though the declared `Options` type
        // (used for user-facing partial overrides) marks them all optional.
        const { formatted } = doc.printer.printDocToString(
            htmlDoc,
            options as unknown as Parameters<typeof doc.printer.printDocToString>[1]
        );
        const tabWidth = options.tabWidth ?? 2;
        const indentUnit = options.useTabs ? '\t' : ' '.repeat(tabWidth);
        // Searched once per file (walking upward from the template's own directory, not relying on
        // perltidy's own cwd-only/home-dir discovery) rather than once per marker - see
        // src/mojo/perltidy.ts for why.
        const perltidyrcPath = findPerltidyrc(dirname(options.filepath ?? process.cwd()));
        const result = await stripWrappersAndSubstitute(formatted, markers, indentUnit, {
            perltidyrcPath,
            useTabs: options.useTabs ?? false,
            tabWidth,
            printWidth: options.printWidth ?? 80
        });
        return `${result}\n`;
    };
};
