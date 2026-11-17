import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
interface Rule { selectors: string[]; body: string; start: number; end: number }
function rules(raw: string): Rule[] {
  // Разбираем также вложенные media, игнорируя комментарии/строки: happy-dom не рассчитывает CSS/env/layout.
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));
  const out: Rule[] = [];
  function scope(from: number, to: number) {
    let start = from, quote = '', parens = 0;
    for (let i = from; i < to; i++) {
      const char = clean[i]!;
      if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') parens++;
      if (char === ')') parens--;
      if (char === ';' && parens === 0) { start = i + 1; continue; }
      if (char !== '{' || parens !== 0) continue;
      let level = 1, end = i + 1, innerQuote = '';
      for (; end < to && level; end++) {
        const next = clean[end]!;
        if (innerQuote) { if (next === '\\') end++; else if (next === innerQuote) innerQuote = ''; continue; }
        if (next === '"' || next === "'") innerQuote = next;
        else if (next === '{') level++;
        else if (next === '}') level--;
      }
      assert.equal(level, 0, 'R351/CSS/setup/balanced');
      const header = clean.slice(start, i).trim();
      if (header.startsWith('@')) scope(i + 1, end - 1);
      else out.push({ selectors: header.split(',').map(s => s.trim()), body: clean.slice(i + 1, end - 1), start: i + 1, end: end - 1 });
      i = end - 1; start = end;
    }
  }
  scope(0, clean.length); return out;
}
function declarations(body: string) {
  return new Map(body.split(';').filter(d => d.includes(':')).map(d => {
    const colon = d.indexOf(':'); return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
  }));
}
function rejects(check: (raw: string) => void, changed: string, address: string) {
  check(css);
  assert.throws(() => check(changed), (error: unknown) => error instanceof assert.AssertionError && error.message.split('\n')[0] === address);
  check(css);
}

it('R351 сцена БУМ использует общие safe-area переменные без голого env()', () => {
  // Прямое env() обходило бы fallback Android/WebView, оставляя кнопки под системной панелью.
  const check = (raw: string) => {
    const boom = rules(raw).filter(rule => rule.selectors.some(s => /\.boom-/.test(s)));
    assert.ok(boom.length > 20, 'R351/CSS/setup/boom-rules');
    assert.ok(boom.every(rule => !/\benv\s*\(/.test(rule.body)), 'R351/CSS/boom-safe-area');
  };
  rejects(check, css + '\n@media (max-width:620px) { .boom-skip { bottom: env(safe-area-inset-bottom); } }', 'R351/CSS/boom-safe-area');
});
it('R351 сцена БУМ не оставляет бесконечные CSS-анимации вне управляемого rAF', () => {
  // CSS infinite продолжался бы под игрой, когда часы сцены уже стоят.
  const check = (raw: string) => {
    const boom = rules(raw).filter(rule => rule.selectors.some(s => /\.boom-/.test(s)));
    assert.ok(boom.length > 20);
    assert.ok(boom.every(rule => [...declarations(rule.body)].every(([key, value]) =>
      !/^(?:-webkit-)?animation(?:-iteration-count)?$/.test(key) || !/\binfinite\b/.test(value))), 'R351/CSS/boom-no-infinite');
  };
  rejects(check, css + '\n.boom-hint { animation: pulse 1s infinite; }', 'R351/CSS/boom-no-infinite');
});
it('R351 показанная финальная карточка принимает нажатия, скрытая их пропускает', () => {
  // opacity сама не включает интерактивность: без override «Запустить» визуально есть, но не нажимается.
  const check = (raw: string) => {
    const all = rules(raw);
    for (const [selector, expected] of [['.boom-card', 'none'], ['.boom-card.on', 'auto']]) {
      // Позднее prefers-reduced-motion меняет лишь transition, не переопределяя pointer-events.
      const found = all.filter(rule => rule.selectors.includes(selector!) && declarations(rule.body).has('pointer-events'));
      assert.ok(found.length > 0);
      assert.equal(declarations(found.at(-1)!.body).get('pointer-events'), expected, 'R351/CSS/card-pointer');
    }
  };
  check(css + '\n@media (prefers-reduced-motion: reduce) { .boom-card, .boom-plaque { transition: none; } }');
  rejects(check, css + '\n.boom-card.on { pointer-events: none; }', 'R351/CSS/card-pointer');
});
it('R351 холст монет колеса заканчивается на правом краю, без горизонтального вылета', () => {
  // Отрицательный right расширял fullscreen-сцену вправо и создавал горизонтальное прокручивание.
  const check = (raw: string) => {
    const coins = rules(raw).filter(rule => rule.selectors.includes('.wh-fx-coins'));
    assert.ok(coins.length > 0);
    assert.ok(coins.every(rule => declarations(rule.body).get('right') === '0'), 'R351/CSS/coins-right');
  };
  rejects(check, css + '\n.wh-fx-coins { right: -6%; }', 'R351/CSS/coins-right');
});
it('R351 эффекты колеса и свечение сундука не запускают бесконечную CSS-анимацию', () => {
  // Все декоративные движения обязаны останавливаться вместе с FxLoop.
  const check = (raw: string) => {
    const fx = rules(raw).filter(rule => rule.selectors.some(s => /\.wh-fx-|\.wh-chest-glow\b/.test(s)));
    assert.ok(fx.length >= 2);
    assert.ok(fx.every(rule => [...declarations(rule.body)].every(([key, value]) =>
      !/^(?:-webkit-)?animation(?:-iteration-count)?$/.test(key) || !/\binfinite\b/.test(value))), 'R351/CSS/wheel-no-infinite');
  };
  for (const selector of ['.wh-fx-coins', '.wh-chest-glow']) {
    rejects(check, css + `\n${selector} { animation: turn 3s infinite; }`, 'R351/CSS/wheel-no-infinite');
  }
});

it('R352 оба слоя красного попугая не запускают бесконечных CSS-анимаций', () => {
  // Ожидание и полёт ведут управляемые часы: CSS infinite продолжился бы при паузе окна.
  const check = (raw: string) => {
    const all = rules(raw);
    for (const selector of ['.wh-parrot', '.wh-fx-parrot']) {
      const related = all.filter(rule => rule.selectors.some(s => s.includes(selector)));
      assert.ok(related.length > 0, 'R352/CSS/setup/parrot-layer');
      assert.ok(related.every(rule => [...declarations(rule.body)].every(([key, value]) =>
        !/^(?:-webkit-)?animation(?:-iteration-count)?$/.test(key) || !/\binfinite\b/.test(value))), 'R352/CSS/parrot-no-infinite');
    }
  };
  for (const selector of ['.wh-parrot', '.wh-fx-parrot']) {
    rejects(check, css + `\n@media (max-width: 620px) { ${selector} { animation: breathe 2s infinite; } }`, 'R352/CSS/parrot-no-infinite');
  }
});
