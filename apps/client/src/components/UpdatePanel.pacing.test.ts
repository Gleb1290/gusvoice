import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import ts from 'typescript';
import * as splashRules from '../splashFlow';

type UpdateState = ReturnType<typeof import('../updateStore').useUpdate.getState>;
const original = readFileSync(new URL('./UpdatePanel.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Настоящий компонент и настоящая формула; подменены только часы, стор и внешние команды.
// happy-dom не измеряет раскладку: проверяем явно записанную ширину полосы, не её геометрию.
async function scene(work: (f: {
  host: HTMLDivElement;
  change(patch: Partial<UpdateState>): Promise<void>;
  tick(at: number): Promise<void>;
  timers(): number;
  actions: Record<'applyPendingUpdate' | 'relaunchApp' | 'runDesktopUpdateCheck' | 'snoozeUpdate', number>;
}) => Promise<void>, raw = original, allowedActions: Array<'applyPendingUpdate' | 'relaunchApp' | 'runDesktopUpdateCheck' | 'snoozeUpdate'> = []) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const unexpected: string[] = [], intervals = new Map<number, () => void>();
  let now = 10_000, timerId = 0;
  class Clock extends Date { static now() { return now; } }
  const useUpdate = create<UpdateState>((set) => ({
    phase: 'idle', version: '9.9.9', notes: null, downloaded: 0, total: 0,
    startedAt: now, dlDone: false, viaSplash: false, error: null, set: patch => set(patch),
  }));
  const actions = { applyPendingUpdate: 0, relaunchApp: 0, runDesktopUpdateCheck: 0, snoozeUpdate: 0 };
  const action = (name: keyof typeof actions) => {
    actions[name]++;
    if (!allowedActions.includes(name)) unexpected.push(name);
  };
  const commands = {
    PANEL_DOWNLOAD_MIN_MS: splashRules.SPLASH_TIMING.downloadMinMs,
    applyPendingUpdate: () => action('applyPendingUpdate'),
    relaunchApp: () => action('relaunchApp'),
    runDesktopUpdateCheck: () => action('runDesktopUpdateCheck'),
    snoozeUpdate: () => action('snoozeUpdate'),
  };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, '../updateStore': { useUpdate },
    '../updater': commands, '../splashFlow': splashRules,
    './Goose': { Goose: ({ pose, size }: { pose: string; size: number }) =>
      React.createElement('span', { 'data-goose-pose': pose, 'data-goose-size': String(size) }) },
  };
  const module = { exports: {} as typeof import('./UpdatePanel') };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, {
      module, exports: module.exports, Date: Clock,
      setInterval(fn: () => void, delay: number) {
        assert.equal(delay, 50); intervals.set(++timerId, fn); return timerId;
      },
      clearInterval(id: number) { intervals.delete(id); },
      require(id: string) {
        if (!Object.hasOwn(deps, id)) { unexpected.push(`require:${id}`); assert.fail(`Неописанный импорт ${id}`); }
        return deps[id];
      },
    });
    await React.act(async () => { root.render(React.createElement(module.exports.UpdatePanel)); });
    await work({
      host,
      async change(patch) { await React.act(async () => { useUpdate.getState().set(patch); }); },
      async tick(at) {
        now = at;
        await React.act(async () => { for (const fn of [...intervals.values()]) fn(); });
      },
      timers: () => intervals.size,
      actions,
    });
  } finally {
    try { await React.act(async () => { root.unmount(); }); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      assert.equal(intervals.size, 0, 'R240 panel-cleanup: таймер не переживает карточку');
      assert.deepEqual(unexpected, [], 'R240 panel-io: отрисовка не запускает установку или повторную проверку');
    }
  }
}

