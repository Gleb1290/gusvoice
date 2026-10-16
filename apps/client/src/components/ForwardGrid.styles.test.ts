import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
function block(raw: string, selector: string) {
  const rules = [...raw.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].trim() === selector);
  assert.equal(rules.length, 1, `один реальный CSS-блок ${selector}`); return rules[0];
}
function pair(selector: string, property: string, expected: string, wrong: string) {
  const check = (raw: string) => {
    const body = block(raw, selector)[2];
    const values = body.split(';').map(d => d.trim()).filter(d => d.startsWith(`${property}:`));
    assert.equal(values.length, 1, 'одна декларация свойства');
    assert.equal(values[0].slice(property.length + 1).trim(), expected);
  };
  check(css);
  const found = block(css, selector); const declaration = new RegExp(`(^|;)\\s*${property}\\s*:[^;]+`, 'g');
  const body = found[2].replace(declaration, `$1 ${property}: ${wrong}`); assert.notEqual(body, found[2]);
  const at = found.index! + found[0].indexOf('{') + 1;
  const mutant = css.slice(0, at) + body + css.slice(at + found[2].length);
  assert.throws(() => check(mutant), assert.AssertionError);
}
it('R171 сетка пересылки сохраняет четыре колонки и ячейку высотой 103', () => {
  // Изменение количества колонок при прежнем размере ячейки ломает плотность ShareAlert.
  pair('.fwd-grid', 'grid-template-columns', 'repeat(4, minmax(0, 1fr))', 'repeat(3, minmax(0, 1fr))');
  pair('.fwd-cell', 'height', '103px', '104px');
});
it('R171 аватар и картинка ячейки имеют 56, подпись 12 ограничена двумя строками', () => {
  // Размер контейнера и картинки проверяется раздельно: несовпадение оставляет кольцо не на аватаре.
  for (const selector of ['.fwd-cell-ava', '.fwd-cell-pic']) for (const property of ['width', 'height']) pair(selector, property, '56px', '52px');
  pair('.fwd-cell-name', 'font-size', '12px', '14px'); pair('.fwd-cell-name', '-webkit-line-clamp', '2', '1');
});
it('R171 выбранный аватар сжат до 0.857 и показывает кольцо 2 акцентного цвета', () => {
  // Галочка без масштаба и кольца не заменяет визуальное состояние выбранности.
  pair('.fwd-cell.picked .fwd-cell-pic', 'transform', 'scale(0.857)', 'scale(1)');
  pair('.fwd-cell-ava::after', 'box-shadow', 'inset 0 0 0 2px var(--accent)', 'inset 0 0 0 1px var(--accent)');
  pair('.fwd-cell.picked .fwd-cell-ava::after', 'opacity', '1', '0');
});
it('R171 круглая отправка имеет 52 с обеих сторон и круговой радиус', () => {
  // Проверка только width пропустила бы овальную или угловатую кнопку.
  for (const property of ['width', 'height', 'min-height']) pair('.fwd-send.round', property, '52px', '48px');
  pair('.fwd-send.round', 'border-radius', 'var(--r-circle)', '10px');
});
it('R171 поле поиска сетки остаётся таблеткой, не прямоугольником настольного списка', () => {
  // Стили ограничены fwd-pick-grid, чтобы не менять другие sheet-search.
  pair('.fwd-pick-grid > .sheet-search', 'border-radius', 'var(--r-pill)', 'var(--r-2)');
});
