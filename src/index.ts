import type { Parser, Plugin, SupportLanguage } from 'prettier';
import { parser as mojoParser } from './mojo/mojo.grammar.js';
import { treeToAst, type MojoNode } from './mojo/ast.js';
import { printMojoNode, embed, buildPerltidyContext, validateEmbeddedPerl } from './mojo/printer.js';
import { ensurePerltidyAvailable } from './mojo/perltidy.js';

export const languages: SupportLanguage[] = [
    {
        name: 'MojoliciousHTMLTemplate',
        parsers: ['mojolicious-html-template'],
        extensions: ['.html.ep', '.html.epl'],
        vscodeLanguageIds: ['html.ep', 'html.epl']
    }
];

export const parsers: Record<string, Parser<MojoNode>> = {
    'mojolicious-html-template': {
        // Both the availability check and the per-marker perltidy validation happen here, and not inside embed or
        // runPerltidy. This is because prettier catches errors thrown by an embed function and falls back to
        // unformatted passthrough of the embedded content. However, a parse-time exception propagates as a format
        // rejection.  This makes the error if perltidy is not installed or an error from perltidy parsing behave the
        // same way prettier behaves for a file it can't parse.
        parse: async (text, options) => {
            await ensurePerltidyAvailable();
            const ast = treeToAst(mojoParser.parse(text), text);
            await validateEmbeddedPerl(ast, buildPerltidyContext(options));
            return ast;
        },
        astFormat: 'mojolicious-ast',
        locStart: (node) => node.start,
        locEnd: (node) => node.end
    }
};

const plugin: Plugin<MojoNode> = {
    languages,
    parsers,
    printers: {
        'mojolicious-ast': {
            print: printMojoNode,
            embed
        }
    },
    defaultOptions: {
        // Match perltidy's default indent width so the HTML's own nesting and the templated Perl's
        // control-flow nesting blend together using the same indent unit.
        tabWidth: 4
    }
};

export default plugin;
