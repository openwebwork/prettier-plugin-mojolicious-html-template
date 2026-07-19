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
const LOWER_Q = 113; // 'q'
const LOWER_W = 119; // 'w'
const LOWER_R = 114; // 'r'

const isIdentChar = (c: number): boolean =>
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95; // a-z A-Z 0-9 _

// Perl's bracket-style quote delimiters nest (`q{ a { nested } brace }` is one string), so the matching
// close is looked up here; every other delimiter character closes with itself (`q!...!`, `q#...#`, etc).
const QUOTE_LIKE_CLOSERS: Partial<Record<number, number>> = {
    40: 41, // ( )
    123: 125, // { }
    91: 93, // [ ]
    60: 62 // < >
};

// If a Perl quote-like operator (`q`, `qq`, `qw`, or `qr` - the ones with a single delimited region,
// unlike `s///`/`tr///` which take two and aren't handled here) starts at `offset`, returns the offset
// just past its matching closing delimiter, honoring Perl's nesting rule for bracket-style delimiters.
// Otherwise returns `offset` unchanged. This keeps a literal quote character *inside* one of these
// constructs - e.g. the apostrophe in `q{User's name}` - from being mistaken by `skipStringOrComment`'s
// own quote handling for the start of an ordinary Perl string, which would otherwise scan for a
// "closing" quote unrelated to it and swallow real `%>` tag boundaries in between.
const skipQuoteLikeOperator = (input: InputStream, offset: number): number => {
    if (offset > 0 && isIdentChar(input.peek(offset - 1))) return offset; // e.g. the "q" in "req"
    if (input.peek(offset) !== LOWER_Q) return offset;

    let o = offset + 1;
    const second = input.peek(o);
    if (second === LOWER_Q || second === LOWER_W || second === LOWER_R) o++; // qq, qw, qr

    while (input.peek(o) === SPACE || input.peek(o) === TAB || input.peek(o) === NEWLINE) o++;

    const startDelim = input.peek(o);
    if (startDelim < 0 || isIdentChar(startDelim) || startDelim === SPACE || startDelim === TAB) return offset;
    o++;

    const endDelim = QUOTE_LIKE_CLOSERS[startDelim] ?? startDelim;
    let depth = 1;
    while (depth > 0) {
        const c = input.peek(o);
        if (c === -1) return offset; // unterminated - bail rather than scanning past end of input
        if (c === BACKSLASH) {
            o += 2;
            continue;
        }
        if (endDelim !== startDelim && c === startDelim) depth++;
        else if (c === endDelim) depth--;
        o++;
    }
    return o;
};

