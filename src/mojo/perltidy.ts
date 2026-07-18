import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Shelling out to the `perltidy` binary once per marker/region (the original approach) means paying a
// fresh Perl interpreter startup plus loading the whole (large, pure-Perl) `Perl::Tidy` module on
// *every* call - measured at ~170ms per invocation even for trivial input, which is where a file with
// many reformattable markers spends the bulk of its formatting time (a real template took ~40s). A
// persistent worker process - `perltidy-worker.pl`, spawned once and reused for the lifetime of this
// Node process - calls `Perl::Tidy::perltidy()` directly instead of re-spawning a whole interpreter:
// measured at ~2ms per call after the first (a ~100x reduction), and verified to produce byte-identical
// output to the CLI for the same source/args, with no state leaking between calls with different
// content/options run back-to-back. See the "perltidy worker" section of CLAUDE.local.md for the
// protocol and the process-lifecycle details below.
interface WorkerResponse {
    id: number;
    ok: boolean;
    output: string;
}

let worker: ChildProcessWithoutNullStreams | undefined;
let workerFailed = false;
let warnedWorkerUnavailable = false;
let nextRequestId = 1;
let pendingCount = 0;
const pendingRequests = new Map<number, (result: { code: number | null; stdout: string }) => void>();
let stdoutBuffer = '';

const warnWorkerUnavailable = () => {
    if (warnedWorkerUnavailable) return;
    warnedWorkerUnavailable = true;
    console.error(
        'prettier-plugin-mojolicious-html-template: the perltidy worker (`perl` with `Perl::Tidy` installed) ' +
            'is not available - embedded Perl will be left unformatted. Install perltidy to enable Perl reformatting.'
    );
};

// Any failure past this point (spawn failure, unexpected exit, a malformed response) is permanent for
// the rest of this process - not retried per call, matching the old single-warning-then-always-fall-back
// behavior for a missing `perltidy` binary. Every request still in flight resolves to the same
// "unavailable" result its caller already knows how to handle (`runPerltidy` returns `null`, and the
// caller falls back to raw passthrough for that one marker/region), rather than hanging forever.
const failWorker = () => {
    if (workerFailed) return;
    workerFailed = true;
    warnWorkerUnavailable();
    for (const resolve of pendingRequests.values()) resolve({ code: null, stdout: '' });
    pendingRequests.clear();
};

// The worker is a long-lived child that only ever exits when killed - left at Node's default "ref'd"
// state, an idle worker (nothing currently awaiting a response) would keep this process's event loop
// alive forever, since an open pipe to a still-running child counts as pending work exactly the same way
// an in-flight request does. Verified empirically: a plain `child.unref()` at spawn time isn't enough on
// its own (the piped stdio streams are separate handles that keep the loop alive independently), and
// unref'ing everything unconditionally races the response itself (the process can exit before a
// still-in-flight request's answer arrives). The fix is to toggle ref/unref dynamically around the
// *count* of in-flight requests - ref'd while `pendingCount > 0` (so the process waits for real answers),
// unref'd the instant it drops back to zero (so the process can exit normally between requests, or after
// the last one, without this worker holding it open) - with `process.on('exit', ...)` as a last-resort
// cleanup so the child never outlives this process as an orphan.
// `ChildProcess.stdin`/`stdout`/`stderr` are typed as the generic `stream.Writable`/`Readable`, which
// don't declare `ref`/`unref` even though the actual objects behind piped stdio (`net.Socket` instances)
// have them at runtime - a plain TypeScript typing gap, not a real distinction.
interface Refable {
    ref(): void;
    unref(): void;
}

const setWorkerReferenced = (referenced: boolean) => {
    if (!worker) return;
    const streams: Refable[] = [
        worker,
        worker.stdin as unknown as Refable,
        worker.stdout as unknown as Refable,
        worker.stderr as unknown as Refable
    ];
    for (const stream of streams) {
        if (referenced) stream.ref();
        else stream.unref();
    }
};

const ensureWorker = (): void => {
    if (worker || workerFailed) return;

    const workerPath = fileURLToPath(new URL('perltidy-worker.pl', import.meta.url));
    const child = spawn('perl', [workerPath]);
    worker = child;
    process.on('exit', () => child.kill());

    child.stdin.on('error', () => {
        /* surfaced via 'error'/'close' below */
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') failWorker();
    });
    child.on('close', failWorker);

    child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            newlineIndex = stdoutBuffer.indexOf('\n');
            if (line === '') continue;

            let response: WorkerResponse;
            try {
                response = JSON.parse(line) as WorkerResponse;
            } catch {
                continue;
            }
            const resolve = pendingRequests.get(response.id);
            if (!resolve) continue;
            pendingRequests.delete(response.id);
            resolve({ code: response.ok ? 0 : 1, stdout: response.output });
        }
    });

    setWorkerReferenced(false);
};

const spawnPerltidy = (args: string[], input: string): Promise<{ code: number | null; stdout: string }> => {
    ensureWorker();
    const activeWorker = worker;
    if (workerFailed || !activeWorker) return Promise.resolve({ code: null, stdout: '' });

    const id = nextRequestId++;
    return new Promise((resolve) => {
        pendingRequests.set(id, (result) => {
            pendingCount--;
            if (pendingCount === 0) setWorkerReferenced(false);
            resolve(result);
        });
        pendingCount++;
        setWorkerReferenced(true);
        activeWorker.stdin.write(`${JSON.stringify({ id, args, source: input })}\n`);
    });
};

