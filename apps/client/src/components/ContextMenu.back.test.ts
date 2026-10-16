import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as React from 'react';
import { escapeMenu, loadMenu, menuSource, replaceMenu, withMenuDom } from './ContextMenu.back.harness';

async function scenario(width: number, kind: 'attribute' | 'class' | 'callback' | 'none', raw = menuSource) {
  await withMenuDom(width, async (_host, root) => {
    const { ContextMenu, MenuItem } = loadMenu(raw); let closes = 0, steps = 0, callback = 0;
    const onClose = () => { closes++; root.render(null); };
    const children = kind === 'attribute' ? React.createElement(MenuItem, { back: true, label: 'Назад', onClick: () => { steps++; } })
      : kind === 'class' ? React.createElement('button', { className: 'ctx-back', onClick: () => { steps++; } }, 'Назад')
      : React.createElement(MenuItem, { label: 'Обычный пункт' });
    await React.act(async () => root.render(React.createElement(ContextMenu, { pos: { x: 10, y: 10 }, onClose,
      onBack: kind === 'none' ? undefined : () => { callback++; }, children })));
    if (kind === 'attribute') assert.equal(document.querySelector('[data-menu-back]') !== null, true, 'MenuItem back добавляет атрибут');
    if (kind === 'none') assert.equal(document.querySelector('[data-menu-back]') === null, true);
    await escapeMenu();
    const up = width <= 620 && kind !== 'none';
    assert.equal(closes, up ? 0 : 1, 'Esc закрывает только без телефонного шага');
    assert.equal(document.querySelector('.ctx-menu') !== null, up, 'телефонный шаг сохраняет меню');
    assert.equal(steps, width <= 620 && ['attribute', 'class'].includes(kind) ? 1 : 0, 'пункт возврата нажимается на телефоне');
    assert.equal(callback, width <= 620 && kind === 'callback' ? 1 : 0, 'пункт возврата главнее onBack');
  });
}
it('R179 телефон 620 нажимает отмеченный пункт прежде onBack, иначе callback, иначе закрывает меню', async () => {
  // Приоритет важен для вложенных сроков: callback родителя сразу пропустил бы внутренний уровень.
  for (const kind of ['attribute', 'class', 'callback', 'none'] as const) await scenario(620, kind);
});
it('R179 ПК 621 закрывает меню целиком даже с пунктом Назад или callback', async () => {
  // Обе стороны границы не дают распространить телефонную навигацию на компьютер.
  for (const kind of ['attribute', 'class', 'callback', 'none'] as const) await scenario(621, kind);
});
async function fresh(raw = menuSource) {
  await withMenuDom(620, async (_host, root) => {
    const { ContextMenu, MenuItem } = loadMenu(raw); const calls: string[] = [];
    const onClose = () => { calls.push('close'); }; const children = React.createElement(MenuItem, { label: 'Пункт' }); const pos = { x: 10, y: 10 };
    const render = async (onBack: () => void) => React.act(async () => root.render(React.createElement(ContextMenu, { pos, onClose, onBack, children })));
    await render(() => calls.push('old')); await render(() => calls.push('new')); await escapeMenu();
    assert.equal(calls.join(','), 'new', 'Esc вызывает свежий onBack после rerender');
  });
}
it('R179 обновлённый onBack вызывается без устаревшего замыкания', async () => {
  // onClose, children и pos стабильны: эффект не может случайно обновиться от другой зависимости.
  await fresh();
});
it('R179 тап по подложке закрывает всё меню вместо подъёма на уровень', async () => {
  // Системная Назад и тап мимо намеренно имеют разный смысл.
  await withMenuDom(620, async (_host, root) => {
    const { ContextMenu, MenuItem } = loadMenu(); let closed = 0, back = 0;
    await React.act(async () => root.render(React.createElement(ContextMenu, { pos: { x: 10, y: 10 }, onClose: () => { closed++; root.render(null); },
      onBack: () => { back++; }, children: React.createElement(MenuItem, { back: true, label: 'Назад', onClick: () => { back++; } }) })));
    assert.equal(document.querySelector('.ctx-sheet-backdrop') !== null, true, 'подложка существует');
    const outside = document.createElement('button'); _host.append(outside);
    await React.act(async () => outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    assert.equal(closed, 1); assert.equal(back, 0); assert.equal(document.querySelector('.ctx-menu') === null, true);
  });
});
it('R179 контрфакты приоритета и телефонной границы отвергаются реальным Esc', async () => {
  // Whole-module mutants: типовая ошибка закрывает не тот уровень при наличии обеих возможностей.
  await scenario(620, 'attribute');
  const priority = replaceMenu("const up = ref.current?.querySelector<HTMLElement>('[data-menu-back], .ctx-back');", "if (onBack) { onBack(); return true; }\n      const up = ref.current?.querySelector<HTMLElement>('[data-menu-back], .ctx-back');");
  await assert.rejects(scenario(620, 'attribute', priority), e => e instanceof assert.AssertionError && e.message.includes('пункт возврата нажимается'));
  await scenario(621, 'callback'); const all = replaceMenu("if (!window.matchMedia('(max-width: 620px)').matches) return false;", 'if (false) return false;');
  await assert.rejects(scenario(621, 'callback', all), e => e instanceof assert.AssertionError && e.message.includes('Esc закрывает'));
});
it('R179 контрфакт отсутствующего onBack в зависимостях эффекта ловит старый обработчик', async () => {
  // При неизменном onClose лишь зависимость onBack должна обновить обработчик клавиши.
  await fresh(); const raw = replaceMenu('[onClose, onBack, isMobile, viewerOpen, stacked, tapClose, anchored]', '[onClose, isMobile, viewerOpen, stacked, tapClose, anchored]');
  await assert.rejects(fresh(raw), e => e instanceof assert.AssertionError && e.message.includes('свежий onBack'));
});
