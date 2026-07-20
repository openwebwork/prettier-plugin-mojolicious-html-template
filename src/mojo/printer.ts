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
// Stands in for a `\` that was glued (no whitespace at all) directly to whatever preceded it in the
// source - see `withBackslashContinuationAnchors`'s own comment for why this needs to be distinguished
// from an ordinary, already-isolated backslash line.
const GLUED_BACKSLASH_SENTINEL = String.fromCharCode(0xe003);
// Stands in for a single ordinary space that must not become a line-break opportunity during this
// pass - see `registerMarker`'s "reflow can't be allowed to strand an inline marker alone on its own
// line" comment for why this exists. Restored to a literal space (never left in the rendered output)
// by `stripWrappersAndSubstitute`.
const NO_BREAK_SENTINEL = String.fromCharCode(0xe004);
// Marks the position immediately after a `<pre ...>` tag whose own content doesn't already start with
// a real newline - see the comment on its insertion (near `PRE_OPEN_TAG_RE`) for why prettier's own
// `<pre>` handling needs this flagged and undone in `stripWrappersAndSubstitute`.
const PRE_GLUE_SENTINEL = String.fromCharCode(0xe005);
// Marks a `PlainMarker` glued (no whitespace) directly to a real HTML tag's own `>` on its preceding
// side - see `precededByRealTagBoundary`'s own comment for why this needs its own protection distinct
// from `NO_BREAK_SENTINEL`.
const TAG_GLUE_SENTINEL = String.fromCharCode(0xe006);

// `<ol data-mojo-wrapper>` rather than a made-up tag name: prettier's HTML printer's own source
// (the `tr()` helper in its HTML plugin) only forces an element's children onto their own indented
// lines unconditionally for an exact, hardcoded set of tags - `html`, `head`, `ul`, `ol`, `select`, and
// anything whose CSS display starts with `table` (`table` itself, `caption`, `colgroup`, `thead`,
// `tbody`, `tfoot`, `tr` - but not `td`/`th`, which are `table-cell`). An unrecognized custom tag is
// treated as ordinary content and collapses onto one line whenever it's short enough to fit, which is
// wrong for Perl control-flow blocks that should always get their own line regardless of width.
//
// `<ol>` was the original choice, but HTML5 defines a `<p>` as implicitly closed by a number of its
// potential children - `address`/`div`/`ol`/`table`/`ul` among them - so a Mojo construct sitting
// inside a real `<p>` (an extremely ordinary thing to write) made prettier's own HTML parser see
// `<p>...<ol data-mojo-wrapper>...` and silently end the `<p>` right there, turning the template's own
// later `</p>` into a genuine parse error (found against a real template, `exception_default.html.ep`:
// this made `embed()`'s `textToDoc()` call throw, which prettier's plugin system catches and silently
// falls back to printing the whole file's raw, unformatted source unchanged - no visible exception,
// just a silent no-op format). `<select>` was tried next, since it isn't on that implied-end-tag list -
// but it turned out to have its own problem, found by running the full fixture suite against it: unlike
// `ol`/`ul`/`table` (all genuinely block-level), `select`'s *default* CSS display is `inline-block`
// (per the same prettier source), so while it still forces its own *children* onto their own lines, it
// doesn't force *itself* onto a line separate from a glued sibling the way a true block element does -
// verified directly: `<div>text{<select data-x>content</select>}more</div>` formats with `<select>`
// left glued onto `text{`, splitting its own closing tag mid-delimiter, whereas the same markup with
// `ol`/`ul`/`table` correctly separates everything onto its own line. Since our own synthetic wrapper
// routinely gets spliced in glued to whatever came right before it in the skeleton (a structural
// marker's own bare, unwrapped placeholder text, for instance), this broke real content everywhere a
// wrapper followed one of those directly. `colgroup`/`caption`/`thead`/`tbody`/`tfoot`/`tr` are the only
// remaining candidates: genuinely block-level (so they self-separate from siblings, verified the same
// way), not on `<p>`'s implied-end-tag list (verified), and don't get relocated even when nested inside
// a real `<table>`/`<td>` in a position that would be structurally illegal for them there (verified -
// prettier's HTML parser doesn't enforce table content-model/foster-parenting rules the strict way a
// browser would, matching how it's always tolerated arbitrary content inside `<ol>`, whose own real
// content model is `<li>`-only, without complaint). `colgroup` specifically (over `caption`/`tbody`/`tr`,
// which are all extremely common in real tables) was chosen for the lowest collision risk with genuine
// template content: its real-world content model is just self-closing `<col>` tags, so a template
// author writing substantive content inside a `<colgroup>...</colgroup>` - the shape that would collide
// with our own usage - essentially never happens (confirmed against every real webwork2 template: only
// one uses `<colgroup>` at all, and only for its ordinary `<col>` styling purpose). The
// `data-mojo-wrapper` attribute keeps the *opening* tag unambiguous from a real `<colgroup>` the
// template's own HTML might contain; the closing `</colgroup>` is still just plain text, so a genuine
// `<colgroup>...</colgroup>` elsewhere in the template is a collision risk with this approach -
// handled below by `classifyWrapperCloses`, the same way an unrelated `<ol>` used to need handling
// before this tag switched (twice).
const WRAPPER_OPEN_TAG = '<colgroup data-mojo-wrapper>';
const WRAPPER_CLOSE_TAG = '</colgroup>';

// A second, distinct wrapper used only around a single own-line `PlainMarker` (see `registerMarker`)
// - it needs the same "look like a real element so HTML preserves my own-line placement" trick as
// the content wrapper above, but *without* the extra indent level: unlike a Block's content, which
// really is nested one level deeper than its markers, a bare marker's own line shouldn't move at
// all. `</colgroup>` is shared as the closing tag for both (closing tags never carry attributes to
// disambiguate with), so `stripWrappersAndSubstitute` matches them up with a small stack instead of
// by text alone, and cancels out exactly the one indent level HTML added for this wrapper's content.
const MARKER_WRAPPER_OPEN_TAG = '<colgroup data-mojo-marker>';

// A third wrapper, nested directly inside the content wrapper around every Block's content (not just
// own-line markers - see `flush` below). Works around a specific quirk of the outer wrapper's
// unconditional-multiline forcing: when one of their *direct* children is an inline element glued
// (no separating whitespace) to trailing bare text - `<i><%= $points %> Points</i>:` - prettier's HTML
// printer splits the closing tag mid-delimiter (`</i` on one line, `>:` on the next) even when the
// content trivially fits on one line (reproduces at any printWidth, so it isn't a fits decision). A
// block-level real element sidesteps this (verified empirically against every existing content shape:
// bare block tags, nested Blocks, the own-line marker wrapper) without the outer wrapper's
// "unconditional" quirk - unlike an unrecognized/inline element (e.g. `<span>`), it also doesn't pad
// short collapsed content with extra spaces. `<address>` specifically (rather than a common tag like
// `<div>`) minimizes the chance of colliding with a real tag the template already uses: unlike the
// outer wrapper above, which the containing element's unconditional forcing guarantees always lands
// alone on its own output line (so a whole-line match is unambiguous), this one can collapse onto the
// same line as its content when short enough to fit - so `stripWrappersAndSubstitute` has to strip its
// tag text out of a line rather than only ever dropping whole lines, and a same-named genuine tag
// collapsed onto that same line would be stripped right along with it. Always nested *inside* the outer
// wrapper (see `flush` below), never a direct child of whatever real element contains the Block, so
// `<address>` being on `<p>`'s own implied-end-tag list (`<ol>` was too, though `<colgroup>` isn't)
// doesn't matter here - that rule only triggers on an element's *direct* children, not arbitrarily
// deep descendants.
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
    region?: { body: string };
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

// A bare `%` line with real Perl content after it - not tag-form, not `%=`/`%==` (the two mutually
// exclusive with this: both are always recognized by `splitMarkerDelimiters`, so "PlainMarker, starts
// with `%`, and `splitMarkerDelimiters` returned nothing" is exactly "bare `%` line"), and not a
// content-free `%`-alone line either (see `isBlankPercentLine` - handled separately, since it isn't
// really Perl *code*, just a blank-line marker Mojolicious happens to require a literal `%` on).
const isBarePercentLine = (node: MojoNode): boolean =>
    node.type === 'PlainMarker' &&
    node.text.startsWith('%') &&
    splitMarkerDelimiters(node.text) === undefined &&
    node.text.trim() !== '%';

// A `%`-alone line (nothing but the control marker itself, no code after it - possibly with trailing
// whitespace on the line, which `.trim()` absorbs). Mojolicious requires the literal `%` even on an
// otherwise-blank line for it to read as "this is Perl, not template output", so this is this
// templating format's equivalent of an ordinary blank line between statements - not a run-anchoring
// member of a region (see `isEligibleRegionMember`), but a connector like whitespace `Text`: it can sit
// *inside* a region (contributing a blank line, `flattenNode` below) without being what makes a region
// eligible in the first place, and outside one it should render completely unchanged, which is exactly
// what leaving it to the ordinary `registerMarker` passthrough path already does.
const isBlankPercentLine = (node: MojoNode): boolean => node.type === 'PlainMarker' && node.text.trim() === '%';