async function installing(raw = original) {
  await scene(async f => {
    await f.change({ phase: 'installing' });
    assert.equal(f.host.querySelector('.update-title')?.textContent, 'Устанавливаю…',
      'R240 panel-install-title: этап называется установкой, не перезапуском');
    assert.equal(f.host.querySelector('.update-sub')?.textContent, 'приложение перезапустится само',
      'R240 panel-install-sub: не просим человека перезапускать работающий установщик');
    assert.equal(f.host.querySelectorAll('.update-progress-bar.indeterminate').length, 1);
    assert.equal(f.host.querySelector('.update-pct'), null);
    assert.equal(f.host.querySelector('.update-actions'), null);
    assert.equal(f.host.querySelector('.update-close'), null);
    assert.equal(f.timers(), 0);
  }, raw);
}
it('R240 установка показывает «Устанавливаю…» и обещание автоматического перезапуска без кнопки повторной установки', () => installing());

async function fastDownload(raw = original) {
  const minMs = splashRules.SPLASH_TIMING.downloadMinMs;
  await scene(async f => {
    await f.change({ phase: 'downloading', downloaded: 100, total: 100, dlDone: true });
    // Файл уже пришёл; полоса обязана доезжать, а не мигнуть сразу на 100 %.
    // Панель округляет целый процент: за 1 мс до срока уже может быть 100 %, поэтому 99 % проверяем отдельно.
    for (const [elapsed, pct] of [[0, 0], [minMs / 4, 25], [minMs / 2, 50], [minMs * 3 / 4, 75], [minMs * 0.99, 99], [minMs - 1, 100], [minMs, 100]]) {
      await f.tick(10_000 + elapsed);
      assert.equal(f.host.querySelector('.update-pct')?.textContent, `${pct}%`,
        'R240 panel-paced: моментальное скачивание не обгоняет минимальное время');
      assert.equal(f.host.querySelector<HTMLElement>('.update-progress-bar')?.style.width, `${pct}%`);
    }
    assert.equal(f.timers(), 1, 'одна карточка — один таймер, не новый таймер на каждый процент');
    await f.change({ phase: 'installing' });
    assert.equal(f.timers(), 0, 'таймер скачивания гасится при установке');
    assert.equal(f.host.querySelector('.update-pct'), null);
  }, raw);
}
it('R242 мгновенно скачанный файл плавно проходит 0–100 % за минимальное время, затем таймер выключается', () => fastDownload());

async function realProgress(raw = original) {
  const minMs = splashRules.SPLASH_TIMING.downloadMinMs;
  await scene(async f => {
    await f.change({ phase: 'downloading', downloaded: 200, total: 1000 });
    await f.tick(10_000 + minMs / 2);
    assert.equal(f.host.querySelector('.update-pct')?.textContent, '20%',
      'R240 panel-real: время не придумывает ещё не скачанные байты');
    await f.tick(10_000 + minMs + splashRules.SPLASH_TIMING.tickMs);
    assert.equal(f.host.querySelector('.update-pct')?.textContent, '20%');
    await f.change({ downloaded: 0, total: 0 });
    assert.equal(f.host.querySelector('.update-pct')?.textContent, '90%',
      'R240 panel-unknown: неизвестная длина не равна завершённому файлу');
    await f.change({ dlDone: true });
    assert.equal(f.host.querySelector('.update-pct')?.textContent, '100%',
      'завершённое скачивание без content-length тоже доезжает до конца');
    await f.change({ phase: 'ready' });
    assert.equal(f.timers(), 0);
    assert.equal(f.host.querySelector('.update-title')?.textContent, 'Обновление 9.9.9 установлено');
    const readyButton = f.host.querySelector('.update-actions .update-btn-primary');
    assert.equal(readyButton?.textContent?.trim(), 'Перезапустить');
    assert.equal(readyButton?.querySelectorAll('svg').length, 1,
      'R245 panel-ready-icon: запрет значка в предложении не убирает его у установленного обновления');
  }, raw);
}
it('R240 полоса не обгоняет байты, неизвестная длина ограничена 90 %, а Finished снимает потолок', () => realProgress());

