import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasHiddenChars } from './textGuards.js';

describe('невидимые символы во внешнем тексте', () => {
  it('ловит разворот письма, нулевую ширину и перенос строки, но принимает обычный Unicode', () => {
    assert.equal(hasHiddenChars(`voice\u202E.example`), true);
    assert.equal(hasHiddenChars(`voice\u200B.example`), true);
    assert.equal(hasHiddenChars('voice\nexample'), true);
    assert.equal(hasHiddenChars('Гусь — voice.example'), false);
  });
});
