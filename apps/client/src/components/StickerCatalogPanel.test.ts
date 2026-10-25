import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { StickerCatalog, StickerCatalogPack } from '@gusvoice/shared';
import { parseStickerSetName } from '@gusvoice/shared';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';
import { create } from 'zustand';
import * as stickerRules from '../dmStickerRules';

const source = readFileSync(new URL('./StickerCatalogPanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const storeSource = readFileSync(new URL('../dmStickers.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UPDATE = 'R287: смена состава Моих перечитывает каталог в открытой панели';
const ORDER = 'R287: перестановка тех же id не перечитывает каталог';
const LABEL = 'R287: подпись объясняет число загруженных наборов и предел';
let createRoot: typeof import('react-dom/client')['createRoot'];
let previousAct: PropertyDescriptor | undefined;

before(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  createRoot = (await import('react-dom/client')).createRoot;
});
after(async () => {
  await GlobalRegistrator.unregister();
  if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

// Исполняются целые модули панели и стора, не извлечённая копия эффекта. React/Zustand настоящие;
// сеть, рисунки стикеров и таймеры — явные внешние границы. Неизвестный импорт не маскируется.
function load<T>(raw: string, deps: Record<string, unknown>, frameWindow: object): T {
  const module = { exports: {} };
  const code = ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, {
    module, exports: module.exports, window: frameWindow, localStorage,
    require(id: string) {
      assert.ok(Object.hasOwn(deps, id), `R287: разрешён только явный импорт ${id}`);
      return deps[id];
    },
  }, { timeout: 1000 });
  return module.exports as T;
}

function pack(id: string): StickerCatalogPack {
  return { id, name: id, title: `Набор ${id}`, stickers: [], count: 0, mine: true, canDelete: true };
}
function catalog(uploaded: number, uploadLimit = 40): StickerCatalog {
  return { packs: [], uploaded, uploadLimit, importEnabled: true };
}
type Scene = {
  host: HTMLDivElement;
  calls: { catalog: string[]; mine: number };
  setMine(next: StickerCatalogPack[] | null): Promise<void>;
  remoteMine(next: StickerCatalogPack[], reply: StickerCatalog): Promise<void>;
};

async function withPanel(raw: string, mine: StickerCatalogPack[] | null, initial: StickerCatalog,
  check: (scene: Scene) => Promise<void>) {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const frameWindow = {
    setTimeout(callback: () => void, delay: number) {
      // Во всех этих сценариях query пуст: запрос должен быть отложен на 0, без настоящего ожидания.
      assert.equal(delay, 0, 'R287: без поиска нет задержки 250 мс');
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const flush = async () => {
    await React.act(async () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    });
    assert.equal(timers.size, 0, 'R287: таймер запроса выполнен, скрытого ожидания нет');
  };
  const calls = { catalog: [] as string[], mine: 0 };
  let serverMine = mine ?? [];
  let serverCatalog = initial;
  const api = {
    async stickersCatalog(query: string) { calls.catalog.push(query); return serverCatalog; },
    async stickersMine() { calls.mine++; return { packs: serverMine }; },
  };
  const { useDmStickers } = load<typeof import('../dmStickers')>(storeSource, {
    zustand: { create }, './api': { api }, './dmStickerRules': stickerRules,
    './store': { useStore: { getState: () => ({ serverFeatures: [] }) } },
  }, frameWindow);
  useDmStickers.setState({ mine });
  const { StickerCatalogPanel } = load<{ StickerCatalogPanel: React.ComponentType }>(raw, {
    react: React, 'react/jsx-runtime': jsx,
    '@gusvoice/shared': { parseStickerSetName }, '../api': { api },
    '../dmStickerRules': stickerRules, '../dmStickers': { useDmStickers },
    '../toast': { toastError(error: unknown) { throw error; } },
    './Icon': { Icon: () => null }, './StickerView': { StickerView: () => null },
  }, frameWindow);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(StickerCatalogPanel)));
    await flush();
    await check({ host, calls,
      async setMine(next) {
        await React.act(async () => useDmStickers.setState({ mine: next }));
        await flush();
      },
      async remoteMine(next, reply) {
        serverMine = next;
        serverCatalog = reply;
        // То же событие, что получает dmStickers от stickers.update; load(true) и подписка — настоящие.
        await React.act(async () => { useDmStickers.getState().applyRemote({ mine: true }); });
        await flush();
      },
    });
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
    timers.clear();
  }
}

function uploadLabel(host: HTMLDivElement, uploaded: number, limit: number) {
  const title = Array.from(host.querySelectorAll('.sticker-catalog-head')).find(
    (node) => node.textContent?.includes('Загрузить из Telegram'),
  );
  assert.ok(title, 'R287: открытая панель содержит раздел загрузки из Telegram');
  assert.equal(title.textContent?.replace(/\s+/g, ' ').trim(),
    `Загрузить из Telegram · вы загрузили ${uploaded} из ${limit} наборов`, LABEL);
}

