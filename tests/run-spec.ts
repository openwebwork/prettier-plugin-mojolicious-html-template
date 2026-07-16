import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as prettier from 'prettier';
import { test, expect } from 'vitest';

import plugin from '../src/index.js';

// A trimmed down version of the fixture-based snapshot test harness ("run_spec") that most
// Prettier plugins use: each spec file lives alongside one or more input fixtures in the same
// directory, and every fixture is formatted and snapshotted independently.
export function runSpec(dirname: string, parsers: string[]): void {
    const fixtures = readdirSync(dirname).filter(
        (file) => !file.startsWith('jsfmt.spec') && !file.startsWith('__snapshots__')
    );

    for (const parser of parsers) {
        for (const fixture of fixtures) {
            test(`${fixture} (${parser})`, async () => {
                const filepath = path.join(dirname, fixture);
                const input = readFileSync(filepath, 'utf8');

                const output = await prettier.format(input, {
                    filepath,
                    parser,
                    plugins: [plugin]
                });

                expect(`\n${output}`).toMatchSnapshot();
            });
        }
    }
}
