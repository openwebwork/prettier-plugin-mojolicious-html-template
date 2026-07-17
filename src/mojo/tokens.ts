import { ExternalTokenizer, type InputStream } from '@lezer/lr';
import { Text, OpenMarker, CloseMarker, MidMarker, PlainMarker } from './mojo.grammar.terms.js';

const NEWLINE = 10; // '\n'
const PERCENT = 37; // '%'
const LT = 60; // '<'
const GT = 62; // '>'
const EQUALS = 61; // '='
const SPACE = 32; // ' '
const TAB = 9; // '\t'
const HASH = 35; // '#'
const SINGLE_QUOTE = 39; // "'"
const DOUBLE_QUOTE = 34; // '"'
const BACKSLASH = 92; // '\\'

// If a Perl string (single- or double-quoted, following the same shape as codemirror-lang-perl's
// `StringSingleQuoted`/`StringDoubleQuoted` tokens) or a `#` comment starts at `offset`, returns the
// offset just past it (end of the closing quote, or end of line for a comment). Otherwise returns
// `offset` unchanged. This keeps a literal `%>` inside a string like `<%= "50%>" %>` from being
// mistaken for the tag's real closing delimiter.
const skipStringOrComment = (input: InputStream, offset: number): number => {
    const c = input.peek(offset);
    if (c === HASH) {
        let o = offset + 1;
        while (input.peek(o) !== NEWLINE && input.peek(o) !== -1) o++;
        return o;
    }
    if (c === SINGLE_QUOTE || c === DOUBLE_QUOTE) {
        let o = offset + 1;
        while (input.peek(o) !== c && input.peek(o) !== -1) {
            if (input.peek(o) === BACKSLASH) o++;
            o++;
        }
        return o + 1;
    }
    return offset;
};

// A control line/tag "opens" a block if its Perl content ends with `{` or the `begin` keyword, and
// "closes" one if it starts with `}` or the `end` keyword. A line can do both at once (`} else {`,
// `} elsif (...) {`, or even `end; begin` in principle) - those become MidMarker tokens.
const classify = (content: string): number => {
    const trimmed = content.trim();
    const opens = /\{\s*$/.test(trimmed) || /\bbegin\s*$/.test(trimmed);
    const closes = trimmed.startsWith('}') || /^end\b/.test(trimmed);
    if (opens && closes) return MidMarker;
    if (opens) return OpenMarker;
    if (closes) return CloseMarker;
    return PlainMarker;
};

const sliceByPeek = (input: InputStream, from: number, to: number): string => {
    let text = '';
    for (let offset = from; offset < to; offset++) text += String.fromCharCode(input.peek(offset));
    return text;
};

// Given that `offset` is already known to be a line start, returns how much [ \t]* leading
// whitespace (relative to `offset`) precedes a '%' that starts a percent control line there, or -1
// if there's no percent line at that position.
const percentLineIndent = (input: InputStream, offset: number): number => {
    let ws = 0;
    while (input.peek(offset + ws) === SPACE || input.peek(offset + ws) === TAB) ws++;
    return input.peek(offset + ws) === PERCENT ? ws : -1;
};

export const tokenizeMojo = new ExternalTokenizer((input: InputStream) => {
    if (input.next === -1) return;

    const atLineStart = input.pos === 0 || input.peek(-1) === NEWLINE;

    // A standalone `%` control line, possibly indented: from the (optionally indented) `%` to the
    // end of the line (excluding the newline and the leading whitespace itself).
    if (atLineStart) {
        const ws = percentLineIndent(input, 0);
        if (ws !== -1) {
            let offset = ws + 1;
            while (input.peek(offset) !== NEWLINE && input.peek(offset) !== -1) offset++;
            input.acceptToken(classify(sliceByPeek(input, ws + 1, offset)), offset);
            return;
        }
    }

    // An inline `<% ... %>` tag, found in full on one lookahead scan.
    if (input.next === LT && input.peek(1) === PERCENT) {
        let offset = 2;
        while (!(input.peek(offset - 1) === PERCENT && input.peek(offset) === GT) && input.peek(offset) !== -1) {
            const skipped = skipStringOrComment(input, offset);
            offset = skipped === offset ? offset + 1 : skipped;
        }
        if (input.peek(offset) === GT) {
            // The '%' right before '>' is always the delimiter; a '=' before that is the "trim
            // the following newline" modifier (`=%>`), not part of the Perl content, so strip it too.
            const contentEnd = input.peek(offset - 2) === EQUALS ? offset - 2 : offset - 1;
            input.acceptToken(classify(sliceByPeek(input, 2, contentEnd)), offset + 1);
            return;
        }
        // No closing `%>` was found; fall through and treat the `<` as ordinary text.
    }

    // Anything else is Text, up to (but not including) the start of the next marker - including
    // any whitespace that precedes an indented percent-line, so that line's leading whitespace
    // isn't consumed as text before the marker check above gets a chance to run on it.
    let offset = 1;
    for (;;) {
        const c = input.peek(offset);
        if (c === -1) break;
        if (c === LT && input.peek(offset + 1) === PERCENT) break;
        if (input.peek(offset - 1) === NEWLINE && percentLineIndent(input, offset) !== -1) break;
        offset++;
    }
    input.acceptToken(Text, offset);
});