// Collapses a run of 2+ consecutive `isBlankPercentLine` siblings (interspersed only by whitespace
// `Text`) down to just the first one, matching how prettier collapses multiple blank lines elsewhere
// and how `perltidy`'s own `-mbl` does for ordinary Perl. This can't be left to the perltidy/region path
// alone (`flattenNode`'s blank-line contribution, collapsed by `perltidy`'s own blank-line settings when
// a run happens to land *inside* an eligible region) because a run of blank lines is just as often *not*
// part of any region at all - e.g. sitting right before a `Block` that's ineligible only because its
// content happens to include a tag-form marker - in which case each blank line renders independently via
// the ordinary per-node passthrough path, with nothing to deduplicate them against each other. Applied
// once, up front, in `visitSequence`, before any region-scanning or per-node handling happens, so both
// paths just see an already-collapsed node list and need no awareness of this at all.
const collapseBlankPercentRuns = (nodes: MojoNode[]): MojoNode[] => {
    const result: MojoNode[] = [];
    let i = 0;
    while (i < nodes.length) {
        const node = nodes[i];
        if (!isBlankPercentLine(node)) {
            result.push(node);
            i++;
            continue;
        }
        result.push(node);
        let j = i + 1;
        // Keep scanning past further blank lines (dropping them) and the whitespace connecting them,
        // but remember the most recent connector seen so there's still a valid separator between the
        // surviving line and whatever comes next once the run ends.
        let trailingConnector: MojoNode | undefined;
        while (j < nodes.length) {
            const next = nodes[j];
            if (next.type === 'Text' && next.text.trim() === '') {
                trailingConnector = next;
                j++;
            } else if (isBlankPercentLine(next)) {
                j++;
            } else {
                break;
            }
        }
        if (trailingConnector) result.push(trailingConnector);
        i = j;
    }
    return result;
};

// A closing HTML tag immediately followed by something that's neither whitespace nor the start of
// another tag - the shape that triggers the outer wrapper's mid-tag-split quirk (see
// `CONTENT_INNER_OPEN_TAG`).
const GLUED_CLOSE_TAG_RE = /<\/[a-zA-Z][\w-]*>(?=[^\s<])/;

// True if a Block's content (`group` in `flush` below) contains the specific pattern
// `CONTENT_INNER_OPEN_TAG`/`<address data-mojo-inner>` exists to work around: a real HTML closing tag
// glued (no whitespace) to bare trailing content. Builds a lightweight flattened string - `Text` nodes
// contribute their raw text verbatim, every `PlainMarker`/nested `Block` contributes a single opaque
// non-whitespace placeholder character, since a marker glued directly to a closing tag is exactly as
// risky as bare text would be - and tests it against `GLUED_CLOSE_TAG_RE`. Deliberately whole-group
// rather than scoped to only direct children of the eventual outer wrapper: a nested `Block` is treated the
// same as a marker (opaque, assumed risky if glued) rather than trying to reason about whether the
// quirk can propagate through one, since erring toward *keeping* the protection in an ambiguous case
// only costs one indent level, while erring the other way reintroduces the mid-tag-split bug.
const needsGluedTagProtection = (nodes: MojoNode[]): boolean =>
    GLUED_CLOSE_TAG_RE.test(nodes.map((node) => (node.type === 'Text' ? node.text : 'X')).join(''));

// True if `node` is a `Block` whose entire content - recursively - is nothing but bare `%` lines and
// whitespace: every structural marker (Open/Mid/Close) is itself a bare `%` line (not tag-form), every
// `PlainMarker` child is a bare `%` line, every `Text` child is whitespace-only, and every nested
// `Block` child is itself fully pure. A single tag-form marker, `%=`/`%==` marker, or literal
// non-whitespace HTML text anywhere inside - at any depth - disqualifies the *whole* enclosing `Block`,
// since reconstructing it into one balanced Perl program (`flattenNode` below) requires every piece of
// its content to actually be Perl.
const isPureBlock = (node: MojoNode): boolean =>
    node.type === 'Block' &&
    node.children.every((child) => {
        if (isStructuralMarker(child.type)) return child.text.startsWith('%') && !child.text.startsWith('<%');
        if (child.type === 'Text') return child.text.trim() === '';
        if (child.type === 'PlainMarker') return isBarePercentLine(child) || isBlankPercentLine(child);
        if (child.type === 'Block') return isPureBlock(child);
        return false;
    });

// A node that's safe to fold into a "pure-Perl region" (see `registerRegion`) alongside its adjacent
// siblings: a lone bare `%` line, or a whole `Block` that's fully pure per `isPureBlock`. Whichever it
// is, it's guaranteed syntactically complete once every other member of its region is included too -
// see the "reconstruct, tidy, re-split" reasoning in CLAUDE.local.md.
const isEligibleRegionMember = (node: MojoNode): boolean => isBarePercentLine(node) || isPureBlock(node);

// A node whose own-line placement is enforced by the whitespace-anchor mechanism in `visitSequence`
// below, rather than by being wrapped in a real element the way an own-line `PlainMarker` is (see
// `MARKER_WRAPPER_OPEN_TAG` above and `registerMarker`'s `ownLine` handling) - a bare `%` line, or a
// `Block` (whose first child is always a `%`-based `OpenMarker`, registered via `registerMarker`
// without any such wrapping - see `visitNode`). Verified empirically that a real element (`<colgroup>`) never
// needs this protection even with no anchor at all - it stays correctly separated from preceding
// sibling text on its own - but a bare, unwrapped placeholder (what a structural marker's `registerMarker`
// call produces) does not, and merges onto the same line as preceding text given only a single newline
// between them.
const needsOwnLineAnchor = (node: MojoNode): boolean => node.type === 'Block' || isBarePercentLine(node);

// Mojo::Template gives literal template text a line-continuation marker: a text line ending in `\`
// has its own trailing newline suppressed in the *rendered output*, joining directly with whatever
// comes next with no newline and no substitute whitespace in its place - used to avoid stray blank
// lines/whitespace showing up around a control-only tag that produces no visible output of its own
// (`<% if (...) { =%>\`/`<% } =%>\`, immediately above and below the real content, in a real template).
// This is a purely-output-time behavior tied to the *source* actually being split across two physical
// lines there - but a `\` followed by a newline, sitting in the middle of an ordinary `Text` node's
// content, means nothing to HTML at all (just an ordinary character followed by ordinary whitespace),
// so left alone, prettier's HTML reflow treats it exactly like plain reflowable prose and can join it
// onto the same line as whatever comes right before or after it, replacing that newline with a single
// space (found against a real template, `exception_default.html.ep`: `<% } =%>\` followed by a new
// physical line of text came out as `<% } =%>\ , including...` all on one line). That's not merely
// cosmetic: once the `\` is no longer the last character of its own physical line, there is no longer
// a newline there for Mojo::Template's line-continuation rule to suppress in the first place, so the
// rendered output's whitespace at that point silently changes too. Splices the same empty-separator
// anchor already used elsewhere in this file in immediately after every `\<newline>` found anywhere
// within a `Text` node's own content (not just at its very end - a single node can contain more than
// one physical line, and each one needs this independently), forcing everything after it onto its own
// line the same way `WRAPPER_OPEN_TAG`/`WRAPPER_CLOSE_TAG` already do for marker/Block boundaries.
//
// That anchor alone isn't enough when the `\` is itself glued (no whitespace at all) directly to
// whatever *precedes* it, though - a real HTML tag boundary right before it (a multi-line-wrapped
// tag's own closing `>`, or a plain closing tag like `</div>`) gets separated from the `\` onto its own
// line by prettier's HTML printer regardless of the `\` itself, the same structural
// forcing/attribute-wrapping logic that puts those tags on their own line in ordinary HTML with no
// Mojo involved at all (verified directly: `<div>\n\tcontent\n</div>\` - a plain closing tag glued to a
// trailing `\` with zero Mojo markers anywhere - already separates them). Two genuinely different
// source shapes produce a lone `\`-only line in the *formatted* output, though, and they don't mean the
// same thing: one where the `\` was glued to preceding content (no newline at all belongs between them
// - splitting it here manufactures a newline in the rendered output that was never there originally),
// and one where the author deliberately wrote `\` as its own, already-isolated physical line (a real
// newline *does* belong between whatever precedes it and whatever follows - collapsing that would
// delete a newline the author actually wanted). Only the first case is a bug to fix; merging the second
// back onto the previous line would introduce the exact same class of "changes the actual rendered
// output" bug this whole mechanism exists to prevent. `GLUED_BACKSLASH_SENTINEL` stands in for the `\`
// specifically when it's glued (checked via the character immediately preceding the match, `\s` versus
// not, using a replacer *function* rather than a static string so that check has access to it) - an
// ordinary, un-special PUA character that travels safely through prettier's reflow either way (nothing
// to HTML), letting `stripWrappersAndSubstitute` later tell the two shapes apart: a lone *sentinel*
// line unambiguously means "this was glued and needs re-merging onto the previous line", while a lone
// literal `\` line (never touched here, since it wasn't glued in the source) is left as the deliberate,
// isolated line it always was.
const BACKSLASH_NEWLINE_RE = /\\\n/g;
const withBackslashContinuationAnchors = (text: string): string =>
    text.replace(BACKSLASH_NEWLINE_RE, (match, offset: number) => {
        const precedingChar = offset > 0 ? text[offset - 1] : undefined;
        const isGlued = precedingChar !== undefined && !/\s/.test(precedingChar);
        const backslashText = isGlued ? GLUED_BACKSLASH_SENTINEL : '\\';
        return `${backslashText}\n${WRAPPER_OPEN_TAG}${WRAPPER_CLOSE_TAG}`;
    });

