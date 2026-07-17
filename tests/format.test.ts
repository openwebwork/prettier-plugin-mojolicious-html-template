import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as prettier from 'prettier';
import { test, expect } from 'vitest';

import plugin from '../src/index.js';

// Every fixture lives directly in tests/format/ as `<name>.html.ep`, matched by basename to two
// optional companions: `<name>.expected.html.ep` (the exact output it must format to - if absent,
// the fixture is snapshot-tested instead) and `<name>.options.json` (prettier option overrides, for
// the rare fixture that only makes sense at non-default settings, e.g. a wider printWidth).
const FORMAT_DIR = path.join(import.meta.dirname, 'format');

const fixtures = readdirSync(FORMAT_DIR).filter(
    (file) => file.endsWith('.html.ep') && !file.endsWith('.expected.html.ep')
);

for (const fixture of fixtures) {
    test(fixture, async () => {
        const base = fixture.slice(0, -'.html.ep'.length);
        const filepath = path.join(FORMAT_DIR, fixture);
        const input = readFileSync(filepath, 'utf8');

        const optionsPath = path.join(FORMAT_DIR, `${base}.options.json`);
        const options: Record<string, unknown> = existsSync(optionsPath)
            ? (JSON.parse(readFileSync(optionsPath, 'utf8')) as Record<string, unknown>)
            : {};

        const output = await prettier.format(input, {
            filepath,
            parser: 'mojolicious-html-template',
            plugins: [plugin],
            ...options
        });

        const expectedPath = path.join(FORMAT_DIR, `${base}.expected.html.ep`);
        if (existsSync(expectedPath)) {
            expect(output).toBe(readFileSync(expectedPath, 'utf8'));
        } else {
            expect(`\n${output}`).toMatchSnapshot();
        }
    });
}
