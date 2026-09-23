import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasHiddenChars } from './textGuards.js';

describe('невидимые знаки во внешнем тексте', () => {
  it('обычный многоязычный текст и эмодзи принимаются', () => {
    // Ловит чрезмерный фильтр, который выкидывает честные имена людей и серверов.
    assert.equal(hasHiddenChars('Гуси Café 日本 🪿'), false);
  });

  it('ASCII-управление и разрывы абзаца отвергаются', () => {
    // Ловит многострочную подмену одной записи каталога несколькими визуальными строками.
    assert.equal(hasHiddenChars('one\ntwo'), true);
    assert.equal(hasHiddenChars('one\u2029two'), true);
    assert.equal(hasHiddenChars('one\u007ftwo'), true);
  });

  it('нулевая ширина и метки направления письма отвергаются по всем диапазонам', () => {
    // Ловит визуальную перестановку домена и невидимую маскировку дубликата имени.
    for (const ch of ['\u200b', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069']) {
      assert.equal(hasHiddenChars(`safe${ch}text`), true);
    }
  });
});