it('R240 idle и проверка не показывают карточку, предложение обновиться не запускает таймер скачивания', async () => {
  await scene(async f => {
    for (const phase of ['idle', 'checking'] as const) {
      await f.change({ phase }); assert.equal(f.host.querySelector('[role="status"]'), null); assert.equal(f.timers(), 0);
    }
    await f.change({ phase: 'available' });
    assert.equal(f.host.querySelector('.update-title')?.textContent, 'Доступно обновление 9.9.9');
    assert.match(f.host.querySelector('.update-actions')?.textContent ?? '', /Обновить/);
    assert.equal(f.host.querySelector('.update-pct'), null); assert.equal(f.timers(), 0);
  });
});

function mutate(anchor: string, replacement: string): string {
  assert.equal(original.split(anchor).length - 1, 1, 'якорь мутанта UpdatePanel уникален');
  return original.replace(anchor, replacement);
}
const exactFailure = (prefix: string, actual: unknown, expected: unknown) => (e: unknown) =>
  e instanceof assert.AssertionError && e.message.startsWith(prefix) && e.operator === 'strictEqual' &&
  e.actual === actual && e.expected === expected;

async function click(element: Element | null | undefined) {
  assert.ok(element, 'R244 panel-click-target: элемент для клика существует');
  await React.act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

async function availableCard(raw: string, viaSplash: boolean) {
  await scene(async f => {
    await f.change({ phase: 'available', viaSplash });
    assert.equal(f.host.querySelector('.update-title')?.textContent,
      viaSplash ? 'Доступна версия 9.9.9' : 'Доступно обновление 9.9.9',
      'R245 panel-offer-title: заголовок соответствует режиму и содержит номер версии');
    const subtitle = f.host.querySelector('.update-sub')?.textContent;
    assert.equal(subtitle, viaSplash ? 'приложение перезапустится на пару секунд' : 'обновить можно, когда удобно',
      'R245 panel-splash-sub: подпись объясняет поведение именно этой сборки');
    const primary = f.host.querySelector<HTMLButtonElement>('.update-panel .update-btn-primary');
    assert.ok(primary, 'R245 panel-offer-button-exists: предложение содержит кнопку обновления');
    assert.equal(primary.textContent?.trim(), 'Обновить',
      'R245 panel-splash-button: первичная кнопка предлагает обновление, а не перезапуск');
    assert.doesNotMatch(primary.textContent ?? '', /перезапустить/i,
      'R245 panel-offer-no-restart-word: старое действие не приписано к кнопке предложения');
    assert.equal(primary.querySelectorAll('svg').length, 0,
      'R245 panel-splash-button-icon: у предложения нет значка перезапуска');
    assert.equal(f.host.querySelector('.update-icon [data-goose-pose]')?.getAttribute('data-goose-pose'), 'head',
      'R244 panel-goose-pose: карточка использует голову нового Goose');
    assert.equal(f.host.querySelector('.update-icon [data-goose-size]')?.getAttribute('data-goose-size'), '32',
      'R244 panel-goose-size: карточка использует заданный размер головы');
  }, raw);
}

it('R245 оба режима показывают точные заголовок и подпись, кнопка предложения — «Обновить» без значка перезапуска', async () => {
  await availableCard(original, false);
  await availableCard(original, true);
});

async function availableNotes(raw: string, viaSplash: boolean) {
  await scene(async f => {
    await f.change({ phase: 'available', viaSplash });
    await click(f.host.querySelector('.update-title'));
    const notes = f.host.querySelector('[role="dialog"]');
    assert.ok(notes, 'R244 panel-notes-open: клик по карточке открывает «Что нового»');
    assert.equal(f.host.querySelectorAll('.update-icon [data-goose-pose="head"][data-goose-size="32"]').length, 1,
      'R244 panel-goose-card: новый Goose(head, 32) виден в карточке');
    assert.equal(notes.querySelector('.update-notes-goose [data-goose-pose]')?.getAttribute('data-goose-pose'), 'head',
      'R244 panel-goose-notes-pose: новый Goose виден в окне заметок');
    assert.equal(notes.querySelector('.update-notes-goose [data-goose-size]')?.getAttribute('data-goose-size'), '32',
      'R244 panel-goose-notes-size: окно заметок использует размер 32');
    const primary = notes.querySelector<HTMLButtonElement>('.update-btn-primary');
    assert.ok(primary, 'R245 panel-notes-button-exists: в заметках есть кнопка обновления');
    assert.equal(primary.textContent?.trim(), 'Обновить',
      'R245 panel-notes-button: кнопка заметок предлагает обновление, а не перезапуск');
    assert.doesNotMatch(primary.textContent ?? '', /перезапустить/i,
      'R245 panel-notes-no-restart-word: в кнопке заметок нет старого действия');
    assert.equal(primary.querySelectorAll('svg').length, 0,
      'R245 panel-notes-button-icon: у предложения в заметках нет значка перезапуска');
    assert.equal(f.actions.applyPendingUpdate, 0, 'R244 panel-notes-no-action: открытие заметок само не запускает обновление');
  }, raw);
}

it('R245 окно «Что нового» открывается карточкой, показывает Goose и «Обновить» без значка в обоих режимах', async () => {
  await availableNotes(original, false);
  await availableNotes(original, true);
});

it('R244 кнопка карточки запускает applyPendingUpdate ровно один раз и не всплывает в открытие заметок', async () => {
  for (const viaSplash of [false, true]) {
    await scene(async f => {
      await f.change({ phase: 'available', viaSplash });
      await click(f.host.querySelector('.update-panel .update-btn-primary'));
      assert.equal(f.actions.applyPendingUpdate, 1, 'R244 panel-card-action: обновление запускается ровно один раз');
      assert.equal(f.actions.relaunchApp, 0, 'R244 panel-card-not-relaunch: карточка не перезапускает приложение напрямую');
      assert.equal(f.host.querySelector('[role="dialog"]'), null, 'R244 panel-card-stop-propagation: клик по кнопке не открывает заметки');
    }, original, ['applyPendingUpdate']);
  }
});

it('R244 кнопка в «Что нового» запускает applyPendingUpdate ровно один раз и закрывает заметки', async () => {
  for (const viaSplash of [false, true]) {
    await scene(async f => {
      await f.change({ phase: 'available', viaSplash });
      await click(f.host.querySelector('.update-title'));
      await click(f.host.querySelector('[role="dialog"] .update-btn-primary'));
      assert.equal(f.actions.applyPendingUpdate, 1, 'R244 panel-notes-action: обновление запускается ровно один раз');
      assert.equal(f.actions.relaunchApp, 0, 'R244 panel-notes-not-relaunch: окно заметок не перезапускает приложение напрямую');
      assert.equal(f.host.querySelector('[role="dialog"]'), null, 'R244 panel-notes-close: подтверждение закрывает заметки');
    }, original, ['applyPendingUpdate']);
  }
});

it('R245 реальные карточка и заметки отвергают старые тексты, значок перезапуска и неверного Goose', async () => {
  // Отдельные контрфакты не дают скрыть поломку иконки более ранним падением текста.
  const splashTitle = '? `Доступна версия ${v}`.trim()';
  const legacyTitle = ': `Доступно обновление ${v}`.trim()';
  await availableCard(original, true);
  await assert.rejects(() => availableCard(mutate(splashTitle, '? `Доступно обновление ${v}`.trim()'), true),
    exactFailure('R245 panel-offer-title:', 'Доступно обновление 9.9.9', 'Доступна версия 9.9.9'));
  await availableCard(original, false);
  await assert.rejects(() => availableCard(mutate(legacyTitle, ': `Доступна версия ${v}`.trim()'), false),
    exactFailure('R245 panel-offer-title:', 'Доступна версия 9.9.9', 'Доступно обновление 9.9.9'));

  await availableCard(original, true);
  const subtitle = "? viaSplash\n      ? 'приложение перезапустится на пару секунд'\n      : 'обновить можно, когда удобно'";
  await assert.rejects(() => availableCard(mutate(subtitle,
    "? false\n      ? 'приложение перезапустится на пару секунд'\n      : 'обновить можно, когда удобно'"), true),
    exactFailure('R245 panel-splash-sub:', 'обновить можно, когда удобно', 'приложение перезапустится на пару секунд'));

  await availableCard(original, true);
  await assert.rejects(() => availableCard(mutate("'приложение перезапустится на пару секунд'", "'поставится при перезапуске'"), true),
    exactFailure('R245 panel-splash-sub:', 'поставится при перезапуске', 'приложение перезапустится на пару секунд'));

  const buttons = [
    {
      anchor: '<button className="update-btn-primary" onClick={(e) => { e.stopPropagation(); void applyPendingUpdate(); }}>\n              Обновить',
      probe: availableCard,
      prefix: 'R245 panel-splash-button',
    },
    {
      anchor: '<button className="update-btn-primary" onClick={() => { setShowNotes(false); void applyPendingUpdate(); }}>\n                  Обновить',
      probe: availableNotes,
      prefix: 'R245 panel-notes-button',
    },
  ];
  for (const { anchor, probe, prefix } of buttons) {
    await probe(original, true);
    await assert.rejects(() => probe(mutate(anchor, anchor.replace('Обновить', "{viaSplash ? <><RestartIcon /> Перезапустить и обновить</> : 'Обновить'}")), true),
      exactFailure(`${prefix}:`, 'Перезапустить и обновить', 'Обновить'));
    await probe(original, true);
    await assert.rejects(() => probe(mutate(anchor, anchor.replace('Обновить', '<RestartIcon /> Обновить')), true),
      exactFailure(`${prefix}-icon:`, 1, 0));
  }

  await availableCard(original, true);
  await assert.rejects(() => availableCard(mutate('pose="head"', 'pose="wave"'), true),
    exactFailure('R244 panel-goose-pose:', 'wave', 'head'));

  await availableCard(original, true);
  await assert.rejects(() => availableCard(mutate('<Goose pose="head" size={32} />', '<svg />'), true),
    exactFailure('R244 panel-goose-pose:', undefined, 'head'));
});

it('R240 старые тексты установки отвергаются по реальной карточке, а не наличию строк в исходнике', async () => {
  await installing();
  await assert.rejects(() => installing(mutate("? 'Устанавливаю…'", "? 'Перезапускаю…'")),
    exactFailure('R240 panel-install-title:', 'Перезапускаю…', 'Устанавливаю…'));
  await installing();
  await assert.rejects(() => installing(mutate("? 'приложение перезапустится само'", "? 'нужен перезапуск'")),
    exactFailure('R240 panel-install-sub:', 'нужен перезапуск', 'приложение перезапустится само'));
});

it('R240 обход временного ограничения процентов ловится на уже скачанном файле в момент ноль', async () => {
  await fastDownload();
  const anchor = 'shownDownloadFraction(real, now - startedAt, PANEL_DOWNLOAD_MIN_MS, done)';
  await assert.rejects(() => fastDownload(mutate(anchor, 'shownDownloadFraction(real, now - startedAt, 0, done)')),
    exactFailure('R240 panel-paced:', '100%', '0%'));
});

it('R240 выдуманные байты и преждевременный конец неизвестной длины отвергаются разными пробами', async () => {
  await realProgress();
  const anchor = 'shownDownloadFraction(real, now - startedAt, PANEL_DOWNLOAD_MIN_MS, done)';
  await assert.rejects(() => realProgress(mutate(anchor, 'shownDownloadFraction(1, now - startedAt, PANEL_DOWNLOAD_MIN_MS, done)')),
    exactFailure('R240 panel-real:', '50%', '20%'));
  await realProgress();
  await assert.rejects(() => realProgress(mutate(anchor, 'shownDownloadFraction(real, now - startedAt, PANEL_DOWNLOAD_MIN_MS, done || total === 0)')),
    exactFailure('R240 panel-unknown:', '100%', '90%'));
});
