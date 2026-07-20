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
const MARKER_PAD = String.fromCharCode(0xe002);
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
// short, which is wrong for Perl control-flow blocks. `<ol>` and `<select>` were tried first but each
// broke real content in different ways; `<colgroup>` avoids both and collides least with genuine
// template markup. The closing `</colgroup>` is still plain text, so a real `<colgroup>` elsewhere in
// the template is a collision handled below by `classifyWrapperCloses`.
const WRAPPER_OPEN_TAG = '<colgroup data-mojo-wrapper>';
const WRAPPER_CLOSE_TAG = '</colgroup>';

// A second wrapper for a single own-line `PlainMarker`: the same "look like a real element" trick, but
// without the extra indent level the content wrapper adds.
const MARKER_WRAPPER_OPEN_TAG = '<colgroup data-mojo-marker>';

// A third wrapper, nested inside the content wrapper, applied only when a Block's content has an inline
// element glued to trailing bare text (see `needsGluedTagProtection`) - works around the outer wrapper's
// own mid-tag-split quirk in that shape.
const CONTENT_INNER_OPEN_TAG = '<address data-mojo-inner>';
const CONTENT_INNER_CLOSE_TAG = '</address>';

// An own-line marker complete in isolation (tag-form, or `%=`/`%==`) gets `reformat` populated so
// `stripWrappersAndSubstitute` runs it through `perltidy`. Bare `%` lines and structural markers are
// excluded - neither is safe to reformat as an isolated unit.
interface MarkerInfo {
    text: string;
    reformat?: { prefix: string; body: string; suffix: string };
    region?: { body: string };
}

// Splits a reformat-eligible own-line `PlainMarker`'s text into its delimiter and body, or `undefined`
// for a shape this phase doesn't handle.
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
            i++;
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
// rather than a real wrapper element: a bare `%` line, or a `Block`.
const needsOwnLineAnchor = (node: MojoNode): boolean => node.type === 'Block' || isBarePercentLine(node);

