import type { Tree, TreeCursor } from '@lezer/common';

export interface MojoNode {
    type: string;
    start: number;
    end: number;
    text: string;
    children: MojoNode[];
}

// Converts a Lezer parse tree into a plain object tree that's simple to walk directly (via
// `.children`) rather than needing a TreeCursor, both for our own printer logic and for prettier's
// AstPath machinery (which needs plain properties, not a TreeCursor, if it's ever asked to navigate
// this AST - see the note on `printMojoNode` in printer.ts for why that's normally unreachable).
export const treeToAst = (tree: Tree, source: string): MojoNode => {
    const convert = (cursor: TreeCursor): MojoNode => {
        const node: MojoNode = {
            type: cursor.type.name,
            start: cursor.from,
            end: cursor.to,
            text: source.slice(cursor.from, cursor.to),
            children: []
        };

        if (cursor.firstChild()) {
            do {
                node.children.push(convert(cursor));
            } while (cursor.nextSibling());
            cursor.parent();
        }

        return node;
    };

    return convert(tree.cursor());
};
