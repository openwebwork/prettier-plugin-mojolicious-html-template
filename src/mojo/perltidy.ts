import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walks upward from `fromDir` for a `.perltidyrc`, stopping at the filesystem root.
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

// Talks to a persistent `perltidy-worker.pl` process instead of shelling out to `perltidy` per call.
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

// A failure past this point is permanent. Every in-flight request resolves to "unavailable" instead of hanging.
const failWorker = () => {
    if (workerFailed) return;
    workerFailed = true;
    warnWorkerUnavailable();
    for (const resolve of pendingRequests.values()) resolve({ code: null, stdout: '' });
    pendingRequests.clear();
};

// Ref/unref toggled around in-flight request count so an idle worker doesn't keep the process alive.
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
            --pendingCount;
            if (pendingCount === 0) setWorkerReferenced(false);
            resolve(result);
        });
        ++pendingCount;
        setWorkerReferenced(true);
        activeWorker.stdin.write(`${JSON.stringify({ id, args, source: input })}\n`);
    });
};

// Reformats `perlCode` with perltidy, wrapped in `depth` nested bare Perl blocks first so perltidy's own
// indentation/line-wrapping accounts for the surrounding HTML depth. Returns the reformatted lines with
// the synthetic wrapper stripped, or `null` if perltidy isn't available or fails.
export const runPerltidy = async (perlCode: string, opts: RunPerltidyOptions): Promise<string[] | null> => {
    const { configPath, depth, useTabs, tabWidth, printWidth } = opts;

    // A `#` comment after each synthetic opening brace stops perltidy's `-wn` from welding a chain of
    // adjacent single-statement-block braces onto one line, which would under-indent the wrapped content.
    const openBraces = depth === 0 ? '' : Array.from({ length: depth }, () => '{\n#').join('\n');
    const closeBraces = depth === 0 ? '' : Array.from({ length: depth }, () => '}').join('\n');
    const input = depth === 0 ? perlCode : `${openBraces}\n${perlCode}\n${closeBraces}\n`;

    const l = printWidth.toString();
    const i = tabWidth.toString();
    const args = configPath
        ? [`-pro=${configPath}`, `-l=${l}`, '-nst', '-se']
        : ['-npro', `-l=${l}`, `-i=${i}`, `-ci=${i}`, '-xci', '-nst', '-se', useTabs ? `-et=${i}` : '-nt'];

    // perltidy isn't always a fixed point of itself in one pass at a `-wn` welding boundary, so re-run
    // until two consecutive passes agree.
    let text = input;
    let stdout = '';
    for (let iteration = 0; iteration < 4; ++iteration) {
        const result = await spawnPerltidy(args, text);
        if (result.code !== 0) return null;
        stdout = result.stdout;
        if (stdout.replace(/\n$/, '') === text.replace(/\n$/, '')) break;
        text = stdout;
    }

    const lines = stdout.replace(/\n$/, '').split('\n');
    if (depth === 0) return lines;

    // The opening wrapper contributes two lines per depth level (`{` and its `#` comment). The
    // closing wrapper contributes one (`}`).
    const content = lines.slice(depth * 2, lines.length - depth);
    return content.length === 0 ? null : content;
};
