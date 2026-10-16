import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
const source = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
function check(raw = source) {
  const selectors = '.app.m-list .channel .ch-unread,\n  .app.m-list .channel .ch-mention';
  const normalized = raw.replace(/\r\n/g, '\n'); assert.equal(normalized.split(selectors).length - 1, 1);
  const start = normalized.indexOf(selectors), end = normalized.indexOf('}', start); const block = normalized.slice(start, end);
  assert.match(block, /^\s*min-width:\s*21px;/m, 'пилюля не уже 21'); assert.match(block, /^\s*height:\s*21px;/m, 'высота пилюли 21');
  assert.match(block, /^\s*font-size:\s*13px;/m, 'цифра 13'); assert.match(block, /^\s*font-weight:\s*500;/m, 'средняя жирность 500');
  // Разбираем сбалансированные media-диапазоны, не объявляем любой ранний max-width доказательством вложенности.
  let inside = false;
  const css = normalized.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
  for (const match of css.matchAll(/@media\s*\([^{}]*max-width\s*:\s*760px[^{}]*\)\s*\{/g)) {
    let depth = 1, i = match.index! + match[0].length;
    for (; depth && i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; }
    if (match.index! < start && i > end) inside = true;
  }
  assert.equal(inside, true, 'пилюли внутри телефонного media');
}
it('R174 телефонные счётчики каналов имеют пилюлю 21 и цифру 13 Medium', () => {
  // CSS source guard проверяет размеры, не имитирует измерение layout в HappyDOM.
  check();
});
it('R174 контрфакты размера и жирности телефонного счётчика обнаруживаются в его CSS-блоке', () => {
  // Меняем число именно нужной декларации; похожий счётчик в другом блоке не является мутантом.
  const normalized = source.replace(/\r\n/g, '\n'); const selector = '.app.m-list .channel .ch-unread,';
  const begin = normalized.indexOf(selector), end = normalized.indexOf('}', begin); const block = normalized.slice(begin, end);
  for (const [anchor, replacement, message] of [['height: 21px;', 'height: 20px;', 'высота пилюли 21'], ['font-size: 13px;', 'font-size: 12px;', 'цифра 13'], ['font-weight: 500;', 'font-weight: 400;', 'средняя жирность 500']]) {
    // Начало декларации важно и для проверки: line-height не может спасти мутант испорченной height.
    const declaration = new RegExp(`^([ \\t]*)${anchor}[ \\t]*$`, 'gm');
    check(); assert.equal([...block.matchAll(declaration)].length, 1, 'ровно одна точная CSS-декларация');
    const mutant = normalized.slice(0, begin) + block.replace(declaration, (_match, indent: string) => indent + replacement) + normalized.slice(end);
    assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.includes(message));
  }
});
