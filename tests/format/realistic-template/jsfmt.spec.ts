import { runSpec } from '../../run-spec.js';

// Matches the target project's actual .prettierrc, since the expected output here was verified
// against those settings specifically (some lines are wider than the default printWidth of 80).
runSpec(import.meta.dirname, ['mojolicious-html-template'], {
    printWidth: 120,
    singleQuote: true,
    trailingComma: 'none'
});
