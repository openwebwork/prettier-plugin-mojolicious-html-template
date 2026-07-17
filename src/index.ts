import type { Parser, Plugin, SupportLanguage } from 'prettier';
import { parser as mojoParser } from './mojo/mojo.grammar.js';
import { treeToAst, type MojoNode } from './mojo/ast.js';
import { printMojoNode, embed } from './mojo/printer.js';

export const languages: SupportLanguage[] = [
    {
        name: 'MojoliciousHTMLTemplate',
        parsers: ['mojolicious-html-template'],
        extensions: ['.html.ep', '.mt'],
        vscodeLanguageIds: ['html.ep']
    }
];

export const parsers: Record<string, Parser<MojoNode>> = {
    'mojolicious-html-template': {
        parse: (text) => treeToAst(mojoParser.parse(text), text),
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
