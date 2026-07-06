import { type Parser, type Plugin, type SupportLanguage, type AstPath, doc } from 'prettier';
import { parsers as pretterHTMLParsers, printers as prettierHTMLPrinters } from 'prettier/plugins/html';

interface Placeholder {
    id: string;
    original: string;
}

interface HtmlAstNode {
    kind: string;
    name?: string;
    value?: string;
}

let placeholders: Placeholder[] = [];

export const languages: SupportLanguage[] = [
    {
        name: 'MojoliciousHTMLTemplate',
        parsers: ['mojolicious-html-template'],
        extensions: ['.html.ep'],
        vscodeLanguageIds: ['html.ep']
    }
];

export const parsers: Record<string, Parser> = {
    'mojolicious-html-template': {
        ...pretterHTMLParsers.html,

        preprocess(text: string): string {
            placeholders = [];
            let modifiedText = text;

            modifiedText = modifiedText.replace(/^([ \t]*)(%.*)$/gm, (match) => {
                const id = `<!--MOJO_LINE_${placeholders.length.toString()}-->`;
                placeholders.push({ id, original: match });
                return id;
            });

            modifiedText = modifiedText.replace(/<%(?:==|=)?[\s\S]*?%>/g, (match) => {
                const id = `<!--MOJO_BLOCK_${placeholders.length.toString()}-->`;
                placeholders.push({ id, original: match });
                return id;
            });

            return modifiedText;
        },

        astFormat: 'mojolicious-html-ast'
    }
};

const plugin: Plugin = {
    languages,
    parsers,
    printers: {
        'mojolicious-html-ast': {
            ...prettierHTMLPrinters.html,

            print(path: AstPath<HtmlAstNode>, options, print) {
                return doc.utils.mapDoc(prettierHTMLPrinters.html.print(path, options, print), (currentDoc) => {
                    if (typeof currentDoc === 'string') {
                        let updatedString = currentDoc;
                        for (const placeholder of placeholders) {
                            updatedString = updatedString.replaceAll(placeholder.id, placeholder.original);
                        }
                        return updatedString;
                    }
                    return currentDoc;
                });
            }
        }
    }
};

export default plugin;