// Reformats `perlCode` with `perltidy`, using a brace-wrapping trick (see CLAUDE.local.md) so that
// perltidy's own indentation and line-wrapping decisions account for `depth` levels of surrounding
// HTML structure without this plugin doing any column arithmetic itself: `perlCode` is wrapped in
// `depth` nested bare Perl blocks before being sent to `perltidy`, which then indents the content by
// exactly `depth` levels (using its own configured indent character/width) and wraps long lines with
// that real indentation already factored in. Returns the reformatted lines with the synthetic wrapper
// already stripped - every line keeps its own full real indent exactly as `perltidy` produced it (a
// caller that needs the first line's indent stripped, to glue it onto a delimiter instead of leaving it
// on its own line, does that itself - see `stripWrappersAndSubstitute`'s tag-form marker path) - or
// `null` if `perltidy` isn't available or fails, so the caller can fall back to raw passthrough for that
// one marker/region.
export const runPerltidy = async (perlCode: string, opts: RunPerltidyOptions): Promise<string[] | null> => {
    const { configPath, depth, useTabs, tabWidth, printWidth } = opts;

    // Each synthetic opening brace is followed by a lone `#` comment line - a profile with `-wn` set
    // (the real target project's does) otherwise welds a chain of adjacent single-statement-block
    // braces onto one shared line (`{ { {`) and under-indents the wrapped content, silently defeating
    // the whole depth-counting trick (verified: depth-2 wrapping produced only 1 tab of indent with
    // plain `-wn` active). A comment immediately after `{` can't share its line with anything else -
    // comments run to end of line - so the next `{` is forced onto a new line, which prevents welding
    // without touching `-wn` itself: the closing braces, left untouched, stay one-per-line too (welding
    // is symmetric on the open/close chain, verified empirically). This was previously done with
    // `-wnxl='^W{'` (a weld-nested-exclusion-list entry targeting exactly this plugin's own braces), but
    // that's a global CLI override: a target project's own `.perltidyrc` could set its own `-wnxl` for
    // its own reasons, and the CLI flag would silently clobber it rather than merge with it. The comment
    // trick needs no `perltidy` option at all, so it can't conflict with anything a profile sets.
    const openBraces = depth === 0 ? '' : Array.from({ length: depth }, () => '{\n#').join('\n');
    const closeBraces = depth === 0 ? '' : Array.from({ length: depth }, () => '}').join('\n');
    const input = depth === 0 ? perlCode : `${openBraces}\n${perlCode}\n${closeBraces}\n`;

    // `-l=<printWidth>` is passed either way (even alongside a discovered `.perltidyrc`) so wrapping
    // decisions are always tied to prettier's actual resolved printWidth, not merely assumed to match
    // whatever the profile happens to set. `-nst` (explicitly, rather than just omitting `-st`) matches
    // `Perl::Tidy`'s own documented module-usage example: source is passed directly via the `source`
    // param inside the worker, not read from actual stdin, but a discovered profile could still set
    // `-pbp` (which implies `-st`) or `-st` itself for its own reasons - forcing `-nst` unconditionally
    // avoids that colliding with how the worker actually supplies its input.
    const l = printWidth.toString();
    const i = tabWidth.toString();
    const args = configPath
        ? [`-pro=${configPath}`, `-l=${l}`, '-nst', '-se']
        : ['-npro', `-l=${l}`, `-i=${i}`, `-ci=${i}`, '-xci', '-nst', '-se', useTabs ? `-et=${i}` : '-nt'];

    // `perltidy`'s own output isn't always a fixed point of itself in a single pass when a `-wn`
    // welding decision sits right at a width boundary - verified empirically against a real
    // construct in `links.html.ep` (a ternary with `: b(maketext(...))` on the longer arm): the first
    // pass over raw source leaves `b(` and `maketext(` un-welded (each gets its own line), but feeding
    // that exact output back through `perltidy` a second time welds them onto one line, and a third
    // pass then reproduces the second pass's output unchanged (i.e. the *second* pass's result is the
    // real fixed point, not the first). Re-running until two consecutive passes agree (bounded, since
    // this is a narrow boundary case and real content converges within a couple of iterations) means
    // this function always returns output that's stable under repeated formatting, which is what every
    // caller - and the plugin's own idempotency guarantee - actually needs.
    let text = input;
    let stdout = '';
    for (let iteration = 0; iteration < 4; iteration++) {
        const result = await spawnPerltidy(args, text);
        if (result.code !== 0) return null;
        stdout = result.stdout;
        if (stdout.replace(/\n$/, '') === text.replace(/\n$/, '')) break;
        text = stdout;
    }

    const lines = stdout.replace(/\n$/, '').split('\n');
    if (depth === 0) return lines;

    // The opening wrapper contributes two lines per depth level (`{` and its `#` comment); the
    // closing wrapper contributes one (`}`).
    const content = lines.slice(depth * 2, lines.length - depth);
    return content.length === 0 ? null : content;
};
