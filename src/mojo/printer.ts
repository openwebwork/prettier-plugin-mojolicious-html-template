import { dirname } from 'node:path';
import { doc, type AstPath, type Doc, type Options } from 'prettier';
import type { MojoNode } from './ast.js';
import { findPerltidyrc, runPerltidy } from './perltidy.js';

const isStructuralMarker = (type: string): boolean =>
    type === 'OpenMarker' || type === 'MidMarker' || type === 'CloseMarker';

// Unicode Private-Use-Area sentinels: can't collide with real template content, and stay one
// whitespace-free "word" so HTML's text-wrapping won't split them.
const MARKER_OPEN = `${String.fromCharCode(0xe000)}MOJO`;
const MARKER_CLOSE = String.fromCharCode(0xe001);
// A `\` glued (no whitespace) to whatever preceded it in the source.
const GLUED_BACKSLASH_SENTINEL = String.fromCharCode(0xe003);
// A space that must not become a line-break opportunity during this pass.
const NO_BREAK_SENTINEL = String.fromCharCode(0xe004);
// Marks the position right after a `<pre ...>` tag whose content doesn't already start with a newline.
const PRE_GLUE_SENTINEL = String.fromCharCode(0xe005);
// Marks a `PlainMarker` glued to a real HTML tag's own `>` on its preceding side.
const TAG_GLUE_SENTINEL = String.fromCharCode(0xe006);

// `<colgroup data-mojo-wrapper>`: prettier's HTML printer only forces an element's children onto their
// own lines unconditionally for a hardcoded set of real tags - a made-up tag would just collapse when
// short, which is wrong for Perl control-flow blocks. `<colgroup>` collides least with genuine template
// markup; its closing `</colgroup>` is still plain text, so a real one elsewhere is a collision handled
// below by `classifyWrapperCloses`.
const WRAPPER_OPEN_TAG = '<colgroup data-mojo-wrapper>';
const WRAPPER_CLOSE_TAG = '</colgroup>';

// A wrapper for a tag-form Block's own content (`<%= ..., begin =%> ... <% end =%>`): unlike a Perl
// control-flow Block's content, which must never collapse onto one line even when short (the reason
// `WRAPPER_OPEN_TAG` exists at all), a tag-form Block's content is ordinary markup and should lay out
// exactly like a real HTML element's - collapsing when it fits, wrapping normally when it doesn't, even
// when glued with zero gap to real content on both sides (the Block's own markers). That last part rules
// out a block-display tag (`<colgroup>`, `<figcaption>`, `<div>`, ...): a block-display element can never
// sit inline within a run of text - prettier forces it onto its own line regardless of width, the same
// unwanted behavior all over again. `<bdi>` is a real inline-display tag with ordinary collapsing
// behavior and collides least with genuine template markup.
const TAGFORM_WRAPPER_OPEN_TAG = '<bdi data-mojo-tagform-wrapper>';
const TAGFORM_WRAPPER_CLOSE_TAG = '</bdi>';

// A second wrapper for a single own-line `PlainMarker`: the same "look like a real element" trick, but
// without the extra indent level the content wrapper adds.
const MARKER_WRAPPER_OPEN_TAG = '<colgroup data-mojo-marker>';

// A third wrapper, nested inside the content wrapper, applied only when a Block's content has an inline
// element glued to trailing bare text (see `needsGluedTagProtection`) - works around the outer wrapper's
// own mid-tag-split quirk in that shape.
const CONTENT_INNER_OPEN_TAG = '<address data-mojo-inner>';
const CONTENT_INNER_CLOSE_TAG = '</address>';

// A `PlainMarker` with real Perl content gets `reformat` populated so its placeholder is spliced out for
// real, `perltidy`-formatted content (see `buildMarkerDoc`/`embed`). Structural markers (Open/Mid/Close)
// are excluded: each is a fragment of a larger `{`/`}`/`begin`/`end` chain, never safe to reformat in
// isolation. `insidePre` marks a marker inside `<pre>`, whose boundaries must not gain or lose so much
// as one character of surrounding whitespace. `ownLine` marks a marker that sat alone on its own source
// line - see `buildReformattedDoc`'s single-line case for why it matters.
interface MarkerInfo {
    text: string;
    insidePre: boolean;
    ownLine: boolean;
    reformat?: { prefix: string; body: string; suffix: string };
    region?: { body: string };
}

// Splits a reformat-eligible `PlainMarker`'s text into its delimiter and body, or `undefined` for a
// shape this phase doesn't handle.
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

// A Block's `OpenMarker` opens it either via a trailing `{` (Perl control-flow: `if`/`unless`/`for`/...)
// or a trailing `begin` keyword (Mojolicious's block-capture syntax, e.g. `<%= link_to ..., begin =%>`) -
// `classify` in tokens.ts treats both identically at the grammar level, so the delimiter alone
// (`<%` vs bare `%`) doesn't distinguish them: `<% if ($error) { =%>` starts with `<%` exactly like a
// real tag-form marker does, but is genuine Perl control-flow, not a value-capturing block, and needs to
// stay forced multi-line the same as the bare `% if (...) {` shorthand - confirmed against a real
// template (`ProblemSetDetail.html.ep`) where treating it as tag-form let its `<div>...</div>` content
// collapse onto the `<% if ($error) { =%>` line, dragging the closing `<% } =%>` right along with it.
const isTagFormOpenMarker = (openMarkerText: string): boolean =>
    /\bbegin\s*$/.test(splitMarkerDelimiters(openMarkerText)?.body ?? '');

// A bare `%` line with real Perl content - not tag-form, not `%=`/`%==`, and not a content-free
// `%`-alone line (see `isBlankPercentLine`).
const isBarePercentLine = (node: MojoNode): boolean =>
    node.type === 'PlainMarker' &&
    node.text.startsWith('%') &&
    splitMarkerDelimiters(node.text) === undefined &&
    node.text.trim() !== '%';

// A `%`-alone line - this templating format's equivalent of a blank line between statements.
const isBlankPercentLine = (node: MojoNode): boolean => node.type === 'PlainMarker' && node.text.trim() === '%';

// Collapses a run of 2+ consecutive `isBlankPercentLine` siblings down to just the first, matching how
// prettier and `perltidy` both collapse blank-line runs.
const collapseBlankPercentRuns = (nodes: MojoNode[]): MojoNode[] => {
    const result: MojoNode[] = [];
    let i = 0;
    while (i < nodes.length) {
        const node = nodes[i];
        if (!isBlankPercentLine(node)) {
            result.push(node);
            ++i;
            continue;
        }
        result.push(node);
        let j = i + 1;
        // Skip further blank lines and their connecting whitespace, keeping the last connector seen.
        let trailingConnector: MojoNode | undefined;
        while (j < nodes.length) {
            const next = nodes[j];
            if (next.type === 'Text' && next.text.trim() === '') {
                trailingConnector = next;
                ++j;
            } else if (isBlankPercentLine(next)) {
                ++j;
            } else {
                break;
            }
        }
        if (trailingConnector) result.push(trailingConnector);
        i = j;
    }
    return result;
};

// A closing HTML tag immediately followed by non-whitespace, non-`<` content - the shape
// `CONTENT_INNER_OPEN_TAG` guards against.
const GLUED_CLOSE_TAG_RE = /<\/[a-zA-Z][\w-]*>(?=[^\s<])/;

// True if a Block's content has the glued-closing-tag shape `CONTENT_INNER_OPEN_TAG` exists to protect
// against, checked against a flattened string where every marker/nested Block is one opaque character.
const needsGluedTagProtection = (nodes: MojoNode[]): boolean =>
    GLUED_CLOSE_TAG_RE.test(nodes.map((node) => (node.type === 'Text' ? node.text : 'X')).join(''));

// True if `node` is a `Block` whose entire content, recursively, is nothing but bare `%` lines and
// whitespace - safe to reconstruct into one balanced Perl program.
const isPureBlock = (node: MojoNode): boolean =>
    node.type === 'Block' &&
    node.children.every((child) => {
        if (isStructuralMarker(child.type)) return child.text.startsWith('%') && !child.text.startsWith('<%');
        if (child.type === 'Text') return child.text.trim() === '';
        if (child.type === 'PlainMarker') return isBarePercentLine(child) || isBlankPercentLine(child);
        if (child.type === 'Block') return isPureBlock(child);
        return false;
    });

// A node safe to fold into a pure-Perl region alongside its siblings (see `registerRegion`): a lone
// bare `%` line, or a whole pure `Block`.
const isEligibleRegionMember = (node: MojoNode): boolean => isBarePercentLine(node) || isPureBlock(node);

