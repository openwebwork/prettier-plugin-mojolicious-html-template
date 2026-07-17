import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as prettier from 'prettier';
import { test, expect } from 'vitest';

import plugin from '../src/index.js';

// A companion file named "<name>.expected<.ext-chain>" next to a fixture "<name>.<ext-chain>" holds
// the exact output that fixture must format to. When no such companion exists, the fixture is instead
// snapshot-tested (whatever the plugin currently produces is accepted as correct until it changes).
function expectedFilename(fixture: string): string {
    const firstDot = fixture.indexOf('.');
    if (firstDot === -1) return `${fixture}.expected`;
    return `${fixture.slice(0, firstDot)}.expected${fixture.slice(firstDot)}`;
}

// A trimmed down version of the fixture-based snapshot test harness ("run_spec") that most
// Prettier plugins use: each spec file lives alongside one or more input fixtures in the same
// directory, and every fixture is formatted and either compared to its expected-output companion
// or snapshotted independently. `options` lets a fixture directory opt into non-default prettier
// options (e.g. a wider printWidth) when the default 80 wouldn't reflect a realistic target.
export function runSpec(dirname: string, parsers: string[], options: Record<string, unknown> = {}): void {
    const allFiles = readdirSync(dirname);
    const fixtures = allFiles.filter(
        (file) => !file.startsWith('jsfmt.spec') && !file.startsWith('__snapshots__') && !file.includes('.expected.')
    );

    for (const parser of parsers) {
        for (const fixture of fixtures) {
            test(`${fixture} (${parser})`, async () => {
                const filepath = path.join(dirname, fixture);
                const input = readFileSync(filepath, 'utf8');

                const output = await prettier.format(input, {
                    filepath,
                    parser,
                    plugins: [plugin],
                    ...options
                });

                const expectedPath = path.join(dirname, expectedFilename(fixture));
                if (existsSync(expectedPath)) {
                    expect(output).toBe(readFileSync(expectedPath, 'utf8'));
                } else {
                    expect(`\n${output}`).toMatchSnapshot();
                }
            });
        }
    }
}