async function compositionChanges(raw = source) {
  await withPanel(raw, null, catalog(0), async ({ host, calls, setMine, remoteMine }) => {
    const panel = host.querySelector('.sticker-catalog');
    assert.ok(panel);
    assert.deepEqual(calls.catalog, ['']);
    uploadLabel(host, 0, 40);
    // null и [] оба означают пустой состав: окончание первой загрузки не создаёт второй запрос.
    await setMine([]);
    assert.deepEqual(calls.catalog, ['']);
    const a = pack('pack-a'), b = pack('pack-b'), c = pack('pack-c');
    const steps = [
      { mine: [a], uploaded: 1 },
      // Добавили уже существующий набор из каталога: число своих загрузок не равно длине mine.
      { mine: [a, b], uploaded: 1 },
      // Число наборов прежнее, но id изменился — зависимость только от length здесь неверна.
      { mine: [a, c], uploaded: 2 },
      { mine: [], uploaded: 2 },
    ];
    for (const [index, step] of steps.entries()) {
      await remoteMine(step.mine, catalog(step.uploaded));
      assert.equal(calls.mine, index + 1, 'R287: событие перечитало Мои с сервера');
      assert.equal(calls.catalog.length, index + 2, UPDATE);
      uploadLabel(host, step.uploaded, 40);
      assert.equal(host.querySelector('.sticker-catalog'), panel, 'R287: панель не размонтировалась между событиями');
    }
  });
}

async function orderOnly(raw = source) {
  const a = pack('pack-a'), b = pack('pack-b');
  await withPanel(raw, [b, a], catalog(7), async ({ host, calls, remoteMine, setMine }) => {
    const names = () => Array.from(host.querySelectorAll('.pack-title'), (node) => node.getAttribute('title'));
    assert.deepEqual(names(), ['pack-b', 'pack-a'], 'R287: построение ключа не сортирует сам список Моих');
    assert.deepEqual(calls.catalog, ['']);
    await remoteMine([a, b], catalog(7));
    assert.equal(calls.mine, 1, 'R287: перестановка действительно пришла в стор с сервера');
    assert.deepEqual(calls.catalog, [''], ORDER);
    assert.deepEqual(names(), ['pack-a', 'pack-b'], 'R287: панель получила новый порядок, а не пропустила обновление');
    await setMine([{ ...a, title: 'Новое название' }, { ...b }]);
    assert.deepEqual(calls.catalog, [''], ORDER);
    assert.ok(host.querySelector('.pack-title')?.textContent?.includes('Новое название'));
    uploadLabel(host, 7, 40);
  });
}

async function caption(raw = source) {
  for (const [uploaded, limit] of [[0, 40], [7, 19], [40, 40]]) {
    await withPanel(raw, [pack('pack-a'), pack('pack-b')], catalog(uploaded, limit), async ({ host }) => {
      uploadLabel(host, uploaded, limit);
    });
  }
}

function replaceOnce(from: string, to: string) {
  assert.equal(source.split(from).length - 1, 1, 'R287: мутация имеет ровно один якорь');
  return source.replace(from, to);
}
const exactAssertion = (message: string) => (error: unknown) =>
  error instanceof assert.AssertionError && error.message.split('\n')[0] === message;

it('R287 открытая панель обновляет каталог и счётчик после смены состава Моих без перезахода', () => {
  // Класс ошибки: эффект смотрит только query/длину списка и оставляет старую квоту после загрузки набора.
  return compositionChanges();
});
it('R287 перестановка тех же наборов обновляет Мои, но не запрашивает каталог заново', () => {
  // Класс ошибки: ключ зависит от порядка или ссылки массива и запускает лишнюю загрузку на каждое перемещение.
  return orderOnly();
});
it('R287 подпись называет загруженные наборы и показывает серверные числа от нуля до предела', () => {
  // Класс ошибки: непонятное «ваших N из M» или подмена серверного uploaded длиной Моих вводит человека в заблуждение.
  return caption();
});
it('R287 контрфакт зависимости только от поиска обнаруживается обновлением открытой панели', async () => {
  // Класс ошибки: прежний [query] не реагирует на stickers.update даже при успешном серверном импорте.
  await compositionChanges();
  await assert.rejects(() => compositionChanges(replaceOnce('[query, mineKey]', '[query]')), exactAssertion(UPDATE));
});
it('R287 контрфакт ключа без сортировки обнаруживается лишним запросом при перестановке', async () => {
  // Класс ошибки: одинаковый состав в другом порядке считается новым составом.
  await orderOnly();
  await assert.rejects(() => orderOnly(replaceOnce(".map((p) => p.id).sort().join(',')", ".map((p) => p.id).join(',')")),
    exactAssertion(ORDER));
});
it('R287 контрфакт старой подписи обнаруживается по тексту настоящей панели', async () => {
  // Класс ошибки: откат текста вновь не объясняет, к чему относятся число и предел.
  await caption();
  await assert.rejects(() => caption(replaceOnce('Загрузить из Telegram · вы загрузили {catalog.uploaded}',
    'Загрузить из Telegram · ваших {catalog.uploaded}')), exactAssertion(LABEL));
});
