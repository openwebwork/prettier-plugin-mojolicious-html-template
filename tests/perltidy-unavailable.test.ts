import { test, expect, vi } from 'vitest';

// Simulates `perl` not being installed (or spawn otherwise failing) by mocking `spawn` to fail with
// ENOENT, the same way node:child_process reports a missing binary. Self-contained (no captured
// outer variables) since vi.mock factories run before this file's own imports, per Vitest's hoisting.
vi.mock('node:child_process', () => {
    class FakeEmitter {
        private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        on(event: string, cb: (...args: unknown[]) => void) {
            (this.listeners[event] ??= []).push(cb);
            return this;
        }
        emit(event: string, ...args: unknown[]) {
            for (const cb of this.listeners[event] ?? []) cb(...args);
        }
        // No-op: nothing reads or exercises these, the worker never actually starts.
        write() {
            /* no-op */
        }
        ref() {
            /* no-op */
        }
        unref() {
            /* no-op */
        }
        kill() {
            /* no-op */
        }
    }

    return {
        spawn: () => {
            const child = new FakeEmitter();
            Object.assign(child, { stdin: new FakeEmitter(), stdout: new FakeEmitter(), stderr: new FakeEmitter() });
            queueMicrotask(() => {
                child.emit('error', Object.assign(new Error('spawn perl ENOENT'), { code: 'ENOENT' }));
            });
            return child;
        }
    };
});

import * as prettier from 'prettier';
import plugin from '../src/index.js';
import { PerltidyUnavailableError } from '../src/mojo/perltidy.js';

test('format() rejects with PerltidyUnavailableError when perltidy cannot be used', async () => {
    await expect(
        prettier.format('<div><%= 1 + 1 %></div>\n', {
            filepath: 'unavailable.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).rejects.toThrow(PerltidyUnavailableError);
});

test('a plain HTML file with no Mojo markers also requires perltidy to be available', async () => {
    await expect(
        prettier.format('<div>plain html, no perl</div>\n', {
            filepath: 'unavailable.html.ep',
            parser: 'mojolicious-html-template',
            plugins: [plugin]
        })
    ).rejects.toThrow(PerltidyUnavailableError);
});