// Whether `skeletonSoFar` (the skeleton built up to just before the point being checked) currently has
// an unclosed `<pre>` - a plain open/close count, not a real parser, but adequate here the same way
// `classifyWrapperCloses` elsewhere in this file also settles for a count-based approach rather than a
// full HTML parse: a `<pre>` genuinely nested inside another `<pre>` isn't valid HTML in the first
// place. Needed because `withBackslashContinuationAnchors`'s anchor is actively harmful inside `<pre>`:
// unlike ordinary content, `<pre>`'s whitespace is significant, so prettier's HTML printer doesn't
// reformat/reindent it at all - an anchor spliced in there never lands on its own line the way it does
// everywhere else, and its literal tag text leaks straight into the rendered output instead of being
// stripped (found immediately after landing the backslash-continuation fix above, against the exact
// `<pre>` this project already knows has a separate, unrelated indentation bug: `<pre><% =%>\` followed
// by more marker/text content). The anchor turns out to be unnecessary inside `<pre>` anyway - verified
// directly that a bare `\<newline>` with no anchor at all survives untouched there, since whitespace
// significance already does the job the anchor exists to do everywhere else.
const PRE_OPEN_TAG_RE = /<pre(?:\s[^<>]*)?>/g;
const PRE_CLOSE_TAG_RE = /<\/pre>/g;
const isInsidePre = (skeletonSoFar: string): boolean => {
    const opens = skeletonSoFar.match(PRE_OPEN_TAG_RE)?.length ?? 0;
    const closes = skeletonSoFar.match(PRE_CLOSE_TAG_RE)?.length ?? 0;
    return opens > closes;
};

// Independent of the anchor-suppression above: prettier's HTML printer unconditionally prepends a
// literal newline to a `<pre>` element's own content whenever that content spans multiple lines and
// doesn't *already* start with one - regardless of Mojo, regardless of any anchor, and regardless of
// whether the content was glued directly to the opening tag's `>` or merely started with a plain space
// (verified directly against plain HTML: `<pre> ZZZ\ntext</pre>` and `<pre>ZZZ\ntext</pre>` both come
// back as `<pre>\n ZZZ\ntext</pre>` / `<pre>\nZZZ\ntext</pre>` - prettier adds the newline either way,
// but leaves a genuine `<pre>\nZZZ...` completely untouched, since it already satisfies the rule). This
// inserted newline is harmless for actual rendering - browsers already strip a newline immediately
// after `<pre>`/`<textarea>` per the HTML spec - but it silently changes the *template's own source
// text*, and `stripWrappersAndSubstitute`'s `insidePreContent` tracking (which assumes the `<pre ...>`
// line's own structure is exactly what the source had) then preserves that changed structure verbatim,
// one line down, at whatever indentation prettier's inserted break happened to leave it (none at all -
// prettier's own inserted newline carries no indentation of its own, since adding any would actually
// change the rendered `<pre>` content, unlike the newline itself). Found against a real template,
// `SampleProblemViewer/sample_problem.html.ep`: `<pre class="...">` immediately followed by `<% =%>\`
// (glued, matching the source exactly) came back as `<pre class="...">` on its own line followed by a
// *second* line consisting of
// just the marker's own placeholder and backslash at column 0 - not a cosmetic quirk, but real, visible
// corruption once substituted back in.
//
// Fixed the same way as the other reflow-instability sentinels in this file: rather than trying to
// *prevent* prettier's insertion (not possible without also preventing the multi-line layout itself),
// mark every position where it's *going* to happen with `PRE_GLUE_SENTINEL` immediately after the
// `<pre ...>` tag's own `>` - prettier still inserts its newline (now landing between `>` and the
// sentinel, exactly the same way it would land between `>` and real content), but the sentinel is
// otherwise inert to HTML and travels with whatever it was glued to, letting `stripWrappersAndSubstitute`
// find it as the very first thing on the first `insidePreContent` line and merge that line straight back
// onto the `<pre ...>` line above it, undoing prettier's split entirely. Only inserted when the `<pre>`
// tag's own immediately-following character in the *source* isn't already a real newline, matching
// prettier's own trigger condition precisely - a `<pre>\ncontent` in the true source needs no help at
// all, since prettier already leaves that shape completely alone.
const insertPreGlueSentinel = (text: string): { text: string; deferredToNextNode: boolean } => {
    let deferredToNextNode = false;
    const withSentinel = text.replace(PRE_OPEN_TAG_RE, (match: string, offset: number) => {
        const matchEnd = offset + match.length;
        if (matchEnd === text.length) {
            // The tag is the very last thing in this `Text` node - whatever immediately follows it is
            // part of the *next* node (Text or Marker), not yet known here, so the sentinel has to be
            // deferred to whichever node comes next (mirrors `pendingFollowingGlue`'s own reasoning).
            deferredToNextNode = true;
            return match;
        }
        return text[matchEnd] === '\n' ? match : match + PRE_GLUE_SENTINEL;
    });
    return { text: withSentinel, deferredToNextNode };
};

// Reconstructs the real Perl source a region's nodes represent, so the whole region can be sent to
// `perltidy` as one ordinary program. Any marker with real content (bare `%` line, or a structural
// Open/Mid/Close - both are just "`%` + Perl text") contributes its text with the leading `%` stripped
// and trimmed, plus a trailing newline. A `Block` recurses through its own children directly (in
// original source order, interleaving its structural markers with their content exactly as
// `node.children` already does) - its structural markers are handled by the marker case above, so this
// doesn't register anything, just walks straight through to plain text. A whitespace-only `Text` node
// contributes one blank line if the source had a real blank line there (2+ newlines) - letting
// `perltidy`'s own blank-line settings still apply - or nothing for an ordinary line-to-line adjacency
// (a single newline); a `%`-alone line (`isBlankPercentLine`) always contributes one blank line
// unconditionally, since the user wrote it specifically as a blank-line marker (there's no "was it
// really blank" ambiguity the way there is for `Text`, which can't help spanning at least one newline
// just by sitting between two markers).
const flattenNode = (node: MojoNode): string => {
    if (node.type === 'Text') return node.text.split('\n').length > 2 ? '\n' : '';
    if (isBlankPercentLine(node)) return '\n';
    if (node.type === 'Block') return node.children.map(flattenNode).join('');
    return `${node.text.slice(1).trim()}\n`;
};

