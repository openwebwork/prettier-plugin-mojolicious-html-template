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
const DOLLAR = 36; // '$'
const SINGLE_QUOTE = 39; // "'"
const DOUBLE_QUOTE = 34; // '"'
const BACKSLASH = 92; // '\\'
const LOWER_Q = 113; // 'q'
const LOWER_W = 119; // 'w'
const LOWER_R = 114; // 'r'

const isIdentChar = (c: number): boolean =>
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95; // a-z A-Z 0-9 _

// Perl's bracket-style quote delimiters nest (`q{ a { nested } brace }`). Every other delimiter
// closes with itself (`q!...!`, `q#...#`, etc).
const QUOTE_LIKE_CLOSERS: Partial<Record<number, number>> = {
    40: 41, // ( )
    123: 125, // { }
    91: 93, // [ ]
    60: 62 // < >
};

// Skips a Perl quote-like operator (`q`, `qq`, `qw`, `qr`) starting at `offset`, honoring nested
// bracket-style delimiters. Returns `offset` unchanged if none starts there.
const skipQuoteLikeOperator = (input: InputStream, offset: number): number => {
    if (offset > 0 && isIdentChar(input.peek(offset - 1))) return offset; // e.g. the "q" in "req"
    if (input.peek(offset) !== LOWER_Q) return offset;

    let o = offset + 1;
    const second = input.peek(o);
    if (second === LOWER_Q || second === LOWER_W || second === LOWER_R) ++o; // qq, qw, qr

    while (input.peek(o) === SPACE || input.peek(o) === TAB || input.peek(o) === NEWLINE) ++o;

    const startDelim = input.peek(o);
    if (startDelim < 0 || isIdentChar(startDelim) || startDelim === SPACE || startDelim === TAB) return offset;
    ++o;

    const endDelim = QUOTE_LIKE_CLOSERS[startDelim] ?? startDelim;
    let depth = 1;
    while (depth > 0) {
        const c = input.peek(o);
        if (c === -1) return offset; // unterminated, bail
        if (c === BACKSLASH) {
            o += 2;
            continue;
        }
        if (endDelim !== startDelim && c === startDelim) ++depth;
        else if (c === endDelim) --depth;
        ++o;
    }
    return o;
};

// Skips a Perl string, quote-like operator, or `#` comment starting at `offset`, so a literal `%>`
// inside one (`<%= "50%>" %>`) isn't mistaken for the tag's real closing delimiter.
const skipStringOrComment = (input: InputStream, offset: number): number => {
    const quoteLike = skipQuoteLikeOperator(input, offset);
    if (quoteLike !== offset) return quoteLike;

    const c = input.peek(offset);
    if (c === HASH && input.peek(offset - 1) !== DOLLAR) {
        // `$#array` is Perl's "last index" sigil, not a comment. Also stops at a tag's own closing
        // `%>`, e.g. a whole-line comment tag (`<%# comment %>`), rather than only at a newline.
        let o = offset + 1;
        while (
            input.peek(o) !== NEWLINE &&
            input.peek(o) !== -1 &&
            !(input.peek(o) === PERCENT && input.peek(o + 1) === GT)
        ) {
            ++o;
        }
        return o;
    }
    if ((c === SINGLE_QUOTE || c === DOUBLE_QUOTE) && input.peek(offset - 1) !== BACKSLASH) {
        // A quote preceded by a backslash is an escaped literal (`s/\"//g`), not a string opener.
        let o = offset + 1;
        while (input.peek(o) !== c && input.peek(o) !== -1) {
            if (input.peek(o) === BACKSLASH) ++o;
            ++o;
        }
        if (input.peek(o) === -1) return offset; // unterminated, bail
        return o + 1;
    }
    return offset;
};

// Skips the `=`/`==` output sigil (`%=`, `<%=`, `<%==`) so `classify` sees only the Perl content.
const skipOutputSigil = (input: InputStream, offset: number): number => {
    let o = offset;
    if (input.peek(o) === EQUALS) ++o;
    if (input.peek(o) === EQUALS) ++o;
    return o;
};