// Mojo::Template suppresses a text line's trailing newline when it ends in `\`, joining it directly to
// what follows in the rendered output. A bare `\<newline>` inside a `Text` node means nothing to HTML,
// so prettier's reflow can merge it into surrounding prose, silently changing that whitespace. An empty
// wrapper anchor is spliced in after every `\<newline>` to force a hard line break there. When the `\`
// is itself glued to preceding content, `GLUED_BACKSLASH_SENTINEL` stands in for it instead of a literal
// `\`, so `stripWrappersAndSubstitute` can tell a glued backslash (needs re-merging) apart from one the
// author deliberately wrote on its own, already-isolated line (must stay separate).
const BACKSLASH_NEWLINE_RE = /\\\n/g;
const withBackslashContinuationAnchors = (text: string): string =>
    text.replace(BACKSLASH_NEWLINE_RE, (match, offset: number) => {
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

// prettier's HTML printer unconditionally inserts a newline right after a `<pre ...>` tag's own `>`
// whenever its content spans multiple lines and doesn't already start with one - harmless for rendering,
// but it changes the template's own source structure that `insidePreContent` tracking (in
// `stripWrappersAndSubstitute`) assumes is untouched. `PRE_GLUE_SENTINEL` marks where the insertion will
// land, so that tracking can merge the split line back onto the `<pre ...>` line, undoing it.
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

// Builds a placeholder token padded out to roughly `firstLineLength` so prettier's HTML printer makes
// realistic fits/line-wrap decisions on the skeleton.
const makePlaceholder = (id: number, firstLineLength: number): string => {
    const overhead = MARKER_OPEN.length + id.toString().length + MARKER_CLOSE.length;
    const padding = MARKER_PAD.repeat(Math.max(0, firstLineLength - overhead));
    return `${MARKER_OPEN}${id.toString()}${padding}${MARKER_CLOSE}`;
};

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
        while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
        return i >= 0 && source[i] !== '\n';
    };
    // Same as `precededByRealContent`, looking forward from `node.end`.
    const followedByRealContent = (node: MojoNode): boolean => {
        let j = node.end;
        while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
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
        const ownLine = isOwnLine(node);
        const reformat = node.type === 'PlainMarker' && ownLine ? splitMarkerDelimiters(node.text) : undefined;
        markers[id] = { text: node.text, reformat };
        // Pad to the real marker's first-line length so fits/wrap decisions match the real text.
        const placeholder = makePlaceholder(id, node.text.split('\n', 1)[0].length);

        // A bare placeholder is just text to HTML and reflows regardless of source formatting; an
        // own-line `PlainMarker` needs to look like a real element instead so HTML preserves that
        // placement. Structural markers don't need this - the empty-wrapper-separator logic in
        // `visitSequence` already handles their own-line separation.
        if (node.type === 'PlainMarker' && ownLine) {
            skeleton += `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`;
            return;
        }

        // An inline marker that isn't own-line is plain reflowable text, so a long sentence can wrap
        // right before/after it purely for width - and re-parsing that output is then indistinguishable
        // from the marker having been written alone on its own line, breaking idempotency (`isOwnLine`
        // flips, the marker gets re-wrapped, indentation shifts). Fixed by replacing the whitespace on
        // whichever side has real content with `NO_BREAK_SENTINEL`, a non-whitespace PUA character
        // reflow can't break at, restored to a literal space afterward. Only applied to a side whose
        // opposite side isn't already zero-gap (redundant gluing there corrupts attribute lists or blocks
        // a legitimate line break instead) and never inside `<pre>`, whose content bypasses this
        // substitution entirely.
        if (node.type === 'PlainMarker' && !isInsidePre(skeleton)) {
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
        markers[id] = { text, region: { body: nodes.map(flattenNode).join('').trim() } };
        const placeholder = makePlaceholder(id, text.split('\n', 1)[0].length);
        skeleton += `${MARKER_WRAPPER_OPEN_TAG}${placeholder}${WRAPPER_CLOSE_TAG}`;
    };

    // A run of sibling nodes. Scans for maximal `isEligibleRegionMember` runs first, registering each as
    // one region; everything else falls through to per-node handling, including a recursed ineligible
    // Block. A whitespace-only Text node not absorbed into a region is purely structural - an empty
    // wrapper anchors the line break prettier would otherwise collapse away.
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
                // The inner wrapper adds a real, later-canceled indent level that compounds across
                // nested Blocks and inflates prettier's own fits/width computation beyond the real final
                // depth - only pay for it when actually needed.
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

// Substitutes placeholders back to real Perl text. Only the marker's first line gets the surrounding
// indent; continuation lines keep whatever indentation the user originally wrote.
const substituteMarkers = (line: string, markers: MarkerInfo[]): string =>
    line.replace(MARKER_RE, (_, id: string) => markers[Number(id)].text);

// Matches a line that's entirely one marker placeholder - gates the `perltidy` path so it never fires
// for an inline marker.
const SOLE_MARKER_RE = new RegExp(`^${MARKER_OPEN}(\\d+)${MARKER_PAD}*${MARKER_CLOSE}$`);

// Walks the formatted HTML skeleton line by line, dropping pure-scaffolding wrapper lines and
// substituting every other line's marker placeholders back to real text.
interface PerltidyContext {
    perltidyrcPath: string | undefined;
    useTabs: boolean;
    tabWidth: number;
    printWidth: number;
}

// A closing `</colgroup>` can't carry a disambiguating attribute, so a genuine one the template's own
// HTML contains needs telling apart from this wrapper's own. `<colgroup>` always forces its children
// onto their own line regardless of author, so a whole-document stack-based pairing scan reliably
// classifies every occurrence in document order.
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

// The visual column `line[0..endIndex)` ends at, expanding tabs to the next `tabWidth` stop the way
// `perltidy` itself does.
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
            // Default to "not ours" on an unexpected mismatch - keeping an extra line is safer than
            // dropping a real one.
            const isOurs = wrapperCloseIsOurs[wrapperCloseIndex++] ?? false;
            if (isOurs) {
                stack.pop();
                continue;
            }
            // A genuine `</colgroup>` - fall through and keep it.
        } else if (trimmed === CONTENT_INNER_CLOSE_TAG) {
            stack.pop();
            continue;
        }

        // Unlike the wrappers above, `<address data-mojo-inner>` can collapse onto its content's line -
        // strip its tag text in place instead of touching the stack.
        let content = trimmed;
        if (content.includes(CONTENT_INNER_OPEN_TAG) || content.includes(CONTENT_INNER_CLOSE_TAG)) {
            content = content.split(CONTENT_INNER_OPEN_TAG).join('').split(CONTENT_INNER_CLOSE_TAG).join('');
        }
        // A glued backslash whose line stayed glued (short enough) - restore the literal `\` in place.
        if (content.includes(GLUED_BACKSLASH_SENTINEL)) {
            content = content.split(GLUED_BACKSLASH_SENTINEL).join('\\');
        }
        // Converts back to a literal space; can never end up alone on its own line.
        if (content.includes(NO_BREAK_SENTINEL)) {
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
        // both at once.
        const cancelLevels = stack.filter((entry) => entry === 'marker' || entry === 'inner').length;
        let indent = line.slice(0, line.length - line.trimStart().length);
        // One `indentUnit` per level, not per character - with `useTabs`, one tab is one level
        // regardless of `tabWidth`.
        for (let i = 0; i < cancelLevels && indent.startsWith(indentUnit); i++)
            indent = indent.slice(indentUnit.length);

        // A line that's entirely one reformat-eligible marker gets run through `perltidy`; `depth`
        // drives its brace-wrapping indent trick.
        const soleMatch = SOLE_MARKER_RE.exec(content);
        const marker = soleMatch ? markers[Number(soleMatch[1])] : undefined;
        if (marker?.reformat) {
            const { prefix, body, suffix } = marker.reformat;
            const depth = indentUnit.length === 0 ? 0 : indent.length / indentUnit.length;
            // `perltidy`'s own width budget doesn't know the result is about to be glued onto Mojo
            // delimiters - subtract their overhead so the reconstructed line stays within `printWidth`.
            const delimiterOverhead = prefix.length + 1 + (suffix ? suffix.length + 1 : 0);
            // A bare `<%= %>`/`%=` expression body has no trailing `;` by convention, but `perltidy`
            // aligns `?:`/`=>` chains differently for a statement with no closing `;` - append one when
            // missing and strip it back off the result's last line afterward.
            const hadTrailingSemicolon = body.trimEnd().endsWith(';');
            const perltidyInput = hadTrailingSemicolon ? body : `${body};`;
            // The synthetic `;` itself counts against perltidy's width budget - compensate so it doesn't
            // wrap one column early.
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
                // A trailing comma leaves the synthetic `;` on a line of its own; stripping it then
                // leaves a spurious blank line - drop it outright instead.
                if (perltidyLines.length > 1 && perltidyLines[lastIndex].trim() === '') {
                    perltidyLines.pop();
                }
            }
            // `perltidy` aligns a `=>` chain using the unprefixed first line, unaware `prefix` is about
            // to widen it once glued on - pad every continuation line whose `=>` matches the first
            // line's original column by that same width.
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
            // A `%=`/`%==` marker can never safely become multi-line - treat that as a failed run and
            // fall back to passthrough.
            const isPercentForm = prefix.startsWith('%');
            if (perltidyLines && !(isPercentForm && perltidyLines.length > 1)) {
                // The first line gets glued onto its delimiter, so its own depth-indent (intact from
                // `runPerltidy`) needs stripping before gluing; every other line keeps it.
                const firstLineIndent = indentUnit.repeat(depth);
                const firstLine = perltidyLines[0].startsWith(firstLineIndent)
                    ? perltidyLines[0].slice(firstLineIndent.length)
                    : perltidyLines[0].trimStart();
                if (perltidyLines.length === 1) {
                    const suffixPart = suffix ? ` ${suffix}` : '';
                    output.push(`${indent}${prefix} ${firstLine}${suffixPart}`);
                } else {
                    // Glue the closing delimiter onto the last line only if it's back at the marker's
                    // own depth (a real closer, not a deeper continuation line).
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

        // A pure-Perl region: every line is symmetric, so all of them (including the first) keep their
        // full real indent, with `% ` inserted after each line's own leading whitespace.
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
        const htmlDoc = await textToDoc(skeleton, { parser: 'html' });
        // `options` is fully resolved by the time embed() runs, even though its declared type marks
        // fields optional.
        const { formatted } = doc.printer.printDocToString(
            htmlDoc,
            options as unknown as Parameters<typeof doc.printer.printDocToString>[1]
        );
        const tabWidth = options.tabWidth ?? 2;
        const indentUnit = options.useTabs ? '\t' : ' '.repeat(tabWidth);
        // Searched once per file, walking upward from the template's own directory.
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