// If a Perl string (single- or double-quoted, following the same shape as codemirror-lang-perl's
// `StringSingleQuoted`/`StringDoubleQuoted` tokens), a quote-like operator (see
// `skipQuoteLikeOperator`), or a `#` comment starts at `offset`, returns the offset just past it.
// Otherwise returns `offset` unchanged. This keeps a literal `%>` inside a string like `<%= "50%>" %>`
// from being mistaken for the tag's real closing delimiter.
const skipStringOrComment = (input: InputStream, offset: number): number => {
    const quoteLike = skipQuoteLikeOperator(input, offset);
    if (quoteLike !== offset) return quoteLike;

    const c = input.peek(offset);
    if (c === HASH) {
        let o = offset + 1;
        while (input.peek(o) !== NEWLINE && input.peek(o) !== -1) o++;
        return o;
    }
    // A quote immediately preceded by a backslash isn't a real string opener - it's an escaped literal
    // quote character in surrounding code, most commonly a regex pattern (`s/\"//g`, matching a literal
    // `"`), not the start of a new Perl string. Without this, `offset` lands on that `"` fresh (the
    // backslash itself was just stepped over as an ordinary character on the previous scan step), gets
    // misread as opening an unterminated string, and the search for a closing quote runs off the end of
    // the template (found against a real one, `exception_default.html.ep`'s `s/\"//g`).
    if ((c === SINGLE_QUOTE || c === DOUBLE_QUOTE) && input.peek(offset - 1) !== BACKSLASH) {
        let o = offset + 1;
        while (input.peek(o) !== c && input.peek(o) !== -1) {
            if (input.peek(o) === BACKSLASH) o++;
            o++;
        }
        // Unterminated (hit end of input without finding the closing quote) - bail rather than
        // returning an offset past the actual end of the source, which would otherwise crash the
        // tokenizer outright (`RangeError: Token end out of bounds`) instead of just mis-tokenizing;
        // mirrors `skipQuoteLikeOperator`'s own same-shaped guard just above.
        if (input.peek(o) === -1) return offset;
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

// True if the input position is a line start, tolerating any amount of preceding [ \t]* on that
// same line (so it still reads as "line start" immediately after the leading-whitespace Text token
// below has been consumed, not only right after a literal '\n').
const isLineStart = (input: InputStream): boolean => {
    let i = -1;
    while (input.peek(i) === SPACE || input.peek(i) === TAB) i--;
    const c = input.peek(i);
    return c === NEWLINE || c === -1;
};

export const tokenizeMojo = new ExternalTokenizer((input: InputStream) => {
    if (input.next === -1) return;

    // A standalone `%` control line: from the `%` itself to the end of the line. Any leading
    // indentation is *not* included here - see the leading-whitespace branch further down, which
    // consumes it as its own Text token first so it lands in the surrounding HTML/Block context's
    // indentation rather than being baked into the marker's own raw text (which would otherwise
    // compound on every reformat, since the marker's stored text would include whatever indent the
    // *previous* run had already added).
    if (input.next === PERCENT && isLineStart(input)) {
        let offset = 1;
        // The position of a genuine (unquoted) trailing `#` comment, if any - `classify` needs the
        // code-only portion, since `content.trim()` still ends with the comment's text otherwise, not
        // `{` (found against a real template: `% if (-T $file) {    # comment` was misclassified as a
        // bare PlainMarker instead of an OpenMarker, and Lezer's error recovery then abandoned the
        // whole enclosing Block). `skipStringOrComment` already treats a `#` inside a string or
        // quote-like operator as opaque, so checking for a bare `HASH` right before calling it (rather
        // than naively searching the extracted string afterward) can't be fooled by one of those.
        let codeEnd = -1;
        while (input.peek(offset) !== NEWLINE && input.peek(offset) !== -1) {
            if (codeEnd === -1 && input.peek(offset) === HASH) codeEnd = offset;
            const skipped = skipStringOrComment(input, offset);
            offset = skipped === offset ? offset + 1 : skipped;
        }
        input.acceptToken(classify(sliceByPeek(input, 1, codeEnd === -1 ? offset : codeEnd)), offset);
        return;
    }

    // An inline `<% ... %>` tag, found in full on one lookahead scan.
    if (input.next === LT && input.peek(1) === PERCENT) {
        let offset = 2;
        let codeEnd = -1; // see the bare `%`-line branch above for why this is needed
        while (!(input.peek(offset - 1) === PERCENT && input.peek(offset) === GT) && input.peek(offset) !== -1) {
            if (codeEnd === -1 && input.peek(offset) === HASH) codeEnd = offset;
            const skipped = skipStringOrComment(input, offset);
            offset = skipped === offset ? offset + 1 : skipped;
        }
        if (input.peek(offset) === GT) {
            // The '%' right before '>' is always the delimiter; a '=' before that is the "trim
            // the following newline" modifier (`=%>`), not part of the Perl content, so strip it too.
            const contentEnd = input.peek(offset - 2) === EQUALS ? offset - 2 : offset - 1;
            const classifyEnd = codeEnd === -1 ? contentEnd : Math.min(codeEnd, contentEnd);
            input.acceptToken(classify(sliceByPeek(input, 2, classifyEnd)), offset + 1);
            return;
        }
        // No closing `%>` was found; fall through and treat the `<` as ordinary text.
    }

    // The [ \t]* indentation leading up to a percent-line, consumed as its own Text token so the
    // marker branch above starts exactly at '%' on the next tokenizer call (see the comment there).
    if ((input.next === SPACE || input.next === TAB) && isLineStart(input)) {
        const ws = percentLineIndent(input, 0);
        if (ws > 0) {
            input.acceptToken(Text, ws);
            return;
        }
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