// Builds the placeholder text for a marker/region: a unique id padded out to roughly `firstLineLength`
// so prettier's HTML printer makes realistic fits/line-wrap decisions - see `registerMarker`'s longer
// explanation, which this factors out of (both it and `registerRegion` need the same computation).
const makePlaceholder = (id: number, firstLineLength: number): string => {
    const overhead = MARKER_OPEN.length + id.toString().length + MARKER_CLOSE.length;
    const padding = MARKER_PAD.repeat(Math.max(0, firstLineLength - overhead));
    return `${MARKER_OPEN}${id.toString()}${padding}${MARKER_CLOSE}`;
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

    // True if nothing but horizontal whitespace separates `node` from the preceding newline (or file
    // start) - i.e. real content (prose or a tag boundary - `source` doesn't distinguish them) sits
    // somewhere else entirely, not sharing `node`'s own line.
    const precededByRealContent = (node: MojoNode): boolean => {
        let i = node.start - 1;
        while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
        return i >= 0 && source[i] !== '\n';
    };
    // Same as `precededByRealContent`, looking forward from `node.end` instead.
    const followedByRealContent = (node: MojoNode): boolean => {
        let j = node.end;
        while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
        return j < source.length && source[j] !== '\n';
    };
    // True if real content touches `node.end` directly, with *no* whitespace at all in between (as
    // opposed to `followedByRealContent`, which also accepts real content separated by an ordinary,
    // reflow-collapsible space/tab run). This adjacency can never change on any future formatting pass
    // - there's no whitespace there for reflow to touch in the first place - unlike an *ordinary* space
    // gap, which prettier's own layout decisions (e.g. collapsing a block element's children onto its
    // opening line when they fit) can turn into a zero-gap adjacency on a *later* pass even though it
    // wasn't one originally. See `registerMarker`'s own comment for why this matters.
    const followedByZeroGapRealContent = (node: MojoNode): boolean => {
        if (node.end >= source.length) return false;
        const c = source[node.end];
        return c !== ' ' && c !== '\t' && c !== '\n';
    };
    // Same as `followedByZeroGapRealContent`, looking backward from `node.start` instead.
    const precededByZeroGapRealContent = (node: MojoNode): boolean => {
        if (node.start <= 0) return false;
        const c = source[node.start - 1];
        return c !== ' ' && c !== '\t' && c !== '\n';
    };
    // True if `node` is glued (no whitespace) directly to a real HTML tag's own `>` - an opening tag's
    // (`<div><%= x %>`) or a closing tag's (`</pre><% =%>`), either way - as opposed to another Mojo
    // marker's own `%>` delimiter (excluded by requiring the character *before* the `>` not be `%`,
    // since that's Mojo's own closing sequence, never a real HTML tag's). A block-level HTML element's
    // own tag boundary is *not* leading/trailing-space-sensitive to prettier's HTML printer - unlike an
    // inline element's (`<span>`, already handled correctly elsewhere in this file) - so prettier freely
    // separates glued content next to it onto its own line regardless of `printWidth` or content length,
    // completely independent of Mojo (verified directly against plain HTML with zero Mojo involved:
    // `<div>x</div>zzz`, `<pre>x</pre>zzz`, and even `<div>zzz<colgroup></colgroup></div>` - glued
    // content on *either* side of a block element's own tag - all come back with a forced line break
    // inserted at the exact glued boundary, with no `printWidth`-driven middle ground).
    //
    // On its own this separation is usually harmless: for an *ordinary*, output-producing marker
    // (`<%= ... %>`) sitting in normal text flow, the newline prettier inserts lands as leading/trailing
    // whitespace around real text content inside a normal (non-`<pre>`) block element, which HTML
    // collapses away visually regardless (verified against the already-established
    // `quote-like-operators`/`pure-perl-blank-after-impure` fixtures, both of which *already* correctly
    // allow this kind of separation - `<div><%= maketext(...) %>` and `<p><%= maketext(...) =%></p>`
    // both freely reflow onto multiple lines with no protection needed).
    //
    // It stops being harmless specifically when the marker is itself glued *forward* to a backslash too
    // (`node.end` immediately followed by `\`) - that combination is Mojo's own idiom for suppressing
    // *all* whitespace at this exact point (typically a no-output `<% =%>` used purely as a whitespace-
    // control device, as in `</pre><% =%>\`), and separating the marker from what precedes it inserts a
    // newline with nothing downstream able to suppress it (the backslash only ever suppresses the
    // newline *after* the marker's own `%>`, never anything before it) - a real, silent change to the
    // rendered output, not merely cosmetic. Found against a real template,
    // `SampleProblemViewer/sample_problem.html.ep`'s `</pre><% =%>\` (the marker's own trailing backslash
    // was already protected by `GLUED_BACKSLASH_SENTINEL`, but nothing protected the *marker itself* from
    // being separated from `</pre>`). This is a different, independent failure mode from what
    // `NO_BREAK_SENTINEL` protects against: that mechanism deliberately treats an already-zero-gap side
    // as *permanently safe* and skips protecting it, which is correct for `isOwnLine` stability (the only
    // thing it's guarding against) but doesn't account for prettier separating an already-glued boundary
    // anyway, for this completely unrelated reason.
    const precededByRealTagBoundary = (node: MojoNode): boolean =>
        node.start > 1 && source[node.start - 1] === '>' && source[node.start - 2] !== '%' && source[node.end] === '\\';
    // True if nothing but horizontal whitespace separates `node` from the newlines (or file
    // boundaries) on either side of it - i.e. the user wrote it alone on its own line, as opposed to
    // embedded inline with surrounding text (`Hello, <%= $name %>!`).
    const isOwnLine = (node: MojoNode): boolean => !precededByRealContent(node) && !followedByRealContent(node);

    // Set by `registerMarker` right after emitting an inline (non-own-line) `PlainMarker` whose
    // *following* side is what real content sits on (rather than its preceding side) - consumed by the
    // very next `Text` node's own emission in `visitSequence`, which glues its leading whitespace to
    // this marker the same way `registerMarker` glues a marker's *preceding* side inline. Only one of
    // these is ever pending at a time, since it's set and consumed within the same `visitSequence` pass
    // over sibling nodes, never nested.
    let pendingFollowingGlue = false;
    // Same deferral pattern as `pendingFollowingGlue`, for `insertPreGlueSentinel`'s own "the `<pre ...>`
    // tag was the very last thing in this Text node" case - set when that happens, consumed by whichever
    // node (Text or Marker) comes next, which gets `PRE_GLUE_SENTINEL` prepended to its own leading edge.
    let pendingPreGlue = false;

    const registerMarker = (node: MojoNode) => {
        // Consume a pending "the previous `<pre ...>` tag was the last thing in its own Text node"
        // request from `insertPreGlueSentinel` - this marker is the first thing after it, so it gets the
        // sentinel prepended directly (a marker's own placeholder never legitimately starts with a
        // newline, so there's no "already correct, skip it" case to check here unlike the Text-node
        // consumer below).
        if (pendingPreGlue) {
            skeleton += PRE_GLUE_SENTINEL;
            pendingPreGlue = false;
        }
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
        const placeholder = makePlaceholder(id, node.text.split('\n', 1)[0].length);

        // A bare placeholder is just plain text as far as HTML is concerned, and prettier's HTML
        // printer reflows plain text to fit the available width regardless of how it looked in the
        // source - unlike a real element, whose original single-line-vs-multi-line placement it
        // preserves. A `PlainMarker` (an expression tag, not part of any `{`/`begin` nesting) that the
        // user wrote alone on its own line - e.g. `<%= file_field ... =%>` as a `<div>`'s only child -
        // needs that same "respect how I wrote it" treatment, which means it needs to look like a real
        // element to HTML: wrapping it forces it to keep its own line the same way real markup would.
        // Structural markers (Open/Mid/Close) don't need this: their own-line separation from sibling
        // content is already handled by the empty-wrapper-separator logic in `visitSequence` below.
        if (node.type === 'PlainMarker' && ownLine) {
            skeleton += `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`;
            return;
        }

        // An inline marker that *isn't* own-line is just plain reflowable text as far as prettier's
        // HTML printer is concerned, and a long enough surrounding sentence can legitimately wrap right
        // before or after it purely for width reasons (`WeBWorK using host: ... course: <%= $courseID %>`
        // wrapping to put the last marker alone on its own output line, found against a real template,
        // `RPCRenderFormats/default.html.ep`). That's fine on its own, but reformatting *that output* as
        // fresh input is indistinguishable, character-for-character, from the user having genuinely
        // written this marker alone on its own line - `isOwnLine` (correctly, from that fresh input's
        // perspective) then says `true`, and the marker gets wrapped in `MARKER_WRAPPER_OPEN_TAG` on the
        // second pass even though nothing about the *template* changed, only how a previous run happened
        // to wrap a long sentence - a real idempotency break (format(format(x)) != format(x)), not just a
        // cosmetic one, since where a marker is wrapped affects the surrounding indentation.
        //
        // Fixed by guaranteeing that whichever side of this marker has real content next to it (the same
        // side(s) `isOwnLine` itself found) can never *degrade* into looking like a lone newline boundary
        // after formatting - replace the single whitespace character immediately on that side with
        // `NO_BREAK_SENTINEL`, an ordinary non-whitespace character that prettier's HTML reflow can't
        // treat as a break point (verified directly: HTML text-fill only ever breaks at whitespace, never
        // splits what looks like one contiguous "word"), later restored to a literal space by
        // `stripWrappersAndSubstitute` so it never appears in the rendered output.
        //
        // Gluing a side is skipped whenever the *other* side already touches real content with zero gap
        // - that adjacency can never change on any future pass (there's no whitespace there for reflow to
        // touch), so it alone keeps `isOwnLine` false forever, making protection on this side redundant.
        // Redundant gluing isn't just wasted effort here - it's actively harmful in two different,
        // independently-found ways: inside an HTML tag's own attribute list, gluing the *preceding* side
        // when the marker is itself a "bare attribute" already glued to the tag's own closing `>` (a
        // common idiom - `<div ... <%== $lang_dir %>>`) makes prettier's attribute printer re-insert its
        // own normalized separator space before what it reads as the next attribute regardless of
        // whether the source had any whitespace there, so the sentinel survives glued to the marker's
        // placeholder *in addition to* prettier's own inserted space - two spaces once the sentinel
        // converts back to a literal one, instead of the original single space (found against
        // `ContentGenerator/Problem.html.ep`'s `<div id="problem_body" class="problem-content" <%==
        // $c->output_problem_lang_and_dir %>>`, whose attribute-value quote collapsing onto the marker's
        // own line - itself harmless - triggered exactly this). And gluing the *following* side when the
        // marker is itself already glued to a preceding tag's own closing `>` (`<div><%= maketext(...)
        // %> <strong>...`) prevents prettier from ever breaking between the marker and whatever legitimately
        // needs to wrap next to it, forcing an unwanted `<strong\n\t>` split where a clean break onto its
        // own line was both possible and expected (found against the `quote-like-operators` fixture).
        //
        // This leaves one known, narrower gap: if a side only becomes zero-gap *after* a previous pass's
        // own, otherwise-harmless reflow (rather than being zero-gap in the true original source), the
        // *other* side's separating space can still be silently dropped a pass later, since by then this
        // side's own zero-gap status (indistinguishable, from parsed text alone, from having always been
        // zero-gap) causes protection to be skipped. Found in two different shapes, both pre-existing and
        // unrelated to any change in this session - even the original, pre-glue code already silently
        // dropped these same spaces unconditionally, just doing so consistently on every pass rather than
        // only after the first one: (1) `HelpFiles/Hardcopy.html.ep`, where a `<dd>` collapses onto a
        // multi-line marker's own opening line once formatted; (2) `HelpFiles/InstructorSendMail.html.ep`,
        // where prettier's own, completely ordinary HTML normalization drops the insignificant trailing
        // whitespace before a `</p>` (verified with zero Mojo involved: plain `<p> text\n</p>` alone
        // already collapses to `<p>text</p>`) - the following pass then sees the marker directly glued to
        // `</p>`. Distinguishing "zero-gap from the start" from "zero-gap because of a previous pass's own
        // harmless reflow" isn't possible from parsed text alone, and the two other bugs this symmetric
        // check fixes are more actively harmful (corrupted attribute lists; forced, unwanted line splits)
        // than this narrower one (an already-uncommon shape silently losing one space between passes), so
        // this is the accepted trade-off rather than a further-unresolved regression.
        //
        // The preceding side is handled here directly, since `skeleton`'s own trailing character *is*
        // that whitespace by construction (the preceding `Text` node was already appended); the following
        // side can't be touched yet (the next `Text` node hasn't been visited), so it's deferred via
        // `pendingFollowingGlue` for `visitSequence` to apply when it gets there.
        //
        // `<pre>` content is never reflowed by prettier's HTML printer in the first place (see
        // `isInsidePre`'s own comment), so it was never at risk of this instability and doesn't need -
        // or safely tolerate - this protection: `stripWrappersAndSubstitute`'s `insidePreContent` branch
        // passes `<pre>` lines straight through `substituteMarkers` without ever looking for
        // `NO_BREAK_SENTINEL`, so inserting one here would leak the raw PUA character into rendered
        // output instead of being converted back to a space.
        if (node.type === 'PlainMarker' && !isInsidePre(skeleton)) {
            if (precededByRealContent(node) && !followedByZeroGapRealContent(node) && /[ \t]$/.test(skeleton)) {
                skeleton = skeleton.slice(0, -1) + NO_BREAK_SENTINEL;
            }
            if (followedByRealContent(node) && !precededByZeroGapRealContent(node)) {
                pendingFollowingGlue = true;
            }
            // See `precededByRealTagBoundary`'s own comment - independent of the two checks above, since
            // this protects against prettier separating an already-zero-gap boundary, not against a gap
            // degrading into one.
            if (precededByRealTagBoundary(node)) {
                skeleton += TAG_GLUE_SENTINEL;
            }
        }
        skeleton += placeholder;
    };

    // Registers a maximal run of `isEligibleRegionMember` siblings (see that function and
    // `flattenNode`) as one combined `perltidy` unit, using the same own-line marker-wrapper mechanism
    // `registerMarker` uses for a single own-line `PlainMarker` - a region can never be embedded inline
    // with surrounding text, since bare `%` lines and `Block`s are always own-line by construction.
    const registerRegion = (nodes: MojoNode[]) => {
        const id = counter++;
        // A leading/trailing whitespace-only `Text` node absorbed into the run (e.g. the newline right
        // after the enclosing marker's own line) would otherwise leave a bare newline at the very start
        // or end of the fallback text, producing a spurious blank line when substituted back in on the
        // `perltidy`-failure path - trimmed for the same reason `body` is.
        const text = nodes
            .map((n) => n.text)
            .join('')
            .trim();
        markers[id] = { text, region: { body: nodes.map(flattenNode).join('').trim() } };
        const placeholder = makePlaceholder(id, text.split('\n', 1)[0].length);
        skeleton += `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`;
    };

    // A run of sibling nodes - either a Block's whole child list, or the content between two of a
    // Block's markers. Scans for maximal runs of `isEligibleRegionMember` nodes (interspersed only by
    // whitespace `Text`) first, registering each as one region; everything else falls through to the
    // per-node handling below, exactly as before this phase existed - including an *ineligible*
    // `Block`, which still recurses via `visitNode` -> `flush` -> `visitSequence(group)`, so this same
    // scan runs again on its content and still finds a pure-Perl `Block` nested inside an otherwise
    // mixed one.
    //
    // A `Text` node that's nothing but whitespace spanning a newline, and isn't part of a registered
    // region, is purely structural (there to preserve line breaks/blank lines between Mojo markers that
    // don't themselves sit inside any real HTML tag), and by construction of the tokenizer can only
    // occur adjacent to markers/blocks in the first place (a real HTML-to-HTML gap never becomes its own
    // Text node - it stays part of one continuous run). Left alone, prettier's HTML printer treats such
    // a run as ordinary reflowable prose and collapses every line onto one, so an empty wrapper is
    // spliced in to anchor the boundary - it's dropped again during substitution, contributing nothing
    // to the final output but forcing HTML to preserve the surrounding line breaks.
    const visitSequence = (rawNodes: MojoNode[], isTopLevel = false) => {
        const nodes = collapseBlankPercentRuns(rawNodes);
        let i = 0;
        while (i < nodes.length) {
            // A region is only ever started at a real anchor (`isEligibleRegionMember`) - never at a
            // connector (whitespace `Text` or a `%`-alone blank line, see `isBlankPercentLine`). Without
            // this gate, a leading connector sitting before the first anchor of an otherwise-eligible
            // run would get swept into `nodes.slice(i, end)` anyway (since `i` doesn't move during the
            // lookahead below), and the whole joined body gets `.trim()`med before being sent to
            // perltidy - silently eating a blank-line separator that happened to land first in the
            // slice, even though it's semantically no different from one sandwiched in the middle
            // (regressed exactly this way, against a real template with a lone `%` line followed by a
            // `%`-comment right after an *ineligible* `Block`, during development). A connector that
            // isn't part of any region - because nothing eligible ever follows it, or because it's this
            // kind of ineligible leading connector - just falls through to the ordinary per-node
            // handling below, one node at a time, which already renders it correctly on its own.
            if (isEligibleRegionMember(nodes[i])) {
                let j = i;
                // The run's real extent ends right after the *last* eligible member seen so far, not
                // wherever the lookahead scan below happens to stop - trailing connectors are only
                // tentatively included while scanning ahead for a possible next eligible member; if none
                // turns up, they must NOT be swept into the region, symmetric to the leading-connector
                // reasoning above (regressed this way too, against `realistic-template.html.ep`, during
                // earlier development).
                let end = i;
                while (j < nodes.length) {
                    const candidate = nodes[j];
                    if ((candidate.type === 'Text' && candidate.text.trim() === '') || isBlankPercentLine(candidate)) {
                        j++;
                    } else if (isEligibleRegionMember(candidate)) {
                        j++;
                        end = j;
                    } else {
                        break;
                    }
                }
                registerRegion(nodes.slice(i, end));
                i = end;
                continue;
            }

            const node = nodes[i];
            // Consume a pending "glue my following side" request from the immediately preceding inline
            // marker (see `registerMarker`) - its own preceding side had no real content to glue to, so
            // whatever comes right after it needs the same "not a line-break opportunity" protection
            // instead. Captured and cleared unconditionally, regardless of `node`'s own type: the request
            // only ever applies to the *one* node immediately following the marker that raised it (a
            // Text node, if there's any whitespace gap at all to glue - if the very next node is instead
            // another Marker/Block with zero gap, there's nothing to glue and this is simply a no-op),
            // never a later, unrelated one further down the sequence.
            const glueLeading = pendingFollowingGlue;
            pendingFollowingGlue = false;
            if (node.type === 'Text') {
                let text = node.text;
                const wasInsidePre = isInsidePre(skeleton);
                // Consume a pending "the previous `<pre ...>` tag was the last thing in its own Text
                // node" request from `insertPreGlueSentinel` below - this node is the first thing after
                // it. Skipped if this node's own text already starts with a real newline: that already
                // satisfies prettier's own trigger condition on its own, with nothing for the sentinel to
                // fix.
                if (pendingPreGlue) {
                    pendingPreGlue = false;
                    if (!text.startsWith('\n')) text = PRE_GLUE_SENTINEL + text;
                }
                if (glueLeading && !wasInsidePre && /^[ \t]/.test(text)) {
                    text = NO_BREAK_SENTINEL + text.slice(1);
                }
                // Only scan for a *newly opening* `<pre ...>` tag within this node's own text when we're
                // not already inside one - a `<pre` found while `wasInsidePre` is true would be nested,
                // invalid HTML `isInsidePre` itself already treats as out of scope (see its own comment).
                if (!wasInsidePre) {
                    const glued = insertPreGlueSentinel(text);
                    text = glued.text;
                    if (glued.deferredToNextNode) pendingPreGlue = true;
                }
                skeleton += wasInsidePre ? text : withBackslashContinuationAnchors(text);
                // Trailing whitespace after the very last node of the whole document needs no anchor:
                // there's nothing further along to preserve a line break *before*, and adding one here
                // anyway plants a real trailing element in the skeleton that prettier's HTML printer
                // sees as genuine content needing a blank line before it - defeating its own "strip all
                // trailing blank lines at end of file" behavior, which otherwise applies uniformly to
                // plain HTML (found against a real report: a `%` line followed by several blank lines at
                // EOF left exactly one blank line in the output, where plain HTML with the same trailing
                // blank lines leaves none). Anywhere else - between two markers, or before a Block's own
                // closing marker - the anchor is still required the same as always.
                const isTrailingAtDocumentEnd = isTopLevel && i === nodes.length - 1;
                if (node.text.trim() === '' && node.text.includes('\n') && !isTrailingAtDocumentEnd) {
                    skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
                } else if (/\n[ \t]*$/.test(node.text)) {
                    // Real text content (not just whitespace) ending in a genuine trailing newline, right
                    // before something that needs to start its own line for correctness (see
                    // `needsOwnLineAnchor`) - e.g. bare text "1" followed by "% if (...) {" on the next
                    // source line, both inside a `<button>` (found against a real template,
                    // `sort_button.html.ep`: without this, "1" and the following `%` line get merged onto
                    // one rendered line with a single space, which breaks Mojolicious's parsing entirely -
                    // a `%` control line must be the first non-whitespace thing on its own physical line,
                    // so merging it after "1" turns the whole line into literal text and the following
                    // `% } else {` / `% }` lines into unmatched closing braces, a template compile error).
                    // Deliberately narrower than the whitespace-only case above: a *tag-form* marker
                    // (`<%= %>` etc.) doesn't need its own line for correctness the way a `%`-line does,
                    // and real prose ending in a newline right before one should still be free to reflow
                    // onto the same line as before - verified a real element (`<colgroup>`, used for an own-line
                    // tag-form marker) never needs this protection in the first place, unlike the bare,
                    // unwrapped placeholder a structural marker's own `registerMarker` call produces.
                    // The tokenizer can split "real content, then a newline" and "the following
                    // indentation" into two *separate* adjacent `Text` nodes (found against the same real
                    // template: "1\n" as this node, then a sibling "\t\t" node with no newline of its own,
                    // both before the `Block`) - `nodes[i + 1]` alone would be that whitespace-only
                    // connector, not the thing that actually needs its own line, so skip forward past any
                    // number of purely-whitespace connectors to find the real next node first.
                    let next = i + 1;
                    while (next < nodes.length && nodes[next].type === 'Text' && nodes[next].text.trim() === '') {
                        next++;
                    }
                    if (next < nodes.length && needsOwnLineAnchor(nodes[next])) {
                        skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
                    }
                }
            } else {
                visitNode(node);
            }
            i++;
        }
    };

    const visitNode = (node: MojoNode) => {
        if (node.type === 'Block') {
            let group: MojoNode[] = [];
            const flush = () => {
                if (group.length === 0) return;
                // The inner wrapper adds a real (later-canceled) indent level of its own, which - when
                // a Block is nested inside another Block - compounds with every ancestor's own inner
                // wrapper and inflates prettier's fits/width computation for the whole subtree well
                // beyond its real final depth, even though none of that extra depth survives to the
                // output. Only pay for it when this content actually needs the protection.
                const needsInner = needsGluedTagProtection(group);
                skeleton += WRAPPER_OPEN_TAG + (needsInner ? CONTENT_INNER_OPEN_TAG : '');
                visitSequence(group);
                skeleton += (needsInner ? CONTENT_INNER_CLOSE_TAG : '') + WRAPPER_CLOSE_TAG;
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

    visitSequence(programNode.children, true);

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
// depth bookkeeping is needed to get its content indented one level deeper, since `<colgroup>` is a
// real HTML element and prettier's own HTML formatter already indents an element's children relative
// to it (and does so again for each further level of *nested* blocks, since each is its own nested
// wrapper), exactly like it would for any other element - but the *marker* wrapper needs that one
// level of indent it also picked up canceled back out again (see its definition above), tracked via
// a small stack since both wrappers share the same `</colgroup>` closing text. Every other line is left
// exactly as HTML formatted it, with only its marker placeholders substituted back in.
interface PerltidyContext {
    perltidyrcPath: string | undefined;
    useTabs: boolean;
    tabWidth: number;
    printWidth: number;
}

// A closing `</colgroup>` is textually indistinguishable from our own wrapper's closing tag - closing
// tags can't carry a disambiguating attribute the way `WRAPPER_OPEN_TAG`/`MARKER_WRAPPER_OPEN_TAG` do
// on the opening side - so a genuine `<colgroup>` the template's own HTML happens to contain (one real
// webwork2 template has one, for its ordinary `<col>`-styling purpose) would otherwise have its closing
// tag silently dropped, the same bug a genuine `<ol>` used to trigger before this wrapper switched tags
// (found in a real template: `<ol class="list-group ...">`). Fixed by a whole-document, order-preserving
// scan *before* the line-by-line walk below: `<colgroup>` unconditionally forces its children onto their
// own line regardless of who authored it (verified empirically, including nested inside our own
// wrapper), so every `<colgroup>`'s own open/close tags land on dedicated lines just like ours do,
// making a simple stack-based pairing scan reliable - `[^<>]*` (not `.`) so it still matches an opening
// tag whose attributes happen to wrap across multiple lines. Returns, in the order `</colgroup>`
// occurrences appear in `formatted`, whether each one closes one of our own wrapper opens (`true`) or a
// real one from the template (`false`).
const WRAPPER_TAG_RE = /<colgroup(?:\s[^<>]*)?>|<\/colgroup>/g;
const classifyWrapperCloses = (formatted: string): boolean[] => {
    const closes: boolean[] = [];
    const stack: boolean[] = [];
    for (const match of formatted.matchAll(WRAPPER_TAG_RE)) {
        if (match[0] === WRAPPER_CLOSE_TAG) closes.push(stack.pop() ?? false);
        else stack.push(match[0] === WRAPPER_OPEN_TAG || match[0] === MARKER_WRAPPER_OPEN_TAG);
    }
    return closes;
};

// The visual column `line[0..endIndex)` ends at, expanding tabs to the next `tabWidth` stop the same
// way `perltidy` itself does when deciding where to pad a vertically-aligned token (see the `=>`
// realignment below) - a plain character count would be wrong whenever `useTabs` mixes literal tabs
// (structural indent) with the literal spaces `perltidy` inserts for alignment padding, both of which
// appear on the same line (e.g. `\t\t\t\ttarget                      => ...`).
const visualColumn = (line: string, endIndex: number, useTabs: boolean, tabWidth: number): number => {
    let col = 0;
    for (let i = 0; i < endIndex; i++) {
        col += useTabs && line[i] === '\t' ? tabWidth - (col % tabWidth) : 1;
    }
    return col;
};

const stripWrappersAndSubstitute = async (
    formatted: string,
    markers: MarkerInfo[],
    indentUnit: string,
    perltidyContext: PerltidyContext
): Promise<string> => {
    const lines = formatted.split('\n');
    const output: string[] = [];
    const stack: ('content' | 'marker' | 'inner')[] = [];
    const wrapperCloseIsOurs = classifyWrapperCloses(formatted);
    let wrapperCloseIndex = 0;

    const emptySeparator = WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;

    // `<pre>`'s content is whitespace-significant, so prettier's HTML printer never reformats it at
    // all - verified directly against plain HTML with no Mojo involved: a `<pre>` nested three levels
    // deep gets its own *opening* tag correctly repositioned to match that depth, but its content and
    // closing tag stay at whatever indentation was already in the source, completely untouched. Every
    // other line in this walk assumes the opposite - that prettier *did* uniformly shift its indentation
    // by however many wrapper levels are currently open, so `cancelLevels` below undoes exactly that
    // shift - which is wrong for anything inside a `<pre>`, since there was never any shift to undo
    // there in the first place (found against the real construct this project already knows has issues,
    // `exception_default.html.ep`'s `<pre>...<code>...</code>...</pre>`: subtracting cancelLevels from
    // its content/closing-tag lines was quietly stripping real indentation that prettier never added).
    // Tracked with a plain boolean rather than folding into `stack` above: unlike the wrapper tags,
    // entering/leaving this mode isn't about a dedicated marker line of our own, but about literal
    // `<pre>`/`</pre>` tags that can appear anywhere in the *middle* of an otherwise-ordinary content
    // line (mixed with real text on the same line, as they are in the real construct above).
    let insidePreContent = false;
    const PRE_OPEN_LINE_RE = /<pre(?:\s[^<>]*)?>/;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === GLUED_BACKSLASH_SENTINEL) {
            // The `\` this stands in for was glued (no whitespace at all) directly to whatever preceded
            // it in the source - unlike a genuinely isolated backslash line, prettier separating it onto
            // its own line here doesn't correspond to any real newline that belongs in the rendered
            // output, so restore the original adjacency by gluing a literal `\` onto the end of whatever
            // line was emitted right before this one, rather than ever emitting a line of its own for it.
            if (output.length > 0) output[output.length - 1] += '\\';
            continue;
        }

        if (trimmed === `>${GLUED_BACKSLASH_SENTINEL}`) {
            // A glued backslash sitting as the very first content of a whitespace-sensitive inline
            // element (e.g. `<span class="...">\`, the backslash glued directly to that opening tag's
            // own `>`) forces prettier into a different, but equally deliberate, presentation: instead
            // of separating on the newline *after* the backslash (handled above), it moves the tag's own
            // `>` down onto its own line, directly glued to whatever comes next, to preserve "there was
            // no whitespace here" while still letting the forced-multiline content (our marker wrapper)
            // start on the following line - verified this is completely general, unrelated to Mojo:
            // plain `<span>zzz<address></address>content</span>` with zero Mojo involvement exhibits the
            // identical `<span\n\t>zzz` split. Semantically harmless (same zero-whitespace adjacency
            // either way) but needlessly ugly when the tag's attributes would easily have fit on one line
            // together with `>` - found against a real template,
            // `ContentGenerator/Instructor/Index.html.ep`'s `<span class="input-group-text flex-grow-1">\`,
            // whose short attribute list clearly didn't need `>` isolated onto its own line beneath it.
            // Since prettier's own choice here is purely presentational, glue `>` (and the backslash it's
            // paired with) back onto the end of whatever attribute line was emitted right before it,
            // provided that still fits within `printWidth` - if the attributes already needed to wrap for
            // genuine width reasons (as in a real multi-attribute `<button>` in the same file), leave `>`
            // on its own line rather than pushing that line over budget just for cosmetics. Verified this
            // doesn't fight prettier on a second pass: unlike asking *plain* prettier to reformat this
            // merged text (which would just re-split it, since it's making the same leading-space-sensitive
            // decision fresh each time), this plugin's own pipeline reconstructs the identical skeleton
            // from the merged source and re-applies this same merge deterministically, so the merged form
            // is a stable fixed point for *this plugin* even though it isn't one for prettier's HTML
            // printer in isolation.
            if (output.length > 0) {
                const candidate = `${output[output.length - 1]}>\\`;
                const fits =
                    visualColumn(candidate, candidate.length, perltidyContext.useTabs, perltidyContext.tabWidth) <=
                    perltidyContext.printWidth;
                if (fits) {
                    output[output.length - 1] = candidate;
                    continue;
                }
            }
            // Doesn't fit (or there's no previous line to merge onto) - fall through to the normal
            // content path below, which already knows how to substitute an in-line sentinel back to a
            // literal `\` without merging it anywhere.
        }

        if (trimmed.startsWith(TAG_GLUE_SENTINEL)) {
            // See `precededByRealTagBoundary`'s own comment - prettier separated a marker from a real
            // HTML tag boundary it was glued to in the source, unconditionally (verified this happens
            // regardless of `printWidth` or content length, unlike the whitespace-sensitive-inline case
            // above), so the merge here is unconditional too: restore the original adjacency by gluing
            // this line's own content (its marker placeholder, still needing substitution) onto the end
            // of whatever line was emitted right before it, rather than ever emitting a line of its own.
            if (output.length > 0) {
                output[output.length - 1] += substituteMarkers(trimmed.slice(TAG_GLUE_SENTINEL.length), markers);
            }
            continue;
        }

        if (insidePreContent) {
            if (trimmed.includes('</pre>')) insidePreContent = false;
            // `PRE_GLUE_SENTINEL` (see its own definition and the insertion site near `PRE_OPEN_TAG_RE`)
            // marks a line that prettier split off the `<pre ...>` opening tag's own line purely because
            // its own content didn't already start with a real newline, not because the source had one -
            // undo that split by gluing this line directly onto the end of the `<pre ...>` line already
            // pushed to `output`, restoring the original adjacency.
            if (line.startsWith(PRE_GLUE_SENTINEL) && output.length > 0) {
                output[output.length - 1] += substituteMarkers(line.slice(PRE_GLUE_SENTINEL.length), markers);
            } else {
                output.push(line === '' ? '' : substituteMarkers(line, markers));
            }
            continue;
        }

        if (trimmed === emptySeparator) {
            // This line's own `</colgroup>` is ours by construction (its `<ol data-mojo-wrapper>`
            // half is unambiguous), but it still counts as one of the `</colgroup>` occurrences
            // `classifyWrapperCloses` found - consume its slot so `wrapperCloseIndex` stays aligned
            // with subsequent ones.
            wrapperCloseIndex++;
            continue; // empty content-wrapper separator, collapsed onto one line
        }
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
        if (trimmed === WRAPPER_CLOSE_TAG) {
            // Default to "not ours" (keep the line) on an unexpected index mismatch - silently keeping
            // an extra line is far less harmful than silently dropping a genuine closing tag.
            const isOurs = wrapperCloseIsOurs[wrapperCloseIndex++] ?? false;
            if (isOurs) {
                stack.pop();
                continue;
            }
            // A genuine `</colgroup>` the template's own HTML contains - fall through to the normal line
            // handling below so it's kept (with indent/marker substitution applied like any other
            // line), not dropped the way every `</colgroup>` used to be treated unconditionally.
        } else if (trimmed === CONTENT_INNER_CLOSE_TAG) {
            stack.pop();
            continue;
        }

        // Unlike the wrappers above (always forced onto their own line by the outer element's
        // unconditional-multiline behavior), <address data-mojo-inner> is an ordinary element and can
        // collapse onto the same line as its content when that's short enough to fit - in which case
        // it never added a separate indent level to cancel, so just strip its tag text in place
        // rather than touching the stack.
        let content = trimmed;
        if (content.includes(CONTENT_INNER_OPEN_TAG) || content.includes(CONTENT_INNER_CLOSE_TAG)) {
            content = content.split(CONTENT_INNER_OPEN_TAG).join('').split(CONTENT_INNER_CLOSE_TAG).join('');
        }
        // A glued backslash whose line *wasn't* separated from the rest of this content by prettier
        // (short enough to still fit glued onto its original line) never hits the lone-sentinel branch
        // above - restore the literal `\` in place here instead.
        if (content.includes(GLUED_BACKSLASH_SENTINEL)) {
            content = content.split(GLUED_BACKSLASH_SENTINEL).join('\\');
        }
        // `NO_BREAK_SENTINEL` (see `registerMarker`) only ever stands in for an ordinary space that
        // must not become a line-break opportunity during *this* formatting pass - once formatting is
        // done, it always converts back to a literal space, unconditionally, wherever it appears. Unlike
        // `GLUED_BACKSLASH_SENTINEL`, it can never end up alone on its own line: replacing a space with a
        // non-whitespace character removes the only place HTML's text-fill could have broken there, so
        // the sentinel and its neighbors on both sides are permanently glued onto the same output line by
        // construction - no separate lone-sentinel-line branch is needed here.
        if (content.includes(NO_BREAK_SENTINEL)) {
            content = content.split(NO_BREAK_SENTINEL).join(' ');
        }
        // `PRE_GLUE_SENTINEL` (see `insertPreGlueSentinel`) only matters when prettier actually splits
        // the `<pre ...>` tag's own line off from what follows - the `insidePreContent` branch above
        // handles that case by merging the split line back. When the content was short enough that
        // prettier left it glued to the `<pre ...>` tag's own line after all (never separated in the
        // first place), the sentinel just needs deleting outright here - unlike every other sentinel in
        // this file, it never stands in for any real character of its own.
        if (content.includes(PRE_GLUE_SENTINEL)) {
            content = content.split(PRE_GLUE_SENTINEL).join('');
        }
        // `TAG_GLUE_SENTINEL` (see `precededByRealTagBoundary`) is handled the same way as
        // `PRE_GLUE_SENTINEL` above - the `startsWith` branch earlier in this loop covers the case where
        // prettier actually separated it onto its own line (verified this is unconditional, so that's
        // the expected case in practice), this is just the fallback if it ever survives glued in place.
        if (content.includes(TAG_GLUE_SENTINEL)) {
            content = content.split(TAG_GLUE_SENTINEL).join('');
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
            // `runPerltidy`'s brace-wrapping accounts for the surrounding HTML indent, but perltidy
            // itself has no idea this content is about to be glued onto a `<%=`/`=%>`-style delimiter
            // afterward - its own `-l` budget is spent purely on Perl content. If the result collapses
            // to one line, both `prefix` and `suffix` land on that same line; conservatively assuming
            // that will happen (rather than trying to predict multi-line vs single-line before knowing
            // the result) keeps the reconstructed line within `printWidth` either way - worst case, a
            // marker that would have fit on one line with only `prefix`'s overhead wraps a little
            // earlier than strictly necessary once `suffix` is also subtracted, which is a far smaller
            // problem than the line quietly exceeding `printWidth` (found against two real templates).
            const delimiterOverhead = prefix.length + 1 + (suffix ? suffix.length + 1 : 0);
            // A `<%= %>`/`%=` body is a bare expression with no trailing `;` (that's the Mojolicious
            // convention - Mojo::Template evaluates it and uses the value), but `perltidy` treats "the
            // final statement in a block, with no `;`" differently from an ordinary one for some
            // formatting decisions - notably, it stops vertically aligning a chain of `?:`/`=>` operators
            // (verified directly against `perltidy`: identical content produces misaligned ternary
            // operators without a trailing `;`, correctly aligned with one). Since a non-`=` `<% %>`/`%`
            // tag's body genuinely can be a real statement that already ends in `;`, only append one when
            // it's actually missing, and strip it back off the reconstructed result's last line
            // afterward - verified the `;` always stays glued to the last real token even when `perltidy`
            // wraps the result across multiple lines, so a plain trailing-`;` strip on the last line is
            // safe regardless of how many lines come back.
            const hadTrailingSemicolon = body.trimEnd().endsWith(';');
            const perltidyInput = hadTrailingSemicolon ? body : `${body};`;
            // The synthetic `;` itself is one more character counting against perltidy's width budget
            // that won't be there in the final output (it gets stripped below) - without compensating
            // for it, a marker sitting exactly at the width boundary would wrap one column earlier than
            // it should (found immediately after adding the `;` trick above: a real marker's body was
            // exactly at its computed budget without the `;`, and the added character alone was enough
            // to push perltidy into wrapping it instead of keeping it on one line).
            const semicolonCompensation = hadTrailingSemicolon ? 0 : 1;
            const perltidyLines = await runPerltidy(perltidyInput, {
                configPath: perltidyContext.perltidyrcPath,
                depth,
                useTabs: perltidyContext.useTabs,
                tabWidth: perltidyContext.tabWidth,
                printWidth: Math.max(1, perltidyContext.printWidth - delimiterOverhead + semicolonCompensation)
            });
            if (perltidyLines && !hadTrailingSemicolon) {
                const lastIndex = perltidyLines.length - 1;
                perltidyLines[lastIndex] = perltidyLines[lastIndex].replace(/;\s*$/, '');
                // A list ending in a trailing comma (`'aria-selected' => $active ? 'true' : 'false',`)
                // leaves the synthetic `;` dangling with nothing to glue onto - `perltidy` gives it a
                // line of its own rather than attaching it to the trailing comma (found against a real
                // template: `ContentGenerator/Instructor/UserList.html.ep`'s `link_to` call, whose
                // hash-arg list ends in a trailing comma). Stripping the `;` then leaves that whole line
                // empty, which would otherwise survive into the output as a spurious blank line right
                // before `=%>` - drop it outright rather than just stripping the semicolon off it.
                if (perltidyLines.length > 1 && perltidyLines[lastIndex].trim() === '') {
                    perltidyLines.pop();
                }
            }
            // `perltidy` vertically aligns a `=>` chain (or similar) across sibling continuation lines by
            // padding with spaces before the token, using the *unprefixed* first line as part of that
            // alignment - it has no idea `prefix` (e.g. `<%=`) is about to be glued onto that first line
            // afterward, widening it by `prefix.length + 1` columns. Left alone, every other line's `=>`
            // stays at the old column, `prefix.length + 1` short of the first line's new one (found
            // against a real template: `link_to maketext('Report bugs') => ...` on the glued first line,
            // with `target => ...` / `class => ...` on their own lines 4 columns left of where they should
            // land). Detected precisely rather than assumed: only a continuation line whose own `=>`
            // already sits at *exactly* the same visual column as the first line's `=>` (i.e. one
            // `perltidy` deliberately aligned with it, not an unrelated/nested one at some other column)
            // gets `prefix.length + 1` extra spaces inserted immediately before its `=>`. This only ever
            // touches text *after* each line's existing leading whitespace, never the leading whitespace
            // itself, so it can't interfere with the closing-delimiter-gluing check below (which compares
            // leading whitespace only, computed independently of this).
            if (perltidyLines && perltidyLines.length > 1) {
                const firstArrowIndex = perltidyLines[0].indexOf('=>');
                if (firstArrowIndex !== -1) {
                    const firstArrowColumn = visualColumn(
                        perltidyLines[0],
                        firstArrowIndex,
                        perltidyContext.useTabs,
                        perltidyContext.tabWidth
                    );
                    const pad = ' '.repeat(prefix.length + 1);
                    for (let i = 1; i < perltidyLines.length; i++) {
                        const arrowIndex = perltidyLines[i].indexOf('=>');
                        if (arrowIndex === -1) continue;
                        const arrowColumn = visualColumn(
                            perltidyLines[i],
                            arrowIndex,
                            perltidyContext.useTabs,
                            perltidyContext.tabWidth
                        );
                        if (arrowColumn === firstArrowColumn) {
                            perltidyLines[i] =
                                perltidyLines[i].slice(0, arrowIndex) + pad + perltidyLines[i].slice(arrowIndex);
                        }
                    }
                }
            }
            // A percent-line (`%=`/`%==`) marker can never safely become multi-line - Mojo::Template
            // only treats a line as Perl if it starts with `%`, so a continuation line without one
            // would be parsed as literal HTML output - so that combination is treated the same as a
            // failed `perltidy` run: fall through to the raw-passthrough substitution below.
            const isPercentForm = prefix.startsWith('%');
            if (perltidyLines && !(isPercentForm && perltidyLines.length > 1)) {
                // Unlike a region (below), a reformatted tag-form marker's first line gets glued onto
                // its opening delimiter instead of staying on its own line, so its own
                // `depth`-levels-of-indent (which `runPerltidy` leaves intact on every line, including
                // when the whole result is only one line) needs stripping here before gluing - every
                // *other* line keeps its full real indentation, `depth` levels deep, courtesy of the
                // brace-wrapping `runPerltidy` did; prepending `indent` again would double it.
                const firstLineIndent = indentUnit.repeat(depth);
                const firstLine = perltidyLines[0].startsWith(firstLineIndent)
                    ? perltidyLines[0].slice(firstLineIndent.length)
                    : perltidyLines[0].trimStart();
                if (perltidyLines.length === 1) {
                    const suffixPart = suffix ? ` ${suffix}` : '';
                    output.push(`${indent}${prefix} ${firstLine}${suffixPart}`);
                } else {
                    // The closing delimiter is synthetic, not part of perltidy's output at all. If the
                    // last content line is back at the *same* depth as the first line - a closing
                    // `)`/`}`/`]` that perltidy itself aligned back under where the call/structure
                    // started, not a deeper continuation line - glue the delimiter onto it instead of
                    // giving it its own line, the same way prettier itself collapses a multi-line tag's
                    // closing `>` onto its last attribute line when there's nothing deeper to close
                    // over. Only ever true for the very last line (an intermediate line at this depth
                    // would mean the statement isn't actually done yet), so no risk of gluing early.
                    const lastLine = perltidyLines[perltidyLines.length - 1];
                    const lastLineIndent = /^\s*/.exec(lastLine)?.[0] ?? '';
                    output.push(`${indent}${prefix} ${firstLine}`);
                    output.push(...perltidyLines.slice(1, -1));
                    if (lastLineIndent === firstLineIndent) {
                        const suffixPart = suffix ? ` ${suffix}` : '';
                        output.push(`${lastLine}${suffixPart}`);
                    } else {
                        output.push(lastLine);
                        output.push(`${indent}${suffix}`);
                    }
                }
                continue;
            }
        }

        // A pure-Perl region (see `registerRegion`/`flattenNode`): every returned line is symmetric -
        // there's no delimiter to glue a first line onto, so unlike the tag-form path above, all of
        // them (including the first) keep the full real indent `runPerltidy` produced. `%` + a space is
        // inserted right after each line's own leading whitespace, matching the requested style
        // (`% #` for a comment, not the Mojolicious-docs `%#` shorthand - this falls out automatically
        // since a comment line is just ordinary Perl text as far as this is concerned). A blank line in
        // perltidy's output (from a `%`-alone separator - `flattenNode` - or its own blank-line
        // collapsing) carries no indentation of its own at all, the way a genuinely empty line never
        // does in any code formatter's output, so it gets the region's own base `indent` explicitly
        // rather than trying to extract a "leading whitespace" that isn't there - and critically, no
        // trailing space after the `%`, unlike a real content line: Mojolicious requires the marker but
        // there's nothing to put after it, and a trailing space there is exactly the bug this comment
        // is here to prevent from creeping back in.
        if (marker?.region) {
            const depth = indentUnit.length === 0 ? 0 : indent.length / indentUnit.length;
            // Every returned line gets `% ` prepended (2 columns) that perltidy's own `-l` budget never
            // accounted for - same reasoning as the tag-form path above, just a fixed 2-column overhead
            // applied uniformly instead of a delimiter-dependent one.
            const perltidyLines = await runPerltidy(marker.region.body, {
                configPath: perltidyContext.perltidyrcPath,
                depth,
                useTabs: perltidyContext.useTabs,
                tabWidth: perltidyContext.tabWidth,
                printWidth: Math.max(1, perltidyContext.printWidth - 2)
            });
            if (perltidyLines && perltidyLines.length > 0) {
                for (const perltidyLine of perltidyLines) {
                    if (perltidyLine === '') {
                        output.push(`${indent}%`);
                        continue;
                    }
                    const leading = /^\s*/.exec(perltidyLine)?.[0] ?? '';
                    output.push(`${leading}% ${perltidyLine.slice(leading.length)}`);
                }
                continue;
            }
        }

        // A `<pre ...>` opening tag on this line, not also closed again on the same line, means every
        // subsequent line up to (and including) the matching `</pre>` is verbatim content - see the
        // `insidePreContent` block above. This line itself still gets the normal indent/cancelLevels
        // treatment: prettier *did* properly reposition the opening tag's own line to its real
        // structural depth, unlike everything nested inside it.
        if (PRE_OPEN_LINE_RE.test(content) && !content.includes('</pre>')) insidePreContent = true;

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
