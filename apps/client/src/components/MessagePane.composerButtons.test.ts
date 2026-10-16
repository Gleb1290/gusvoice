import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);

for (const [label, mutate] of [
  ['скрепка вместо плюса', (s: string) => s.replace('<Icon name="paperclip" size={22} />', '<Icon name="plus" size={22} />')],
  ['подсказка «Прикрепить»', (s: string) => s.replace('title="Прикрепить"', 'title="Добавить"')],
  ['открытие выбора вложений', (s: string) => s.replace("onClick={(e) => (mediaMode() !== 'input' ? setMediaOpen(true) : setPlusAnchor(e.currentTarget.getBoundingClientRect()))}", 'onClick={() => {}}')],
] as const) {
  h.mutantTest(`R143 мобильная кнопка вложений сохраняет контракт: ${label}`, async () => {
    await h.rejectMutant(mutate, async (component, _confirm, _answer, runtime) => {
      // Проверяем настоящую кнопку, а не строку исходника: click обязан открыть существующий sheet/popup.
      const restore = h.pointerLayout(false, 1024);
      h.mobile();
      const reference = document.createElement('div');
      const { createRoot } = await import('react-dom/client');
      const iconRoot = createRoot(reference);
      try {
        await h.mount({}, component);
        const button = h.host.querySelector<HTMLButtonElement>('.att-btn.plus'); assert.ok(button);
        assert.equal(button.title, 'Прикрепить', 'подсказка объясняет действие вложения');
        const { Icon } = await runtime!.ssrLoadModule('/src/components/Icon.tsx') as typeof import('./Icon');
        await act(async () => { iconRoot.render(createElement(Icon, { name: 'paperclip', size: 22 })); });
        assert.equal(button.querySelector('svg')?.outerHTML, reference.querySelector('svg')?.outerHTML, 'иконка кнопки — скрепка, не плюс');
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        await act(async () => { button.click(); await h.flush(); });
        assert.equal(button.getAttribute('aria-expanded'), 'true', 'клик раскрывает выбор вложений');
        const actions = [...document.querySelectorAll<HTMLButtonElement>('.sheet-row,.ctx-menu button')].map(b => b.textContent);
        assert.ok(actions.some(text => text?.includes('Фото или видео')), 'открыт выбор фото и видео');
        assert.ok(actions.some(text => text === 'Файл' || text?.trim() === 'Файл'), 'открыт выбор файла');
      } finally {
        await act(async () => { iconRoot.unmount(); });
        if (h.root) h.unmount();
        h.desktop(); restore();
      }
    });
  });
}