// A node whose own-line placement relies on the whitespace-anchor mechanism in `visitSequence` below
// rather than a real wrapper element: a bare `%` line, or a Block genuinely requiring one - a `%`
// control line must start its own physical line or Mojolicious fails to parse it, and the same is true
// of the `%` line that opens such a Block, but not of a tag-form Block (`<%= ..., begin =%>`), which has
// no such restriction and should be free to collapse with its surroundings like any other tag-form
// marker.
const needsOwnLineAnchor = (node: MojoNode): boolean =>
    (node.type === 'Block' && !isTagFormOpenMarker(node.children[0]?.text ?? '')) || isBarePercentLine(node);

// Mojo::Template suppresses a text line's trailing newline when it ends in `\`, joining it directly to
// what follows in the rendered output. A bare `\<newline>` inside a `Text` node means nothing to HTML,
// so prettier's reflow can merge it into surrounding prose, silently changing that whitespace. An empty
// wrapper anchor is spliced in after every `\<newline>` to force a hard line break there. When the `\`
// is itself glued to preceding content, `GLUED_BACKSLASH_SENTINEL` stands in for it instead of a literal
// `\`, so `stripWrappersAndSubstitute` can tell a glued backslash (needs re-merging) apart from one the
// author deliberately wrote on its own, already-isolated line (must stay separate).
const BACKSLASH_NEWLINE_RE = /\\\n/g;
const withBackslashContinuationAnchors = (text: string): string =>
    text.replace(BACKSLASH_NEWLINE_RE, (_match, offset: number) => {
        const precedingChar = offset > 0 ? text[offset - 1] : undefined;
        const isGlued = precedingChar !== undefined && !/\s/.test(precedingChar);
        const backslashText = isGlued ? GLUED_BACKSLASH_SENTINEL : '\\';
        return `${backslashText}\n${WRAPPER_OPEN_TAG}${WRAPPER_CLOSE_TAG}`;
    });

// Whether `skeletonSoFar` has an unclosed `<pre>` (plain open/close counting, not a real parser). The
// backslash-continuation anchor above is harmful inside `<pre>`, whose whitespace prettier never
// reformats.
const PRE_OPEN_TAG_RE = /<pre(?:\s[^<>]*)?>/g;
const PRE_CLOSE_TAG_RE = /<\/pre>/g;
const isInsidePre = (skeletonSoFar: string): boolean => {
    const opens = skeletonSoFar.match(PRE_OPEN_TAG_RE)?.length ?? 0;
    const closes = skeletonSoFar.match(PRE_CLOSE_TAG_RE)?.length ?? 0;
    return opens > closes;
};

// Whether `skeletonSoFar` sits inside a real HTML tag's still-open angle brackets (plain backward scan
// for the nearest real `<` or `>`, not a real parser). A marker here (e.g. splicing extra attributes via
// `<%== get_attrs(...) %>` into a `<div ...>`) can't use the own-line `<colgroup>` wrapper - nesting an
// element inside another tag's attribute list is invalid HTML and crashes prettier's HTML parser.
const isInsideOpenTagAttrs = (skeletonSoFar: string): boolean => {
    for (let i = skeletonSoFar.length - 1; i >= 0; --i) {
        const c = skeletonSoFar[i];
        if (c === '>') return false;
        if (c === '<') return /[a-zA-Z/]/.test(skeletonSoFar[i + 1] ?? '');
    }
    return false;
};

// prettier's HTML printer inserts a newline right after a `<pre ...>` tag's own `>` whenever its content
// spans multiple lines and doesn't already start with one - harmless for rendering, but it changes the
// source structure `insidePreContent` tracking assumes is untouched. `PRE_GLUE_SENTINEL` marks where
// that insertion lands so the split line can be merged back. Inserted unconditionally (not just when the
// content turns out multi-line) since an unneeded sentinel is simply deleted in place on resolution.
const insertPreGlueSentinel = (text: string): { text: string; deferredToNextNode: boolean } => {
    let deferredToNextNode = false;
    const withSentinel = text.replace(PRE_OPEN_TAG_RE, (match: string, offset: number) => {
        const matchEnd = offset + match.length;
        if (matchEnd === text.length) {
            // The tag is the last thing in this Text node - what follows isn't known yet, so defer to
            // whichever node comes next.
            deferredToNextNode = true;
            return match;
        }
        return text[matchEnd] === '\n' ? match : match + PRE_GLUE_SENTINEL;
    });
    return { text: withSentinel, deferredToNextNode };
};

// Reconstructs the real Perl source a region's nodes represent, for one combined `perltidy` call. A
// marker contributes its text with the leading `%` stripped; a `Block` recurses through its children; a
// blank line is preserved only where the source genuinely had one.
const flattenNode = (node: MojoNode): string => {
    if (node.type === 'Text') return node.text.split('\n').length > 2 ? '\n' : '';
    if (isBlankPercentLine(node)) return '\n';
    if (node.type === 'Block') return node.children.map(flattenNode).join('');
    return `${node.text.slice(1).trim()}\n`;
};

// A marker's placeholder token - no padding needed: its real content is spliced into the Doc tree
// before prettier's own fits/break decisions run (see `embed`), so its length in the skeleton never
// influences the final layout, in either pass (see `buildPass1MarkerDoc` for Pass 1's own reason).
const makePlaceholder = (id: number): string => `${MARKER_OPEN}${id.toString()}${MARKER_CLOSE}`;

interface Skeleton {
    skeleton: string;
    markers: MarkerInfo[];
}

