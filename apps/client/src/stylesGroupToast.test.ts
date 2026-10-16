import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const source = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const selector = 'body:has(.sheet-scrim) .toast-stack';
interface Block { header: string; body: string; children: Block[] }

// CSSOM happy-dom не доказывает каскад/layout. Разбираем реальные блоки и их media-родителя.
function blocks(css: string): Block[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Block[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf('{', cursor);
    if (open < 0) break;
    let end = open + 1, depth = 1, quote = '';
    while (end < clean.length && depth) {
      const char = clean[end++];
      if (quote) {
        if (char === '\\') end++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    assert.equal(depth, 0, 'блоки реального CSS сбалансированы');
    const header = clean.slice(cursor, open).trim().replace(/\s+/g, ' ');
    const body = clean.slice(open + 1, end - 1);
    found.push({ header, body, children: header.startsWith('@') ? blocks(body) : [] });
    cursor = end;
  }
  return found;
}
function zIndex(block: Block) {
  const values = [...block.body.matchAll(/(?:^|;)\s*z-index\s*:\s*([^;]+)\s*(?:;|$)/g)];
  assert.equal(values.length, 1, `ровно одно объявление z-index: ${block.header}`);
  assert.match(values[0][1].trim(), /^\d+$/, 'z-index слоя задан явным числом');
  return Number(values[0][1].trim());
}
function toastAboveSheet(css: string) {
  const tree = blocks(css);
  const scrims = tree.filter(b => b.header === '.sheet-scrim');
  assert.equal(scrims.length, 1, 'глобальная шторка имеет один исходный слой');
  const phone = tree.filter(b => b.header === '@media (max-width: 760px)').flatMap(b => b.children);
  const toasts = phone.filter(b => b.header === selector);
  assert.equal(toasts.length, 1, 'подъём тоста находится прямо в телефонной media-ветке');
  assert.equal(tree.some(b => b.header === selector), false, 'подъём над шторкой не стал глобальным правилом');
  assert.ok(zIndex(toasts[0]) > zIndex(scrims[0]), 'телефонный тост над открытой шторкой');
}

// Иначе pending/отказ/подсказка из окна смешанной группы есть в DOM, но скрыты под листом на телефоне.
it('R206 телефонный тост из открытой шторки имеет слой выше sheet-scrim, правило не глобальное', () => {
  toastAboveSheet(source);
});

// Возврат прежнего 1000 обнаруживается сравнением слоёв, а не браузерной эмуляцией env()/раскладки.
it('R206 CSS-контрфакт: прежний z-index 1000 прячет тост под шторкой', () => {
  toastAboveSheet(source);
  const anchor = /body:has\(\.sheet-scrim\)\s+\.toast-stack\s*\{\s*z-index:\s*1251;\s*\}/g;
  assert.equal([...source.matchAll(anchor)].length, 1, 'единственный якорь слоя тоста при шторке');
  const mutant = source.replace(anchor, `${selector} { z-index: 1000; }`);
  assert.throws(() => toastAboveSheet(mutant),
    (error: unknown) => error instanceof assert.AssertionError && error.message === 'телефонный тост над открытой шторкой');
});
