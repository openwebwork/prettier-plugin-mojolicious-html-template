import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Walks upward from `fromDir` looking for a `.perltidyrc`, stopping at the filesystem root.
// `perltidy`'s own discovery only checks the immediate directory (falling back to $HOME); its
// `-pro=.../.perltidyrc` upward-search syntax does the same walk but errors out hard if nothing is
// found anywhere up the tree (verified empirically) - searching here instead means "if present"
// degrades cleanly to "not present" rather than failing the whole format.
export const findPerltidyrc = (fromDir: string): string | undefined => {
    let dir = fromDir;
    for (;;) {
        const candidate = join(dir, '.perltidyrc');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
};

export interface RunPerltidyOptions {
    configPath: string | undefined;
    depth: number;
    useTabs: boolean;
    tabWidth: number;
    printWidth: number;
}

let warnedMissingBinary = false;

const spawnPerltidy = (args: string[], input: string): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
        const child = spawn('perltidy', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        // Errors on stdin (e.g. EPIPE if the child exits early) are surfaced via the child's own
        // 'error'/'close' events below, not by letting the stream throw unhandled.
        child.stdin.on('error', () => {
            /* surfaced via 'error'/'close' below */
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT' && !warnedMissingBinary) {
                warnedMissingBinary = true;
                console.error(
                    'prettier-plugin-mojolicious-html-template: `perltidy` was not found on PATH - ' +
                        'embedded Perl will be left unformatted. Install perltidy to enable Perl reformatting.'
                );
            }
            resolve({ code: null, stdout: '' });
        });
        child.on('close', (code) => {
            resolve({ code, stdout });
        });
        child.stdin.write(input);
        child.stdin.end();
    });

// Reformats `perlCode` with `perltidy`, using a brace-wrapping trick (see CLAUDE.local.md) so that
// perltidy's own indentation and line-wrapping decisions account for `depth` levels of surrounding
// HTML structure without this plugin doing any column arithmetic itself: `perlCode` is wrapped in
// `depth` nested bare Perl blocks before being sent to `perltidy`, which then indents the content by
// exactly `depth` levels (using its own configured indent character/width) and wraps long lines with
// that real indentation already factored in. Returns the reformatted lines with the synthetic wrapper
// already stripped and the first line's own indent already stripped too (the caller glues it onto the
// marker's opening delimiter instead) - or `null` if `perltidy` isn't available or fails, so the
// caller can fall back to raw passthrough for that one marker.
export const runPerltidy = async (perlCode: string, opts: RunPerltidyOptions): Promise<string[] | null> => {
    const { configPath, depth, useTabs, tabWidth, printWidth } = opts;

    const braces = (char: string) => Array.from({ length: depth }, () => char).join('\n');
    const input = depth === 0 ? perlCode : `${braces('{')}\n${perlCode}\n${braces('}')}\n`;

    // `-l=<printWidth>` is passed either way (even alongside a discovered `.perltidyrc`) so wrapping
    // decisions are always tied to prettier's actual resolved printWidth, not merely assumed to match
    // whatever the profile happens to set. `-nwn` (disable "weld nested containers") is required
    // regardless of a discovered config: a `.perltidyrc` with `-wn` set (the real target project's
    // does) collapses the synthetic braces onto shared lines and under-indents the wrapped content,
    // defeating the depth-counting trick this relies on (verified empirically).
    const l = printWidth.toString();
    const i = tabWidth.toString();
    const args = configPath
        ? [`-pro=${configPath}`, `-l=${l}`, '-nwn', '-st', '-se']
        : ['-npro', `-l=${l}`, `-i=${i}`, `-ci=${i}`, '-xci', '-nwn', '-st', '-se', useTabs ? `-et=${i}` : '-nt'];

    const { code, stdout } = await spawnPerltidy(args, input);
    if (code !== 0) return null;

    const lines = stdout.replace(/\n$/, '').split('\n');
    if (depth === 0) return lines;

    const content = lines.slice(depth, lines.length - depth);
    if (content.length === 0) return null;

    const indentUnit = useTabs ? '\t' : ' '.repeat(tabWidth);
    const firstLineIndent = indentUnit.repeat(depth);
    content[0] = content[0].startsWith(firstLineIndent)
        ? content[0].slice(firstLineIndent.length)
        : content[0].trimStart();

    return content;
};
