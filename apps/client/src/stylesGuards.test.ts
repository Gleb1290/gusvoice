import assert from 'node:assert/strict';
import { it } from 'node:test';
import { rules, value, values, phone, reduce, splitList } from '../test-support/cssGuards.js';

// Здесь только общие договоры CSS. Геометрию и каскад проверяют в браузере:
// эти проверки деклараций не доказывают видимость, права или корректность расчёта денег.
it('безопасные отступы всех сторон объединяют browser и native значения', () => {
  for (const [side, short, native] of [['top', 't', 'sat'], ['right', 'r', 'sar'], ['bottom', 'b', 'sab'], ['left', 'l', 'sal']]) {
    const token = value(':root', `--sa-${short}`).replace(/\s/g, '');
    assert.ok(token.startsWith('max('));
    assert.ok(token.includes(`env(safe-area-inset-${side})`));
    assert.ok(token.includes(`var(--gv-${native},0px)`));
  }
});

// max() допускает произвольное число аргументов. Проверяем общую связь browser/native,
// не положение аргументов и не padding конкретного компонента.
function maxGroups(input: string): { start: number; end: number; args: string[] }[] {
  const groups = [];
  for (const found of input.matchAll(/max\(/g)) {
    const start = found.index!;
    let end = start + 4, depth = 1;
    for (; end < input.length && depth; end++) {
      if (input[end] === '(') depth++;
      else if (input[end] === ')') depth--;
    }
    if (!depth) groups.push({ start, end, args: splitList(input.slice(start + 4, end - 1)).map(s => s.replace(/\s/g, '')) });
  }
  return groups;
}
function hasNativeFallback(input: string, side: string, native: string, at: number): boolean {
  return maxGroups(input).some(group => group.start <= at && at < group.end
    && group.args.includes(`env(safe-area-inset-${side})`)
    && group.args.includes(`var(--gv-${native},0px)`));
}
it('прямое использование системных вставок сохраняет native fallback', () => {
  // Парные проверки самого общего стража: дополнительный минимум не теряет fallback,
  // а var за пределами max, неверная сторона и min не дают ложного успеха.
  for (const input of ['max(env(safe-area-inset-bottom), var(--gv-sab, 0px))',
    'max(8px, env(safe-area-inset-bottom), var(--gv-sab, 0px))',
    'calc(12px + max(var(--gv-sab, 0px), env(safe-area-inset-bottom), 8px))']) {
    assert.ok(hasNativeFallback(input, 'bottom', 'sab', input.indexOf('env(')));
  }
  for (const input of ['min(env(safe-area-inset-bottom), var(--gv-sab, 0px))',
    'calc(env(safe-area-inset-bottom) + var(--gv-sab, 0px))',
    'max(env(safe-area-inset-bottom), var(--gv-sat, 0px))']) {
    assert.equal(hasNativeFallback(input, 'bottom', 'sab', input.indexOf('env(')), false);
  }
  const native: Record<string, string> = { top: 'sat', right: 'sar', bottom: 'sab', left: 'sal' };
  for (const rule of rules) for (const match of rule.value.matchAll(/env\(safe-area-inset-(top|right|bottom|left)\)/g)) {
    assert.ok(hasNativeFallback(rule.value, match[1], native[match[1]], match.index!), `${rule.selectors}: ${rule.property}`);
  }
});

it('общая модель размеров включает рамку и padding в размер элемента', () => {
  assert.equal(value('*', 'box-sizing'), 'border-box');
});

it('главная строка приложения может сжиматься внутри высоты окна', () => {
  assert.match(value('.app', 'grid-template-rows'), /minmax\(0,\s*1fr\)/);
});

it('телефон подавляет выделение интерфейса, сохраняя выделение в полях ввода', () => {
  assert.equal(value('body', 'user-select', phone), 'none');
  assert.equal(value('body', '-webkit-touch-callout', phone), 'none');

  for (const selector of ['input', 'textarea', "[contenteditable]:not([contenteditable='false'])"])
    assert.equal(value(selector, 'user-select', phone), 'text');
});

it('общий hover кнопок не повышает специфичность псевдоклассом', () => {
  assert.ok(rules.some(rule => rule.selectors.includes('button:where(:hover)')));
  assert.ok(rules.every(rule => !rule.selectors.includes('button:hover')));
});

it('все бесконечные анимации останавливаются в игровом и лёгком режимах', () => {
  const animated = rules.filter(rule => rule.property === 'animation' && /\binfinite\b/.test(rule.value));
  assert.ok(animated.length > 0);
  // Перечень выводится из CSS: новый компонент не требует править закрытый список теста.
  for (const rule of animated) for (const selector of rule.selectors) for (const mode of ['gv-game-fg', 'gv-lite']) {
    const state = values(`html.${mode} ${selector}`).get('animation-play-state')?.split(',').map(s => s.trim());
    assert.ok(state?.length, `${mode}: ${selector}`);
    // Списки CSS циклически повторяются, одиночный paused останавливает все анимации.
    splitList(rule.value).forEach((animation, index) => {
      if (/\binfinite\b/.test(animation)) assert.equal(state[index % state.length], 'paused', `${mode}: ${selector}`);
    });
  }
});

it('общие окна и выпадающие меню уважают reduced-motion', () => {
  for (const selector of ['.modal', '.ctx-stack.drop > .ctx-menu', '.ctx-stack.drop > .ctx-menu > *'])
    assert.equal(value(selector, 'animation', reduce), 'none');
});

it('общая модальная подложка перекрывает окно до краёв', () => {
  assert.equal(value('.modal-overlay', 'position'), 'fixed');
  assert.equal(value('.modal-overlay', 'inset'), '0');
});

it('листы ограничены видимой высотой и могут прокручиваться', () => {
  assert.match(value('.sheet', 'max-height'), /var\(--vh-px,/);
  assert.ok(['auto', 'scroll'].includes(value('.sheet', 'overflow-y')));
});

it('скрытые действия уведомлений пропускают указатель, фокус делает их доступными', () => {
  assert.equal(value('.nfp-actions', 'pointer-events'), 'none');
  assert.equal(value('.nfp-actions', 'opacity'), '0');
  for (const selector of ['.nfp-card:hover .nfp-actions', '.nfp-actions:focus-within']) {
    assert.equal(value(selector, 'pointer-events'), 'auto');
    assert.equal(value(selector, 'opacity'), '1');
  }
});

it('якорное меню учитывает обе вертикальные безопасные вставки', () => {
  const ceiling = value('.ctx-menu:not(.sheet)', 'max-height');
  assert.match(ceiling, /var\(--vh-px,/);
  assert.match(ceiling, /--gv-sat/);
  assert.match(ceiling, /--gv-sab/);
});