// Builds a plain-HTML "skeleton" standing in for the whole template: every Mojo marker becomes a unique
// placeholder, and a Block's content is wrapped in the synthetic element above, so prettier's HTML
// parser sees and matches tags across Mojo markers in one combined parse.
const buildSkeleton = (programNode: MojoNode): Skeleton => {
    // Source text, used to check whether a marker sits alone on its own line - see `isOwnLine` below.
    const source = programNode.text;
    const markers: MarkerInfo[] = [];
    let skeleton = '';
    let counter = 0;

    // True if only horizontal whitespace separates `node` from the preceding newline (or file start).
    const precededByRealContent = (node: MojoNode): boolean => {
        let i = node.start - 1;
        while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) --i;
        return i >= 0 && source[i] !== '\n';
    };
    // Same as `precededByRealContent`, looking forward from `node.end`.
    const followedByRealContent = (node: MojoNode): boolean => {
        let j = node.end;
        while (j < source.length && (source[j] === ' ' || source[j] === '\t')) ++j;
        return j < source.length && source[j] !== '\n';
    };
    // True if real content touches `node.end` with zero whitespace - an adjacency that can never change
    // on a later pass, unlike an ordinary space gap. See `registerMarker`.
    const followedByZeroGapRealContent = (node: MojoNode): boolean => {
        if (node.end >= source.length) return false;
        const c = source[node.end];
        return c !== ' ' && c !== '\t' && c !== '\n';
    };
    // Same as `followedByZeroGapRealContent`, looking backward from `node.start`.
    const precededByZeroGapRealContent = (node: MojoNode): boolean => {
        if (node.start <= 0) return false;
        const c = source[node.start - 1];
        return c !== ' ' && c !== '\t' && c !== '\n';
    };
    // True if `node` is glued directly to a real HTML tag's own `>` (not another Mojo marker's `%>`) and
    // also glued forward to a `\` - Mojo's whitespace-suppression idiom. A block-level tag boundary isn't
    // space-sensitive to prettier's HTML printer, so it separates glued content unconditionally; that's
    // usually harmless, but combined with a trailing `\` it inserts a newline nothing downstream can
    // suppress, silently changing rendered output.
    const precededByRealTagBoundary = (node: MojoNode): boolean =>
        node.start > 1 && source[node.start - 1] === '>' && source[node.start - 2] !== '%' && source[node.end] === '\\';
    // True if only horizontal whitespace separates `node` from the newlines (or file boundaries) on
    // either side of it - the user wrote it alone on its own line.
    const isOwnLine = (node: MojoNode): boolean => !precededByRealContent(node) && !followedByRealContent(node);

    // Set after an inline marker whose following side has real content next to it - consumed by the
    // very next Text node to glue its own leading whitespace the same way.
    let pendingFollowingGlue = false;
    // Same deferral pattern, for `insertPreGlueSentinel`'s own last-thing-in-node case.
    let pendingPreGlue = false;

    const registerMarker = (node: MojoNode) => {
        // Consume a pending pre-glue request - this marker is the first thing after it.
        if (pendingPreGlue) {
            skeleton += PRE_GLUE_SENTINEL;
            pendingPreGlue = false;
        }
        const id = counter++;
        // A marker that's alone on its own source line but sits inside another tag's still-open
        // attribute list (see `isInsideOpenTagAttrs`) can't be treated as own-line here: nothing else
        // is around it on that source line, but structurally it's inline content within the enclosing
        // tag, not a content-flow sibling, so the own-line `<colgroup>` wrapper below doesn't apply.
        const ownLine = isOwnLine(node) && !isInsideOpenTagAttrs(skeleton);
        const insidePre = isInsidePre(skeleton);
        // `splitMarkerDelimiters` already returns `undefined` for a bare `%` control line - including a
        // structural one (`% if (...) {`, `% }`) - since only a tag-form or `%=`/`%==` shape is a
        // self-contained expression safe to hand to `perltidy` on its own; a bare structural marker
        // needs pairing with its match to be valid Perl, so it stays on the `region` path instead (see
        // `registerRegion`). A *tag-form* structural marker (`<%= ..., begin =%>`, `<% end =%>`) is just
        // as self-contained as any other tag-form marker, so it's eligible the same way - no need to
        // gate on `node.type` here at all.
        const reformat = splitMarkerDelimiters(node.text);
        markers[id] = { text: node.text, insidePre, ownLine, reformat };
        const placeholder = makePlaceholder(id);

        // A bare placeholder is just text to HTML and reflows regardless of source formatting; an
        // own-line `PlainMarker` needs to look like a real element instead so HTML preserves that
        // placement. Most structural markers don't need this - the empty-wrapper-separator logic in
        // `visitSequence` already handles their own-line separation (a `%`-opened Block, or a bare `%`
        // control line) - except a tag-form `CloseMarker`, which gets its own, narrower anchor below.
        if (node.type === 'PlainMarker' && ownLine) {
            skeleton += `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`;
            return;
        }

        // An inline marker is plain reflowable text, so a long sentence can wrap right before/after it
        // purely for width - and re-parsing that output is then indistinguishable from own-line, breaking
        // idempotency. Fixed by replacing the whitespace on whichever side has real content with
        // `NO_BREAK_SENTINEL` (a PUA character reflow can't break at), restored to a literal space
        // afterward. Skipped on a side whose opposite is already zero-gap (redundant gluing there
        // corrupts attribute lists) and never inside `<pre>`. Not gated on `node.type` (a structural
        // marker needs this exactly as much as a `PlainMarker` does): structural markers were never
        // exposed to ambiguous reflow-adjacency before, since they were always forced onto their own
        // line - now that a tag-form Block's content participates in ordinary reflow (see
        // `needsOwnLineAnchor`), a structural marker glued to real content inside or around one needs the
        // same protection, or that adjacency can silently flip between a real source and this plugin's
        // own reformatted output on a later pass, the same way it always could for a `PlainMarker`.
        if (!insidePre) {
            if (precededByRealContent(node) && !followedByZeroGapRealContent(node) && /[ \t]$/.test(skeleton)) {
                skeleton = skeleton.slice(0, -1) + NO_BREAK_SENTINEL;
            }
            if (followedByRealContent(node) && !precededByZeroGapRealContent(node)) {
                pendingFollowingGlue = true;
            }
            // Protects against prettier separating an already-glued tag boundary, independent of the
            // checks above (which guard against a gap degrading into one).
            if (precededByRealTagBoundary(node)) {
                skeleton += TAG_GLUE_SENTINEL;
            }
        }
        // A `CloseMarker`/`MidMarker` that sat alone on its own source line needs an explicit anchor here
        // regardless of tag-form-ness. A *bare* `%`-line one already can't parse any other way (Mojo
        // requires a `%` control line to start its own physical line), so this looks redundant for that
        // shape - except this marker is registered via `flush()`'s own loop, outside `visitSequence`'s
        // per-node anchor logic entirely (the only place that requirement would otherwise be enforced),
        // so without this it's just as exposed as the tag-form shape below to reflowing onto whatever
        // real content happens to precede it, purely because the combined line fits. That's not just a
        // cosmetic loss of the shape the author actually wrote (see `TAGFORM_WRAPPER_OPEN_TAG`, whose
        // content a `CloseMarker` here closes) - for the tag-form shape it's unstable across passes,
        // since "does it fit" depends on width elsewhere in the file that can itself change once
        // formatted, and for the bare shape it can silently produce a genuinely unparseable template. A
        // marker genuinely glued zero-gap in the source (`ownLine` false) is unaffected - that adjacency
        // is real and stays governed by the glue-protection above. (`isPureBlock`/`registerRegion`
        // intercepts a bare-`%`-only Block before its own structural markers ever reach `registerMarker`
        // at all, so this never fires redundantly for that path.)
        if ((node.type === 'CloseMarker' || node.type === 'MidMarker') && ownLine) {
            skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
        }
        skeleton += placeholder;
    };

    // Registers a maximal run of `isEligibleRegionMember` siblings as one combined `perltidy` unit, using
    // the same own-line wrapper mechanism as a single marker.
    const registerRegion = (nodes: MojoNode[]) => {
        const id = counter++;
        // A leading/trailing whitespace-only Text node would otherwise leave a stray blank line -
        // trimmed for the same reason `body` is.
        const text = nodes
            .map((n) => n.text)
            .join('')
            .trim();
        markers[id] = {
            text,
            insidePre: false,
            ownLine: true,
            region: { body: nodes.map(flattenNode).join('').trim() }
        };
        const placeholder = makePlaceholder(id);
        skeleton += `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`;
    };

    // A run of sibling nodes. Scans for maximal `isEligibleRegionMember` runs first, registering each as
    // one region; everything else falls through to per-node handling, including a recursed ineligible
    // Block. A whitespace-only Text node not absorbed into a region is purely structural - an empty
    // wrapper anchors the line break prettier would otherwise collapse away. This applies inside a
    // tag-form Block's own content too, same as anywhere else - a Text node here is either genuinely
    // blank (needs the anchor exactly as much as anywhere else) or a real source-level newline separating
    // real content from what follows (own-line-ness worth preserving there too, not just for markers);
    // `needsOwnLineAnchor` already returns `false` for a *tag-form* Block specifically, which is the only
    // thing that actually needs to collapse onto its surroundings, so no separate `insideTagFormBlock`
    // exception is needed here at all - an earlier version of this comment claimed one was, but that
    // turned out to be blocking a *nested* bare-`%` Block's own required anchor whenever it sat inside a
    // tag-form Block's content, corrupting the template (two `%` control lines landing on one physical
    // line, which Mojolicious can't parse) rather than just looking wrong.
    const visitSequence = (rawNodes: MojoNode[], isTopLevel = false) => {
        const nodes = collapseBlankPercentRuns(rawNodes);
        let i = 0;
        while (i < nodes.length) {
            // A region only ever starts at a real anchor, never a connector - otherwise a leading
            // blank-line separator would get silently trimmed away with the rest of the joined body.
            if (isEligibleRegionMember(nodes[i])) {
                let j = i;
                // The run ends right after the last eligible member found, not wherever the lookahead
                // stops - trailing connectors are only tentatively included.
                let end = i;
                while (j < nodes.length) {
                    const candidate = nodes[j];
                    if ((candidate.type === 'Text' && candidate.text.trim() === '') || isBlankPercentLine(candidate)) {
                        ++j;
                    } else if (isEligibleRegionMember(candidate)) {
                        ++j;
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
            // Consume a pending glue-my-following-side request from the preceding inline marker.
            const glueLeading = pendingFollowingGlue;
            pendingFollowingGlue = false;
            if (node.type === 'Text') {
                let text = node.text;
                const wasInsidePre = isInsidePre(skeleton);
                // Consume a pending pre-glue request; skipped if this node's text already starts with a
                // real newline.
                if (pendingPreGlue) {
                    pendingPreGlue = false;
                    if (!text.startsWith('\n')) text = PRE_GLUE_SENTINEL + text;
                }
                if (glueLeading && !wasInsidePre && /^[ \t]/.test(text)) {
                    text = NO_BREAK_SENTINEL + text.slice(1);
                }
                // Only scan for a newly opening `<pre>` when not already inside one.
                if (!wasInsidePre) {
                    const glued = insertPreGlueSentinel(text);
                    text = glued.text;
                    if (glued.deferredToNextNode) pendingPreGlue = true;
                }
                // A Text node's own *leading* newline, immediately followed by real content, marks a
                // genuine source-level line break between this content and whatever precedes it - always
                // a marker's placeholder or a Block's open tag, both zero-width/inline in the skeleton.
                // Without an anchor here, prettier's fill algorithm treats that newline as ordinary
                // reflow whitespace and may collapse it onto the placeholder's own line. A wholly-blank
                // Text node doesn't need this (it's handled by its own trailing-anchor case below). Same
                // exclusion as `ownLine` above: still inside a real tag's open attribute list, an element
                // here is invalid HTML and crashes prettier's parser.
                if (/^\n[ \t]*\S/.test(node.text) && !isInsideOpenTagAttrs(skeleton)) {
                    skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
                }
                skeleton += wasInsidePre ? text : withBackslashContinuationAnchors(text);
                // No anchor after the document's very last node - it would defeat prettier's own
                // trailing-blank-line stripping.
                const isTrailingAtDocumentEnd = isTopLevel && i === nodes.length - 1;
                if (node.text.trim() === '' && node.text.includes('\n') && !isTrailingAtDocumentEnd) {
                    skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
                } else if (/\n[ \t]*$/.test(node.text)) {
                    // Real text ending in a genuine trailing newline, right before something that needs
                    // its own line for correctness (a `%` control line must start its own physical line
                    // or Mojolicious fails to parse it) - narrower than the whitespace-only case above,
                    // since a tag-form marker doesn't need this. Skips forward past whitespace-only
                    // connectors to find the real next node.
                    let next = i + 1;
                    while (next < nodes.length && nodes[next].type === 'Text' && nodes[next].text.trim() === '') {
                        ++next;
                    }
                    if (next < nodes.length && needsOwnLineAnchor(nodes[next])) {
                        skeleton += WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
                    }
                }
            } else {
                visitNode(node);
            }
            ++i;
        }
    };

    const visitNode = (node: MojoNode) => {
        if (node.type === 'Block') {
            // A Block opened by a tag-form marker (`<%= ..., begin =%>`) wraps ordinary markup, not Perl
            // control-flow - `Block.children[0]` is always the OpenMarker, per the grammar
            // (`Block { OpenMarker item* (MidMarker item*)* CloseMarker }`). See `isTagFormOpenMarker` for
            // why this can't just check the delimiter style.
            const isTagForm = isTagFormOpenMarker(node.children[0]?.text ?? '');
            const openTag = isTagForm ? TAGFORM_WRAPPER_OPEN_TAG : WRAPPER_OPEN_TAG;
            const closeTag = isTagForm ? TAGFORM_WRAPPER_CLOSE_TAG : WRAPPER_CLOSE_TAG;

            let group: MojoNode[] = [];
            const flush = () => {
                if (group.length === 0) return;
                // A Block's content can open with a backslash-continuation glued directly to the marker
                // that just preceded it (`<% if ($error) { =%>\`) - Mojo::Template's own
                // newline-suppression syntax, not real content, so it visually belongs on the *marker's*
                // own line. Left as `group[0]`'s problem, it becomes the block-content wrapper's own
                // first child instead - and `WRAPPER_OPEN_TAG` (`<colgroup>`) is block-display, which
                // always pushes even a zero-gap first child onto a new line of its own, same as it would
                // any real content (confirmed against a real template, `ProblemSetDetail.html.ep`: the
                // `\` ended up alone on its own line, disconnected from `<% if ($error) { =%>`). Moving it
                // here, ahead of `openTag`, keeps it glued to the marker as intended - always the glued
                // shape (`flush` runs immediately after `registerMarker` for whatever marker preceded this
                // group, with nothing possibly in between), never the loose one `GLUED_BACKSLASH_SENTINEL`
                // exists to distinguish from.
                const first = group[0];
                if (first.type === 'Text' && first.text.startsWith('\\\n')) {
                    skeleton += GLUED_BACKSLASH_SENTINEL;
                    group[0] = { ...first, text: first.text.slice(1) };
                }
                // The inner wrapper adds a real, later-canceled indent level that compounds across
                // nested Blocks and inflates prettier's own fits/width computation beyond the real final
                // depth - only pay for it when actually needed, and only for `WRAPPER_OPEN_TAG`, whose
                // mid-tag-split quirk it exists to work around; `TAGFORM_WRAPPER_OPEN_TAG` doesn't have it.
                const needsInner = !isTagForm && needsGluedTagProtection(group);
                skeleton += openTag + (needsInner ? CONTENT_INNER_OPEN_TAG : '');
                visitSequence(group);
                skeleton += (needsInner ? CONTENT_INNER_CLOSE_TAG : '') + closeTag;
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

const MARKER_RE = new RegExp(`${MARKER_OPEN}(\\d+)${MARKER_CLOSE}`, 'g');

// Substitutes placeholders back to real text - only reached today for structural-marker and region
// placeholders, since a `reformat`-eligible marker's placeholder is already spliced out for a real Doc
// (see `buildMarkerDoc`) before this text-level pass ever runs.
const substituteMarkers = (line: string, markers: MarkerInfo[]): string =>
    line.replace(MARKER_RE, (_, id: string) => markers[Number(id)].text);

// Matches a line that's entirely one marker placeholder - gates the region `perltidy` path so it never
// fires for a marker embedded inline with other text.
const SOLE_MARKER_RE = new RegExp(`^${MARKER_OPEN}(\\d+)${MARKER_CLOSE}$`);

interface PerltidyContext {
    perltidyrcPath: string | undefined;
    useTabs: boolean;
    tabWidth: number;
    printWidth: number;
}

// A closing scaffolding tag can't carry a disambiguating attribute, so a genuine one the template's own
// HTML contains needs telling apart from this plugin's own. Both `<colgroup>` and `<bdi>` behave
// identically regardless of author for their respective purpose (forced multi-line children; ordinary
// collapsing), so a whole-document stack-based pairing scan reliably classifies every occurrence in
// document order.
const classifyTagCloses = (formatted: string, tagRe: RegExp, closeTag: string, ourOpenTags: string[]): boolean[] => {
    const closes: boolean[] = [];
    const stack: boolean[] = [];
    for (const match of formatted.matchAll(tagRe)) {
        if (match[0] === closeTag) closes.push(stack.pop() ?? false);
        else stack.push(ourOpenTags.includes(match[0]));
    }
    return closes;
};
const WRAPPER_TAG_RE = /<colgroup(?:\s[^<>]*)?>|<\/colgroup>/g;
const TAGFORM_WRAPPER_TAG_RE = /<bdi(?:\s[^<>]*)?>|<\/bdi>/g;
const classifyWrapperCloses = (formatted: string): boolean[] =>
    classifyTagCloses(formatted, WRAPPER_TAG_RE, WRAPPER_CLOSE_TAG, [WRAPPER_OPEN_TAG, MARKER_WRAPPER_OPEN_TAG]);
const classifyTagformWrapperCloses = (formatted: string): boolean[] =>
    classifyTagCloses(formatted, TAGFORM_WRAPPER_TAG_RE, TAGFORM_WRAPPER_CLOSE_TAG, [TAGFORM_WRAPPER_OPEN_TAG]);

// The visual column `line[0..endIndex)` ends at, expanding tabs to the next `tabWidth` stop the way
// `perltidy` itself does.
const visualColumn = (line: string, endIndex: number, useTabs: boolean, tabWidth: number): number => {
    let col = 0;
    for (let i = 0; i < endIndex; ++i) {
        col += useTabs && line[i] === '\t' ? tabWidth - (col % tabWidth) : 1;
    }
    return col;
};

// Walks a formatted HTML skeleton line by line, tracking the same wrapper-nesting stack
// `stripWrappersAndSubstitute` does, and reports each line's `cancelLevels`-adjusted depth via
// `onLine`. Used by depth-discovery (Pass 1, throwaway - see `extractMarkerDepths`).
const walkWrapperDepths = (formatted: string, indentUnit: string, onLine: (line: string, depth: number) => void) => {
    const stack: ('content' | 'marker' | 'inner')[] = [];
    const wrapperCloseIsOurs = classifyWrapperCloses(formatted);
    const tagformCloseIsOurs = classifyTagformWrapperCloses(formatted);
    let wrapperCloseIndex = 0;
    let tagformCloseIndex = 0;
    // A line whose content starts with `PRE_GLUE_SENTINEL` is where prettier's own newline, inserted
    // right after a `<pre ...>` tag, landed - that newline carries no indentation of its own (see
    // `insertPreGlueSentinel`), so this line's *own* leading whitespace understates where it actually
    // ends up once merged back onto the `<pre ...>` line above it. Reused instead of computed fresh.
    let previousDepth = 0;

    for (const line of formatted.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG) {
            ++wrapperCloseIndex;
            continue;
        }
        if (trimmed === TAGFORM_WRAPPER_OPEN_TAG + TAGFORM_WRAPPER_CLOSE_TAG) {
            ++tagformCloseIndex;
            continue;
        }
        if (trimmed === WRAPPER_OPEN_TAG || trimmed === TAGFORM_WRAPPER_OPEN_TAG) {
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
            if (wrapperCloseIsOurs[wrapperCloseIndex++] ?? false) {
                stack.pop();
                continue;
            }
        } else if (trimmed === TAGFORM_WRAPPER_CLOSE_TAG) {
            if (tagformCloseIsOurs[tagformCloseIndex++] ?? false) {
                stack.pop();
                continue;
            }
        } else if (trimmed === CONTENT_INNER_CLOSE_TAG) {
            stack.pop();
            continue;
        }

        let depth: number;
        if (line.startsWith(PRE_GLUE_SENTINEL)) {
            depth = previousDepth;
        } else {
            const cancelLevels = stack.filter((entry) => entry === 'marker' || entry === 'inner').length;
            let indent = line.slice(0, line.length - line.trimStart().length);
            for (let i = 0; i < cancelLevels && indent.startsWith(indentUnit); ++i)
                indent = indent.slice(indentUnit.length);
            depth = indentUnit.length === 0 ? 0 : indent.length / indentUnit.length;
        }
        previousDepth = depth;
        onLine(line, depth);
    }
};

// Learns each reformat-eligible marker's structural depth from Pass 1's throwaway layout - needed
// because `perltidy`'s width-aware wrapping needs a depth, and our Lezer AST can't supply one (HTML is
// opaque `Text` to the tokenizer). An approximation, not a guarantee - Pass 2's real Doc splicing
// guarantees final structural correctness regardless, so the only risk here is an occasionally
// slightly-off `perltidy` width budget.
const extractMarkerDepths = (formatted: string, markers: MarkerInfo[], indentUnit: string): Map<number, number> => {
    const depths = new Map<number, number>();
    walkWrapperDepths(formatted, indentUnit, (line, depth) => {
        for (const match of line.matchAll(MARKER_RE)) {
            const id = Number(match[1]);
            if (markers[id]?.reformat) depths.set(id, depth);
        }
    });
    return depths;
};

// Strips up to `depth` copies of `indentUnit` from the front of `line`, tolerating a shallower line
// (e.g. a closing brace `perltidy` welded back to a lower depth) rather than blindly trimming.
const stripDepthPrefix = (line: string, indentUnit: string, depth: number): string => {
    let result = line;
    for (let i = 0; i < depth && result.startsWith(indentUnit); ++i) result = result.slice(indentUnit.length);
    return result;
};

// Joins `lines` into a Doc - never a plain multi-line string: `printDocToString` doesn't track column
// position across an embedded `\n` in a string leaf, silently corrupting fits/width decisions for
// whatever prints after it. `useAmbientIndent` picks the line-break primitive: `hardline` (adds ambient
// indentation from wherever this Doc nests) once `lines` has had its base depth stripped; `literalline`
// (adds none) when `lines` already carries its own full, absolute indentation - raw passthrough text, or
// `perltidy`'s unstripped output for a marker inside `<pre>`. Either way, `breakParent` forces every
// enclosing HTML element to expand rather than collapse, which the old placeholder-padding approach
// could only approximate via a guessed string length.
//
// Wrapped in `group()`, not left as a bare array: `fill` (used for text mixed with inline content, e.g.
// "See" next to a marker) checks fit via `mustBeFlat`, which for a bare array stops measuring at the
// first `hardline` and reports "fits" - so a marker's first line staying short would keep it glued to
// "See" regardless of later lines. `propagateBreaks` marks a `group()` containing a `hardline` as broken
// before printing starts, and `mustBeFlat` rejects an already-broken group immediately - correctly
// treating any multi-line marker as not fitting, matching how a real multi-line element already behaves.
const linesToDoc = (lines: string[], useAmbientIndent: boolean): Doc => {
    if (lines.length === 1) return lines[0];
    const lineBreak = useAmbientIndent ? doc.builders.hardline : doc.builders.literalline;
    return doc.builders.group(doc.builders.join(lineBreak, lines));
};

// Splices each reformat-eligible marker's own *raw* text (not yet run through `perltidy`) in place of
// its placeholder, via the same `linesToDoc` shape the final splice falls back to for raw passthrough -
// so this throwaway pass's fits/break decisions already see a structurally accurate shape rather than a
// flat, length-guessed placeholder (no fixed length works: too narrow under-estimates a tag's "stay
// glued" decision, too wide can trip attribute-wrapping logic the real spliced content never does). The
// placeholder id stays glued to the first line so `extractMarkerDepths` can find where each marker landed.
const buildPass1MarkerDoc = (id: number, marker: MarkerInfo): Doc => {
    const lines = marker.text.split('\n');
    lines[0] = makePlaceholder(id) + lines[0];
    return linesToDoc(lines, !marker.insidePre);
};

// Builds the reformatted-and-glued Doc for a `reformat`-eligible marker, mirroring the delimiter-gluing
// `stripWrappersAndSubstitute` used to do at text-substitution time - or `undefined` if `perltidy` isn't
// available/fails/can't safely apply (a percent-form result that came back multi-line), so the caller
// falls back to raw passthrough.
const buildReformattedDoc = async (
    reformat: NonNullable<MarkerInfo['reformat']>,
    insidePre: boolean,
    ownLine: boolean,
    depth: number,
    indentUnit: string,
    perltidyContext: PerltidyContext
): Promise<Doc | undefined> => {
    const { prefix, body, suffix } = reformat;
    // A whitespace-control marker with no real code (`<% =%>`) has nothing to tidy - `perltidy` treats
    // the synthetic `;` alone as an empty statement, which reconstructs as a stray double space between
    // the delimiters. Left as raw passthrough instead, preserving the original exactly.
    if (body.trim() === '') return undefined;
    // A marker ending in `begin` (the same trailing-`begin` shape `classify` in tokens.ts uses to open a
    // Block) needs its closing delimiter glued to the same line as `begin` unconditionally - confirmed
    // against real Mojolicious templates that `<%= ..., begin\n=%>` fails to compile, unlike an ordinary
    // multi-line tag, where the closing delimiter is free to land on its own line.
    const mustGlueSuffix = /\bbegin\s*$/.test(body.trim());
    // `perltidy`'s own width budget doesn't know the result is about to be glued onto Mojo delimiters -
    // subtract their overhead so the reconstructed line stays within `printWidth`.
    const delimiterOverhead = prefix.length + 1 + (suffix ? suffix.length + 1 : 0);
    // A bare `<%= %>`/`%=` expression body has no trailing `;` by convention, but `perltidy` aligns
    // `?:`/`=>` chains differently for a statement with no closing `;` - append one when missing and
    // strip it back off the result's last line afterward.
    const hadTrailingSemicolon = body.trimEnd().endsWith(';');
    const perltidyInput = hadTrailingSemicolon ? body : `${body};`;
    // The synthetic `;` itself counts against perltidy's width budget - compensate so it doesn't wrap
    // one column early.
    const semicolonCompensation = hadTrailingSemicolon ? 0 : 1;
    const perltidyLines = await runPerltidy(perltidyInput, {
        configPath: perltidyContext.perltidyrcPath,
        depth,
        useTabs: perltidyContext.useTabs,
        tabWidth: perltidyContext.tabWidth,
        printWidth: Math.max(1, perltidyContext.printWidth - delimiterOverhead + semicolonCompensation)
    });
    if (!perltidyLines) return undefined;

    if (!hadTrailingSemicolon) {
        const lastIndex = perltidyLines.length - 1;
        perltidyLines[lastIndex] = perltidyLines[lastIndex].replace(/;\s*$/, '');
        // A trailing comma leaves the synthetic `;` on a line of its own; stripping it then leaves a
        // spurious blank line - drop it outright instead.
        if (perltidyLines.length > 1 && perltidyLines[lastIndex].trim() === '') {
            perltidyLines.pop();
        }
    }

    // `perltidy` aligns a `=>` chain using the unprefixed first line, unaware `prefix` is about to
    // widen it once glued on - pad every continuation line whose `=>` matches the first line's original
    // column by that same width.
    if (perltidyLines.length > 1) {
        const firstArrowIndex = perltidyLines[0].indexOf('=>');
        if (firstArrowIndex !== -1) {
            const firstArrowColumn = visualColumn(
                perltidyLines[0],
                firstArrowIndex,
                perltidyContext.useTabs,
                perltidyContext.tabWidth
            );
            const pad = ' '.repeat(prefix.length + 1);
            for (let i = 1; i < perltidyLines.length; ++i) {
                const arrowIndex = perltidyLines[i].indexOf('=>');
                if (arrowIndex === -1) continue;
                const arrowColumn = visualColumn(
                    perltidyLines[i],
                    arrowIndex,
                    perltidyContext.useTabs,
                    perltidyContext.tabWidth
                );
                if (arrowColumn === firstArrowColumn) {
                    perltidyLines[i] = perltidyLines[i].slice(0, arrowIndex) + pad + perltidyLines[i].slice(arrowIndex);
                }
            }
        }
    }

    // A percent-line (`%=`/`%==`) marker can never safely become multi-line - Mojo::Template only
    // treats a line as Perl if it starts with `%`, so a continuation line without one would be parsed
    // as literal HTML output - treat that combination as a failed run and fall back to passthrough.
    if (prefix.startsWith('%') && perltidyLines.length > 1) return undefined;

    const firstLineIndent = indentUnit.repeat(depth);
    const firstLine = perltidyLines[0].startsWith(firstLineIndent)
        ? perltidyLines[0].slice(firstLineIndent.length)
        : perltidyLines[0].trimStart();
    const firstPart = `${prefix} ${firstLine}`;

    if (perltidyLines.length === 1) {
        const flatDoc = suffix ? `${firstPart} ${suffix}` : firstPart;
        // `perltidy`'s width budget only accounts for `depth`/`printWidth`, not real neighboring text on
        // the same line (e.g. `class="foo <%= ... %> bar"`), so it can size a marker's body to fit when
        // the real, glued-together line doesn't. `conditionalGroup` offers prettier's own fits-check both
        // this flat form and a forced-multi-line fallback, which correctly accounts for real neighboring
        // content on both sides. Scoped to inline markers only: an own-line marker's
        // `MARKER_WRAPPER_OPEN_TAG` scaffolding (stripped later) sits right after it and would falsely
        // count against the same fits-check, and its width budget is already exactly right since nothing
        // real shares its line. `<pre>`'s own boundaries must stay exactly glued regardless of width, so
        // that's excluded too.
        if (insidePre || ownLine || mustGlueSuffix) return flatDoc;
        const brokenDoc = doc.builders.group([
            prefix,
            doc.builders.indent([doc.builders.hardline, firstLine]),
            doc.builders.hardline,
            suffix
        ]);
        return doc.builders.conditionalGroup([flatDoc, brokenDoc]);
    }

    // Outside `<pre>`, ambient Doc-level indentation supplies the base depth once spliced in, so
    // perltidy's own baked-in `depth`-prefix is stripped from every line to avoid doubling it. Inside
    // `<pre>` there's no such ambient mechanism (see `linesToDoc`), so perltidy's full indentation -
    // already landing exactly at `depth` - is kept as produced instead.
    const stripDepth = insidePre ? 0 : depth;
    const lastLine = perltidyLines[perltidyLines.length - 1];
    const middleParts = perltidyLines.slice(1, -1).map((line) => stripDepthPrefix(line, indentUnit, stripDepth));
    const strippedLastLine = stripDepthPrefix(lastLine, indentUnit, stripDepth);

    // The closing delimiter always glues onto the last content line - matching Mojolicious template
    // convention (and required outright for a `begin` marker, see `mustGlueSuffix`) rather than
    // prettier's own multi-line-tag convention of giving it its own line.
    const parts = [firstPart, ...middleParts, suffix ? `${strippedLastLine} ${suffix}` : strippedLastLine];

    return linesToDoc(parts, !insidePre);
};

// Builds the Doc a marker's placeholder gets spliced out for (see `embed`). Tries `perltidy`
// reformatting first for any marker with real Perl content, own-line or inline; falls back to the
// marker's raw text, unchanged, exactly as a non-reformattable marker would render.
const buildMarkerDoc = async (
    marker: MarkerInfo,
    depth: number,
    indentUnit: string,
    perltidyContext: PerltidyContext
): Promise<Doc> => {
    if (marker.reformat) {
        const reformatted = await buildReformattedDoc(
            marker.reformat,
            marker.insidePre,
            marker.ownLine,
            depth,
            indentUnit,
            perltidyContext
        );
        if (reformatted !== undefined) return reformatted;
    }
    // Raw text was never run through perltidy's brace-wrapping depth trick, so there's no synthetic
    // prefix to strip - its own lines already carry whatever relative indentation the author gave their
    // own multi-line Perl expression, which stays untouched either way.
    return linesToDoc(marker.text.split('\n'), false);
};

// Splices every `reformat`-eligible marker's placeholder out for its real Doc (built above), walking the
// html Doc tree with `doc.utils.mapDoc` *before* printing - so prettier's fits/break algorithm sees the
// marker's true shape directly instead of a padded guess. A placeholder with no entry in `markerDocs`
// (structural/region markers, which stay on the text-substitution path in `stripWrappersAndSubstitute`)
// is left as literal text, resolved later as today.
const spliceMarkerDocs = (htmlDoc: Doc, markerDocs: Map<number, Doc>): Doc =>
    doc.utils.mapDoc(htmlDoc, (node) => {
        if (typeof node !== 'string') return node;
        const matches = [...node.matchAll(MARKER_RE)];
        if (matches.length === 0) return node;
        const parts: Doc[] = [];
        let lastIndex = 0;
        for (const match of matches) {
            const start = match.index;
            if (start > lastIndex) parts.push(node.slice(lastIndex, start));
            parts.push(markerDocs.get(Number(match[1])) ?? match[0]);
            lastIndex = start + match[0].length;
        }
        if (lastIndex < node.length) parts.push(node.slice(lastIndex));
        return parts.length === 1 ? parts[0] : parts;
    });

const stripWrappersAndSubstitute = async (
    formatted: string,
    markers: MarkerInfo[],
    indentUnit: string,
    perltidyContext: PerltidyContext
): Promise<string> => {
    // prettier splits a whitespace-sensitive inline element's own closing `</tag` from its final `>`,
    // pushing the `>` onto its own line glued to whatever follows, to preserve exact zero-gap adjacency
    // when a `TAGFORM_WRAPPER_CLOSE_TAG` collapses glued to real content on both sides (see
    // `TAGFORM_WRAPPER_OPEN_TAG`). Separately, when `TAGFORM_WRAPPER_OPEN_TAG` is glued to a long
    // preceding marker, prettier can wrap its own (fake, single) attribute across multiple lines the same
    // way it would a real attribute list that doesn't fit - `<bdi\n\tdata-mojo-tagform-wrapper\n>`. Both
    // are reassembled here, before anything else, so every check below sees each tag exactly as if it
    // were never split - every occurrence of either tag is normalized back to its canonical one-line
    // form regardless of internal whitespace, and `formatted` is re-derived for the classification calls
    // just below so their own document-order counting matches this merged shape too.
    // A third shape: a *preceding sibling's* own closing tag (e.g. an empty `</colgroup>` wrapper that's
    // the last child before `</bdi>`) gets its own final `>` split onto its own line, glued to `</bdi>`
    // for the same zero-gap-preservation reason - not `</bdi>`'s own tag text, so the first replacement
    // above doesn't catch it. General across whichever tag precedes it: any bare `>` immediately before
    // `</bdi>` on its own line is always this split, never real content.
    const mergedTagformSplit = formatted
        .replaceAll(new RegExp(`${TAGFORM_WRAPPER_CLOSE_TAG.slice(0, -1)}\\n\\s*>`, 'g'), TAGFORM_WRAPPER_CLOSE_TAG)
        .replaceAll(/<bdi\s+data-mojo-tagform-wrapper\s*>/g, TAGFORM_WRAPPER_OPEN_TAG)
        .replaceAll(new RegExp(`\\n[ \\t]*>(?=${TAGFORM_WRAPPER_CLOSE_TAG})`, 'g'), '>');
    const lines = mergedTagformSplit.split('\n');
    const output: string[] = [];
    const stack: ('content' | 'marker' | 'inner')[] = [];
    const wrapperCloseIsOurs = classifyWrapperCloses(mergedTagformSplit);
    const tagformCloseIsOurs = classifyTagformWrapperCloses(mergedTagformSplit);
    let wrapperCloseIndex = 0;
    let tagformCloseIndex = 0;

    const emptySeparator = WRAPPER_OPEN_TAG + WRAPPER_CLOSE_TAG;
    const emptyTagformSeparator = TAGFORM_WRAPPER_OPEN_TAG + TAGFORM_WRAPPER_CLOSE_TAG;

    // `<pre>` content is never reformatted by prettier, so `cancelLevels`'s indent-shift assumption
    // (correct everywhere else) doesn't apply inside one - tracked separately since entering/leaving
    // isn't tied to a dedicated wrapper line, but to literal `<pre>`/`</pre>` tags anywhere on a line.
    let insidePreContent = false;
    const PRE_OPEN_LINE_RE = /<pre(?:\s[^<>]*)?>/;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === GLUED_BACKSLASH_SENTINEL) {
            // Restore the original glued adjacency: append a literal `\` to the previous line instead of
            // emitting one of its own.
            if (output.length > 0) output[output.length - 1] += '\\';
            continue;
        }

        if (trimmed === `>${GLUED_BACKSLASH_SENTINEL}`) {
            // prettier moves a whitespace-sensitive inline element's own `>` onto its own line when its
            // first child is glued to force-multiline content - cosmetic, so merge `>` and its backslash
            // back onto the previous line when the result still fits within `printWidth`.
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
            // Doesn't fit, or nothing to merge onto - fall through to normal substitution.
        }

        if (trimmed.startsWith(TAG_GLUE_SENTINEL)) {
            // prettier separated a marker from a real tag boundary it was glued to - restore that
            // adjacency unconditionally.
            if (output.length > 0) {
                output[output.length - 1] += substituteMarkers(trimmed.slice(TAG_GLUE_SENTINEL.length), markers);
            }
            continue;
        }

        if (insidePreContent) {
            if (trimmed.includes('</pre>')) insidePreContent = false;
            // Undo prettier's inserted split by gluing this line back onto the `<pre ...>` line already
            // emitted.
            if (line.startsWith(PRE_GLUE_SENTINEL) && output.length > 0) {
                output[output.length - 1] += substituteMarkers(line.slice(PRE_GLUE_SENTINEL.length), markers);
            } else {
                output.push(line === '' ? '' : substituteMarkers(line, markers));
            }
            continue;
        }

        if (trimmed === emptySeparator) {
            // This `</colgroup>` is ours, but still counts toward `classifyWrapperCloses`'s occurrence
            // order.
            ++wrapperCloseIndex;
            continue; // empty content-wrapper separator, collapsed onto one line
        }
        if (trimmed === emptyTagformSeparator) {
            ++tagformCloseIndex;
            continue;
        }
        if (trimmed === WRAPPER_OPEN_TAG || trimmed === TAGFORM_WRAPPER_OPEN_TAG) {
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
            // Default to "not ours" on an unexpected mismatch - keeping an extra line is safer than
            // dropping a real one.
            const isOurs = wrapperCloseIsOurs[wrapperCloseIndex++] ?? false;
            if (isOurs) {
                stack.pop();
                continue;
            }
            // A genuine `</colgroup>` - fall through and keep it.
        } else if (trimmed === TAGFORM_WRAPPER_CLOSE_TAG) {
            const isOurs = tagformCloseIsOurs[tagformCloseIndex++] ?? false;
            if (isOurs) {
                stack.pop();
                continue;
            }
            // A genuine `</bdi>` - fall through and keep it.
        } else if (trimmed === CONTENT_INNER_CLOSE_TAG) {
            stack.pop();
            continue;
        }

        // Captured *before* any glued-in-place close tag below pops the stack: this line's own indent
        // was produced while whatever wrapper is closing here was still open, so it needs canceling by
        // the depth at the *start* of this line, not by whatever's left once this line's own closes have
        // been accounted for (which only matters for lines that come after this one). Only counts
        // `'marker'`/`'inner'`, which are pure scaffolding depth with no semantic meaning, so always
        // wrong and always canceled; `'content'` (from `WRAPPER_OPEN_TAG`/`TAGFORM_WRAPPER_OPEN_TAG`) is
        // real, wanted nesting depth for an *ordinary* content line and is deliberately excluded here -
        // `extraCancelThisLine` below handles the one case where it still needs canceling: this line
        // specifically, when a `'content'` wrapper's own close ends up glued to real content that
        // belongs *outside* it.
        const cancelLevels = stack.filter((entry) => entry === 'marker' || entry === 'inner').length;
        // Bumped once per `'content'`-role close resolved glued-in-place below (never for the ordinary
        // own-line case, which is skipped via `continue` before reaching here) - real trailing content on
        // this same line sits *after* that wrapper closes, so its depth needs to be canceled specifically
        // for this line, even though `'content'` is otherwise never in `cancelLevels`'s filter.
        let extraCancelThisLine = 0;

        // Unlike the wrappers above, `<address data-mojo-inner>` can collapse onto its content's line -
        // strip its tag text in place instead of touching the stack.
        let content = trimmed;
        // Tracks whether any scaffolding tag below got stripped glued-in-place rather than removed as a
        // whole line, so trailing whitespace *only* left over from that removal - never from real
        // content, since `content` starts from an already-trimmed `line` - can be cleaned up afterward.
        let strippedGluedScaffolding = false;
        if (content.includes(CONTENT_INNER_OPEN_TAG) || content.includes(CONTENT_INNER_CLOSE_TAG)) {
            content = content.split(CONTENT_INNER_OPEN_TAG).join('').split(CONTENT_INNER_CLOSE_TAG).join('');
            strippedGluedScaffolding = true;
        }
        // `WRAPPER_OPEN_TAG`/`WRAPPER_CLOSE_TAG` are used two different ways: as a real content wrapper
        // (pushed/popped on `stack` as `'content'`, from `flush()`) and as a self-contained
        // "line-break anchor" pair, always emitted glued directly together with nothing between them and
        // never pushed onto `stack` at all (`emptySeparator`, `withBackslashContinuationAnchors`). Both
        // normally stay on their own exact line, so neither ever needs a glued fallback - but nesting one
        // inside a `TAGFORM_WRAPPER_OPEN_TAG` can still glue either shape to something else via the same
        // cascading mid-tag-split quirk handled below: `<bdi>`'s own splitting can pull whatever sat right
        // before its closing boundary along with it. The anchor-pair shape is checked and stripped first,
        // as a unit, advancing `wrapperCloseIndex` to stay in sync with `classifyWrapperCloses`'s
        // document-order count but never touching `stack` - it was never pushed there to begin with, so
        // popping it would corrupt tracking for whatever real wrapper actually is open. Only a *lone*
        // close left over after that - the real content-wrapper case, whose matching open genuinely was
        // pushed as `'content'` - still pops the stack, exactly as the own-line case above does, and (per
        // `extraCancelThisLine` above) bumps this line's own cancellation too.
        if (content.includes(emptySeparator)) {
            const pieces = content.split(emptySeparator);
            wrapperCloseIndex += pieces.length - 1;
            content = pieces.join('');
            strippedGluedScaffolding = true;
        }
        // Skipped when this whole (trimmed) line was already exactly `WRAPPER_CLOSE_TAG` - the exact-match
        // check above already classified and consumed that single occurrence (falling through, since it
        // was genuine, to reach the ordinary content push below); re-matching the same text here would
        // classify and consume a second, unrelated occurrence against the wrong index, corrupting both
        // this line's own content and `stack` for every line after it.
        if (trimmed !== WRAPPER_CLOSE_TAG && content.includes(WRAPPER_CLOSE_TAG)) {
            content = content.split(WRAPPER_CLOSE_TAG).reduce((acc, piece, i) => {
                if (i === 0) return piece;
                const isOurs = wrapperCloseIsOurs[wrapperCloseIndex++] ?? false;
                if (isOurs) {
                    if (stack.pop() === 'content') ++extraCancelThisLine;
                }
                return `${acc}${isOurs ? '' : WRAPPER_CLOSE_TAG}${piece}`;
            }, '');
            strippedGluedScaffolding = true;
        }
        // `<bdi data-mojo-tagform-wrapper>` can likewise collapse onto its content's line - the whole
        // point of using it instead of `WRAPPER_OPEN_TAG`. Its open tag is safe to strip unconditionally
        // (a real author-written `<bdi>` never coincidentally carries this exact attribute); its close
        // tag can't carry a disambiguating attribute, so each occurrence found here is checked, in the
        // same document order `classifyTagformWrapperCloses` scanned in, against `tagformCloseIsOurs` -
        // the same classification the own-line case above uses. `<bdi>` never pushes onto `stack` at all
        // (its content just reflows ordinarily, no cancellation needed for that), but its own depth still
        // needs canceling on this specific line - *unless* this same line also has `<bdi>`'s own open tag
        // (captured before stripping it just below), meaning the whole thing collapsed onto one line and
        // never actually contributed any extra depth to cancel in the first place.
        const hadTagformOpenOnThisLine = content.includes(TAGFORM_WRAPPER_OPEN_TAG);
        if (hadTagformOpenOnThisLine) {
            content = content.split(TAGFORM_WRAPPER_OPEN_TAG).join('');
            strippedGluedScaffolding = true;
        }
        // Same reasoning as the `WRAPPER_CLOSE_TAG` guard above - a line that was exactly
        // `TAGFORM_WRAPPER_CLOSE_TAG` was already classified and consumed by the exact-match check.
        if (trimmed !== TAGFORM_WRAPPER_CLOSE_TAG && content.includes(TAGFORM_WRAPPER_CLOSE_TAG)) {
            content = content.split(TAGFORM_WRAPPER_CLOSE_TAG).reduce((acc, piece, i) => {
                if (i === 0) return piece;
                const isOurs = tagformCloseIsOurs[tagformCloseIndex++] ?? false;
                if (isOurs && !hadTagformOpenOnThisLine) ++extraCancelThisLine;
                return `${acc}${isOurs ? '' : TAGFORM_WRAPPER_CLOSE_TAG}${piece}`;
            }, '');
            strippedGluedScaffolding = true;
        }
        // Two adjacent scaffolding tags stripped glued-in-place (e.g. `WRAPPER_CLOSE_TAG` immediately
        // followed by `TAGFORM_WRAPPER_CLOSE_TAG`, both removed above) can leave behind whatever real
        // whitespace originally separated *them* - not real content, since neither tag itself ever
        // renders anything, so collapsing it the same way HTML would collapse any other redundant
        // whitespace run is safe.
        if (strippedGluedScaffolding) content = content.replace(/ {2,}/g, ' ').trim();
        // A glued backslash whose line stayed glued (short enough) - restore the literal `\` in place.
        if (content.includes(GLUED_BACKSLASH_SENTINEL)) {
            content = content.split(GLUED_BACKSLASH_SENTINEL).join('\\');
        }
        // Converts back to a literal space - except right at this (trimmed) line's own edge, where it
        // resolves to nothing instead. A sentinel can end up there when whatever it was guarding against
        // reflowing next to gets separated onto its own line anyway by unrelated HTML layout (e.g. an
        // attribute list wrapping one-per-line) - the real newline already provides the separation, so a
        // literal space there would be a redundant leading/trailing space, and - since whether that
        // separation happens depends on layout decisions made by *this* pass, not by anything in the
        // marker's own original source shape - a non-idempotent one: a later pass, seeing the marker
        // already own-line, wouldn't regenerate it.
        if (content.includes(NO_BREAK_SENTINEL)) {
            if (content.startsWith(NO_BREAK_SENTINEL)) content = content.slice(NO_BREAK_SENTINEL.length);
            if (content.endsWith(NO_BREAK_SENTINEL)) content = content.slice(0, -NO_BREAK_SENTINEL.length);
            content = content.split(NO_BREAK_SENTINEL).join(' ');
        }
        // Deletes outright when content stayed glued to the `<pre ...>` line - unlike other sentinels,
        // it never stands in for a real character.
        if (content.includes(PRE_GLUE_SENTINEL)) {
            content = content.split(PRE_GLUE_SENTINEL).join('');
        }
        // Fallback for when it survives glued in place rather than separated onto its own line.
        if (content.includes(TAG_GLUE_SENTINEL)) {
            content = content.split(TAG_GLUE_SENTINEL).join('');
        }

        // Each open 'inner'/'marker' wrapper added one indent level to cancel; an own-line marker nests
        // both at once (`cancelLevels` captured above, before this line's own glued closes) - plus
        // `extraCancelThisLine`, for a `'content'`-role wrapper whose own close resolved glued-in-place
        // on this same line.
        let indent = line.slice(0, line.length - line.trimStart().length);
        const totalCancelLevels = cancelLevels + extraCancelThisLine;
        // One `indentUnit` per level, not per character - with `useTabs`, one tab is one level
        // regardless of `tabWidth`.
        for (let i = 0; i < totalCancelLevels && indent.startsWith(indentUnit); ++i)
            indent = indent.slice(indentUnit.length);

        // A pure-Perl region (see `registerRegion`/`flattenNode`): every returned line is symmetric -
        // there's no delimiter to glue a first line onto, so all of them (including the first) keep
        // their full real indent, with `% ` inserted after each line's own leading whitespace.
        const soleMatch = SOLE_MARKER_RE.exec(content);
        const marker = soleMatch ? markers[Number(soleMatch[1])] : undefined;
        if (marker?.region) {
            const depth = indentUnit.length === 0 ? 0 : indent.length / indentUnit.length;
            // Every line gets `% ` (2 columns) perltidy's own budget never accounted for.
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

        // A line that was nothing but glued-together scaffolding tags (e.g. an empty `WRAPPER_CLOSE_TAG`
        // fused with `TAGFORM_WRAPPER_CLOSE_TAG` by the mid-tag-split merge above) strips down to nothing
        // real at all - unlike the exact-own-line `emptySeparator`/`emptyTagformSeparator` cases above,
        // this shape only reveals itself after the glued-fallback stripping runs, so it can't `continue`
        // that early; skipped here instead, the same way, rather than emitting a spurious blank line.
        if (strippedGluedScaffolding && content === '') continue;

        // Everything up to the matching `</pre>` is verbatim content; this line itself still gets normal
        // indent handling.
        if (PRE_OPEN_LINE_RE.test(content) && !content.includes('</pre>')) insidePreContent = true;

        output.push(line === '' ? '' : indent + substituteMarkers(content, markers));
    }

    return output.join('\n');
};

// print() is effectively unreachable: embed() below fully handles the root (Program) node.
export const printMojoNode = (path: AstPath<MojoNode>): Doc => path.node.text;

export const embed = (path: AstPath<MojoNode>, options: Options) => {
    if (path.node.type !== 'Program') return null;

    return async (textToDoc: (text: string, opts: Options) => Promise<Doc>): Promise<Doc> => {
        const { skeleton, markers } = buildSkeleton(path.node);
        const tabWidth = options.tabWidth ?? 2;
        const indentUnit = options.useTabs ? '\t' : ' '.repeat(tabWidth);
        const printOpts = options as unknown as Parameters<typeof doc.printer.printDocToString>[1];
        const perltidyContext: PerltidyContext = {
            // Searched once per file, walking upward from the template's own directory.
            perltidyrcPath: findPerltidyrc(dirname(options.filepath ?? process.cwd())),
            useTabs: options.useTabs ?? false,
            tabWidth,
            printWidth: options.printWidth ?? 80
        };

        // Pass 1: throwaway HTML layout of the skeleton (see `buildPass1MarkerDoc`/`extractMarkerDepths`).
        const doc1 = await textToDoc(skeleton, { parser: 'html' });
        const pass1Docs = new Map<number, Doc>();
        for (let id = 0; id < markers.length; ++id) {
            const marker = markers[id];
            if (marker.reformat) pass1Docs.set(id, buildPass1MarkerDoc(id, marker));
        }
        const splicedDoc1 = spliceMarkerDocs(doc1, pass1Docs);
        const { formatted: formatted1 } = doc.printer.printDocToString(splicedDoc1, printOpts);
        const depths = extractMarkerDepths(formatted1, markers, indentUnit);

        // Between passes: every marker with real Perl content gets tidied now that its depth is known.
        const markerDocs = new Map<number, Doc>();
        for (let id = 0; id < markers.length; ++id) {
            const marker = markers[id];
            if (!marker.reformat) continue;
            markerDocs.set(id, await buildMarkerDoc(marker, depths.get(id) ?? 0, indentUnit, perltidyContext));
        }

        // Pass 2: fresh HTML layout with each marker's placeholder spliced out for its real Doc before
        // prettier's fits/break decisions run.
        const doc2 = await textToDoc(skeleton, { parser: 'html' });
        const splicedDoc = spliceMarkerDocs(doc2, markerDocs);
        const { formatted: formatted2 } = doc.printer.printDocToString(splicedDoc, printOpts);

        const result = await stripWrappersAndSubstitute(formatted2, markers, indentUnit, perltidyContext);
        return `${result}\n`;
    };
};