// Opens a Block if the Perl content ends with `{`/`begin`, closes one if it starts with `}`/`end`.
// Both at once (`} else {`) is a MidMarker.
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
    for (let offset = from; offset < to; ++offset) text += String.fromCharCode(input.peek(offset));
    return text;
};

// Leading [ \t]* whitespace before a '%' control line at `offset`, or -1 if there's no percent line
// there.
const percentLineIndent = (input: InputStream, offset: number): number => {
    let ws = 0;
    while (input.peek(offset + ws) === SPACE || input.peek(offset + ws) === TAB) ++ws;
    return input.peek(offset + ws) === PERCENT ? ws : -1;
};

const isLineStart = (input: InputStream): boolean => {
    let i = -1;
    while (input.peek(i) === SPACE || input.peek(i) === TAB) --i;
    const c = input.peek(i);
    return c === NEWLINE || c === -1;
};

export const tokenizeMojo = new ExternalTokenizer((input: InputStream) => {
    if (input.next === -1) return;

    // A standalone `%` control line, from the `%` to end of line. Leading indentation is its own
    // Text token, consumed below.
    if (input.next === PERCENT && isLineStart(input)) {
        let offset = 1;
        let codeEnd = -1;
        while (input.peek(offset) !== NEWLINE && input.peek(offset) !== -1) {
            if (codeEnd === -1 && input.peek(offset) === HASH && input.peek(offset - 1) !== DOLLAR) codeEnd = offset;
            const skipped = skipStringOrComment(input, offset);
            offset = skipped === offset ? offset + 1 : skipped;
        }
        const classifyEnd = codeEnd === -1 ? offset : codeEnd;
        const contentStart = skipOutputSigil(input, 1);
        input.acceptToken(classify(sliceByPeek(input, contentStart, classifyEnd)), offset);
        return;
    }

    // An inline `<% ... %>` tag, found in full on one lookahead scan.
    if (input.next === LT && input.peek(1) === PERCENT) {
        let offset = 2;
        let codeEnd = -1;
        while (!(input.peek(offset - 1) === PERCENT && input.peek(offset) === GT) && input.peek(offset) !== -1) {
            if (codeEnd === -1 && input.peek(offset) === HASH && input.peek(offset - 1) !== DOLLAR) codeEnd = offset;
            const skipped = skipStringOrComment(input, offset);
            offset = skipped === offset ? offset + 1 : skipped;
        }
        if (input.peek(offset) === GT) {
            // A '=' right before the closing '%' is the `=%>` trim modifier, not Perl content.
            const contentEnd = input.peek(offset - 2) === EQUALS ? offset - 2 : offset - 1;
            const classifyEnd = codeEnd === -1 ? contentEnd : Math.min(codeEnd, contentEnd);
            const contentStart = skipOutputSigil(input, 2);
            input.acceptToken(classify(sliceByPeek(input, contentStart, classifyEnd)), offset + 1);
            return;
        }

        // No closing `%>` found. Fall through and treat the `<` as ordinary text.
    }

    // Leading [ \t]* indentation of a percent-line, as its own Text token, so the marker branch above
    // starts exactly at '%' next call.
    if ((input.next === SPACE || input.next === TAB) && isLineStart(input)) {
        const ws = percentLineIndent(input, 0);
        if (ws > 0) {
            input.acceptToken(Text, ws);
            return;
        }
    }

    // Anything else is Text, up to the start of the next marker.
    let offset = 1;
    for (;;) {
        const c = input.peek(offset);
        if (c === -1) break;
        if (c === LT && input.peek(offset + 1) === PERCENT) break;
        if (input.peek(offset - 1) === NEWLINE && percentLineIndent(input, offset) !== -1) break;
        ++offset;
    }
    input.acceptToken(Text, offset);
});
