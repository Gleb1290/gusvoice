import assert from 'node:assert/strict';
import { it } from 'node:test';
import { emojiSuggestEnabled, setEmojiSuggestEnabled } from './emojiSuggest';

it('подсказки эмодзи включены по умолчанию, настройка выключает только подсказки и хранит локальный флаг', () => {
  const original = globalThis.localStorage;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) } });
  try {
    assert.equal(emojiSuggestEnabled(), true);
    setEmojiSuggestEnabled(false); assert.equal(emojiSuggestEnabled(), false);
    setEmojiSuggestEnabled(true); assert.equal(emojiSuggestEnabled(), true);
    values.set('gv_emoji_suggest', 'unexpected'); assert.equal(emojiSuggestEnabled(), true);
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
  }
});
