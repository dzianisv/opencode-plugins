// This file has been superseded by test/telegram.unit.test.ts which uses
// the test-helpers extraction pattern (telegram.test-helpers.ts) to test
// Telegram plugin internals without needing direct exports from telegram.ts.
//
// See: telegram.test-helpers.ts for the exported testable functions
// See: test/telegram.unit.test.ts for the actual unit tests
//
// Kept as a placeholder to avoid breaking any references.

import { describe, it, expect } from '@jest/globals';

describe.skip('Telegram Plugin Internals (moved to telegram.unit.test.ts)', () => {
  it('see test/telegram.unit.test.ts', () => {
    expect(true).toBe(true);
  });
});
