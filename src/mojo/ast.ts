import type { Tree, TreeCursor } from '@lezer/common';

export interface MojoNode {
    type: string;
    start: number;
    end: number;
    text: string;
    children: MojoNode[];
}

// Converts a Lezer parse tree into a plain object tree, walkable via `.children` without a TreeCursor.
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
