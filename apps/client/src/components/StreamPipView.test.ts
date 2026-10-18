import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsx from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import ts from 'typescript';
import * as rules from '../streamPipRules';
import * as quality from '../streamQuality';
import { React, environment, mutate } from './R171.phoneHarness';

const source = readFileSync(new URL('./StreamPipView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Publication = {
  trackSid: string;
  trackInfo?: { layers: { width: number; height: number }[] };
  videoTrack?: { getReceiverStats(): Promise<{ frameWidth: number; frameHeight: number }> };
  setSubscribed?(value: boolean): void;
};
type Screen = { participant: { identity: string; name: string }; publication: Publication };
type Api = {
  StreamPipHost: React.ComponentType;
  StreamPipView: React.ComponentType<{ tracks: Screen[]; win: Window }>;
  PipQualityMenu: React.ComponentType<{ pub: Publication | undefined; at: HTMLElement; onClose(): void }>;
};
const track = (id: string): Screen => ({ participant: { identity: id, name: id }, publication: {
  trackSid: `track-${id}`, trackInfo: { layers: [{ width: 1280, height: 720 }, { width: 640, height: 360 }] },
} });

async function fixture(check: (f: {
  api: Api; state: { pipStreams: string[] }; screens: Screen[]; setScreens(tracks: Screen[]): void;
  render(node: React.ReactNode): Promise<void>; host: HTMLElement; at: HTMLButtonElement; outside: HTMLButtonElement;
  removed: string[]; watched: string[]; chosen: quality.StreamQualityPref[]; order: string[];
  closes(): number; focused(): number; closeMenu(): void; menuCloses(): number;
  pref(value: quality.StreamQualityPref): void; window(value: Window | null): void;
  trackReads: { source: string; onlySubscribed: boolean | undefined }[];
}) => Promise<void>, raw = source) {
  await environment(async (host, render) => {
    const state = { pipStreams: ['screen-a', 'screen-b'], mutedStreams: [] as string[], streamVolumes: {} as Record<string, number>,
      voice: null, watchStream: (id: string) => { watched.push(id); }, toggleStreamMute() {}, setStreamVolume() {} };
    const removed: string[] = [], watched: string[] = [], chosen: quality.StreamQualityPref[] = [], order: string[] = [];
    const trackReads: { source: string; onlySubscribed: boolean | undefined }[] = [];
    let screens = [track('screen-a'), track('screen-b')];
    let closes = 0, focused = 0, menuCloses = 0, pref: quality.StreamQualityPref = 'high';
    let win: Window | null = window;
    const at = document.createElement('button');
    at.append(document.createElement('span'));
    const outside = document.createElement('button');
    document.body.append(at, outside);
    const closeMenu = () => { menuCloses++; order.push('close-menu'); };
    const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state });
    const dependencies: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDom,
      '@livekit/components-react': {
        useTracks: (input: { source: string }[], options?: { onlySubscribed?: boolean }) => {
          trackReads.push({ source: input[0].source, onlySubscribed: options?.onlySubscribed });
          return input[0].source === 'screen-audio' ? [] : screens;
        },
        VideoTrack: ({ trackRef }: { trackRef: Screen }) => React.createElement('div', { 'data-video': trackRef.participant.identity }),
      },
      'livekit-client': { Track: { Source: { ScreenShare: 'screen', ScreenShareAudio: 'screen-audio' } } },
      '../memberName': { useNameResolver: () => (_id: string, fallback: string) => fallback },
      '../store': { useStore, voiceIsHere: () => true },
      '../streamAudioRules': { ownerOf: (id: string) => id.split('#')[0] },
      '../streamPip': {
        closeStreamPip: () => { closes++; order.push('close-window'); },
        focusMainWindow: () => { focused++; },
        openStreamPip: async () => {}, streamPipAvailable: () => true,
        useStreamPipWindow: () => win,
        removeFromStreamPip: (id: string) => { removed.push(id); state.pipStreams = state.pipStreams.filter((x) => x !== id); },
      },
      '../streamPipRules': rules,
      '../streamQuality': { ...quality, useStreamQuality: () => pref,
        setStreamQuality: (value: quality.StreamQualityPref) => { chosen.push(value); order.push(`quality:${value}`); pref = value; } },
      '../toast': { toast: () => assert.fail('неожиданный тост PiP'), toastError: () => assert.fail('неожиданная ошибка PiP') },
      // Внешние элементы меню не решают, где слушать события и какое качество выбрать: это делает настоящий PipQualityMenu.
      './ContextMenu': {
        MenuSection: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
        MenuItem: ({ label, sub, active, onClick }: { label: string; sub: string; active: boolean; onClick(): void }) =>
          React.createElement('button', { type: 'button', role: 'menuitemradio', 'aria-checked': active, onClick }, `${label} ${sub}`),
      },
      './Icon': { Icon: ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name }) },
      './StreamVolumeControl': { StreamVolumeControl: () => null, useStreamVolumePop: () => ({ open: false }) },
      './VoicePanel': { returnToVoice: () => assert.fail('в стенде нет удалённого голоса') },
    };
    const module = { exports: {} as Api };
    try {
      // Исполняем целый компонент. Дополнительные экспорты приватных компонентов существуют только в памяти теста.
      runInNewContext(ts.transpileModule(`${raw}\nexport { StreamPipView, PipQualityMenu };`, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
      } }).outputText, { module, exports: module.exports, window, document, console, require: (id: string) => {
        assert.ok(Object.hasOwn(dependencies, id), `Неописанный импорт PiP: ${id}`); return dependencies[id];
      } });
      await check({ api: module.exports, state, screens, setScreens: (value) => { screens = value; }, render, host, at, outside,
        removed, watched, chosen, order, closes: () => closes, focused: () => focused, closeMenu, menuCloses: () => menuCloses,
        pref: (value) => { pref = value; }, window: (value) => { win = value; }, trackReads });
    } finally {
      at.remove(); outside.remove();
    }
  });
}

const tiles = () => [...document.querySelectorAll<HTMLElement>('[data-pip-id]')].map((el) => el.dataset.pipId);
async function pointer(target: Element) {
  await React.act(async () => { target.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
}
async function key(value: string) {
  await React.act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true })); });
}
async function choose(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((el) => el.textContent?.startsWith(`${label} `));
  assert.ok(button, `доступен пункт ${label}`);
  await React.act(async () => button.click());
}
async function showMenu(f: Parameters<Parameters<typeof fixture>[0]>[0], pub: Publication | undefined = f.screens[0].publication) {
  await f.render(React.createElement(f.api.PipQualityMenu, { pub, at: f.at, onClose: f.closeMenu }));
}

async function hostGoneProbe(raw = source) {
  await fixture(async (f) => {
    f.state.pipStreams = ['screen-a', 'screen-b', 'screen-c'];
    f.setScreens([track('screen-c'), track('screen-a'), track('not-in-pip')]);
    await f.render(React.createElement(f.api.StreamPipHost));
    assert.deepEqual(f.removed, ['screen-b'], 'ушедший второй показ удалён отдельно');
    assert.deepEqual(tiles(), ['screen-a', 'screen-c'], 'порядок живых берётся из PiP, не из ответа комнаты');
    assert.equal(f.closes(), 0, 'живой первый показ не закрывается вместе с ушедшим');
    // Теперь уходит первый: прежний single-stream алгоритм закрыл бы всё окошко.
    f.setScreens([track('screen-c')]);
    await f.render(React.createElement(f.api.StreamPipHost));
    assert.deepEqual(f.removed, ['screen-b', 'screen-a'], 'последовательный уход первого не трогает третьего');
    assert.deepEqual(tiles(), ['screen-c']);
    assert.equal(f.closes(), 0);
  }, raw);
}

it('R256 хост удаляет только ушедший показ, даже если ушёл второй, а затем первый', async () => {
  // Закрытие всего окна по одному id теряет остальные живые показы.
  await hostGoneProbe();
});

it('R256 хост не принимает отписанный кадр за завершённый и закрывает окно при выходе из голоса', async () => {
  await fixture(async (f) => {
    const subscribed: string[] = [];
    for (const t of f.screens) t.publication.setSubscribed = (value) => { if (value) subscribed.push(t.participant.identity); };
    await f.render(React.createElement(f.api.StreamPipHost));
    assert.deepEqual(tiles(), ['screen-a', 'screen-b']);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(subscribed, ['screen-a', 'screen-b']);
    assert.ok(f.trackReads.some((x) => x.source === 'screen' && x.onlySubscribed === false));
    assert.equal(f.closes(), 0);
    await f.render(null);
    assert.equal(f.closes(), 1, 'размонтирование единственного хоста закрывает окошко');
    assert.deepEqual(tiles(), []);
  });
});

it('R256 пустой список закрывает оставшееся окно, но запасной video-путь не рисует портал', async () => {
  await fixture(async (f) => {
    f.state.pipStreams = [];
    await f.render(React.createElement(f.api.StreamPipHost));
    assert.equal(f.closes(), 1);
    assert.deepEqual(tiles(), []);
  });
  await fixture(async (f) => {
    f.window(null);
    await f.render(React.createElement(f.api.StreamPipHost));
    assert.deepEqual(tiles(), []);
    assert.deepEqual(f.removed, []);
    assert.equal(f.closes(), 0);
  });
});

async function escapeProbe(raw = source) {
  await fixture(async (f) => {
    await showMenu(f);
    await key('Enter');
    assert.equal(f.menuCloses(), 0, 'другие клавиши не закрывают меню');
    await key('Escape');
    assert.equal(f.menuCloses(), 1, 'Escape закрывает меню качества');
    assert.deepEqual(f.chosen, []);
  }, raw);
}
it('R256 Escape закрывает меню без изменения качества, другая клавиша оставляет его', async () => {
  await escapeProbe();
});

async function gearProbe(raw = source) {
  await fixture(async (f) => {
    await showMenu(f);
    await pointer(f.at);
    await pointer(f.at.firstElementChild!);
    assert.equal(f.menuCloses(), 0, 'кнопка качества и её иконка не являются щелчком мимо');
    await pointer(f.host.querySelector('[role="menu"]')!);
    await pointer(f.host.querySelector('[role="menuitemradio"]')!);
    assert.equal(f.menuCloses(), 0, 'содержимое меню не является щелчком мимо');
    await pointer(f.outside);
    assert.equal(f.menuCloses(), 1, 'настоящий щелчок мимо закрывает меню');
  }, raw);
}
it('R256 щелчок мимо закрывает меню, но кнопка качества, её иконка и пункты не закрывают', async () => {
  // Capture-слушатель документа срабатывает раньше кнопки; потеря исключения для ⚙ ломает её переключение.
  await gearProbe();
});

async function ownerDocumentProbe(raw = source) {
  await fixture(async (f) => {
    // У detached-документа нет layout/defaultView. Это не измерение окна, а проверка адресата событий портала.
    const pip = document.implementation.createHTMLDocument('PiP');
    const at = pip.createElement('button'), outside = pip.createElement('button');
    pip.body.append(at, outside);
    await f.render(ReactDom.createPortal(React.createElement(f.api.PipQualityMenu, {
      pub: f.screens[0].publication, at, onClose: f.closeMenu,
    }), pip.body));
    await key('Escape');
    await pointer(f.outside);
    assert.equal(f.menuCloses(), 0, 'главный документ не закрывает меню другого окна');
    await React.act(async () => { pip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(f.menuCloses(), 1, 'Escape слушается в документе портала');
    await pointer(at);
    assert.equal(f.menuCloses(), 1);
    await pointer(outside);
    assert.equal(f.menuCloses(), 2, 'щелчок мимо слушается в документе портала');
    await f.render(null);
    await pointer(outside);
    assert.equal(f.menuCloses(), 2, 'сняты слушатели именно документа портала');
  }, raw);
}
it('R256 меню слушает документ PiP, не Escape и щелчки главного окна', async () => { await ownerDocumentProbe(); });

async function selectionProbe(raw = source) {
  await fixture(async (f) => {
    await showMenu(f);
    await choose(f.host, 'Экономное');
    assert.deepEqual(f.chosen, ['low'], 'выбор пункта передан общему регулятору качества');
    assert.deepEqual(f.order, ['quality:low', 'close-menu'], 'сначала применяем выбор, потом закрываем');
  }, raw);
}
it('R256 выбор реального слоя применяет качество перед закрытием меню', async () => { await selectionProbe(); });

it('R256 Авто тоже передаётся регулятору, а отметка отражает общий выбор', async () => {
  await fixture(async (f) => {
    f.pref('low');
    await showMenu(f);
    const selected = f.host.querySelector('[aria-checked="true"]');
    assert.ok(selected?.textContent?.startsWith('Экономное '));
    await choose(f.host, 'Авто');
    assert.deepEqual(f.chosen, ['auto']);
    assert.equal(f.menuCloses(), 1);
  });
});

it('R256 один слой честно оставляет только Авто, а статистика показывает фактический кадр', async () => {
  await fixture(async (f) => {
    f.pref('low');
    const pub: Publication = { trackSid: 'single', videoTrack: {
      getReceiverStats: async () => ({ frameWidth: 1920, frameHeight: 1032 }),
    } };
    await showMenu(f, pub);
    assert.equal(f.host.querySelectorAll('[role="menuitemradio"]').length, 1);
    assert.ok(f.host.textContent?.includes('Показывающий шлёт один слой — понизить нельзя'));
    assert.ok(f.host.textContent?.includes('Сейчас приходит 1920×1032'), 'описание слоёв не подменяет размер принятого кадра');
    assert.ok(f.host.querySelector('[aria-checked="true"]')?.textContent?.startsWith('Авто '));
  });
});

it('R256 отсутствие статистики не ломает выбор, после снятия меню слушатели не остаются', async () => {
  await fixture(async (f) => {
    const pub: Publication = { ...f.screens[0].publication, videoTrack: { getReceiverStats: async () => { throw new Error('no stats'); } } };
    await showMenu(f, pub);
    assert.equal(f.host.querySelectorAll('[role="menuitemradio"]').length, 3);
    assert.ok(!f.host.textContent?.includes('Сейчас приходит'));
    await f.render(null);
    await pointer(f.outside);
    await key('Escape');
    assert.equal(f.menuCloses(), 0, 'размонтированное меню не слушает документ');
    assert.deepEqual(f.chosen, []);
  });
});

it('R256 настоящая кнопка качества открывает и закрывает меню, не меняя фокус плиток', async () => {
  await fixture(async (f) => {
    await f.render(React.createElement(f.api.StreamPipView, { tracks: f.screens, win: window }));
    const tile = f.host.querySelector<HTMLElement>('[data-pip-id="screen-a"]')!;
    const gear = tile.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    assert.equal(tile.style.width, '50%');
    await React.act(async () => gear.click());
    assert.equal(gear.getAttribute('aria-expanded'), 'true');
    assert.equal(tile.style.width, '50%', 'кнопки управления не фокусируют кадр');
    await pointer(gear.firstElementChild!);
    assert.equal(gear.getAttribute('aria-expanded'), 'true', 'capture не должен закрывать меню до click');
    await React.act(async () => gear.click());
    assert.equal(gear.getAttribute('aria-expanded'), 'false');
    assert.equal(f.host.querySelector('[role="menu"]'), null);
    assert.equal(tile.style.width, '50%');
  });
});

it('R256 плитка убирает только себя, а возврат в приложение открывает на сцене все оставшиеся', async () => {
  await fixture(async (f) => {
    await f.render(React.createElement(f.api.StreamPipView, { tracks: f.screens, win: window }));
    const remove = f.host.querySelector<HTMLButtonElement>('[data-pip-id="screen-b"] [title="Убрать из окошка"]')!;
    await React.act(async () => remove.click());
    assert.deepEqual(f.removed, ['screen-b']);
    assert.deepEqual(f.state.pipStreams, ['screen-a']);
    assert.equal(f.closes(), 0);
    await f.render(React.createElement(f.api.StreamPipView, {
      tracks: f.screens.filter((t) => f.state.pipStreams.includes(t.participant.identity)), win: window,
    }));
    assert.deepEqual(tiles(), ['screen-a']);
    assert.equal(f.host.querySelector('[title="Убрать из окошка"]'), null, 'для единственного показа остаётся общее закрытие');
    const back = f.host.querySelector<HTMLButtonElement>('[title="Вернуться в приложение"]')!;
    await React.act(async () => back.click());
    assert.deepEqual(f.watched, ['screen-a']);
    assert.equal(f.closes(), 1);
    assert.equal(f.focused(), 1);
  });
});

async function rejectMutation(raw: string, probe: (raw: string) => Promise<void>, message: string) {
  await probe(source);
  // Ошибка загрузки/импорта не засчитывается: каждый свидетель требует свою адресную ошибку assert.
  await assert.rejects(() => probe(raw), (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(message));
}
it('R256 контрфакт первого id вместо pipGone теряет ушедший второй показ', async () => {
  let raw = mutate(source, 'isInPip, pipGone, pipLayout, type PipCell', 'isInPip, pipGone, pipShouldClose, pipLayout, type PipCell');
  raw = mutate(raw, "for (const id of pipGone(pipKey ? pipKey.split(',') : [], live)) removeFromStreamPip(id);",
    "if (pipShouldClose(pips[0], live, true)) closeStreamPip();");
  await rejectMutation(raw, hostGoneProbe, 'ушедший второй показ удалён отдельно');
});
it('R256 контрфакт без исключения кнопки качества закрывает меню при касании иконки', async () => {
  await rejectMutation(mutate(source, ' && !at.contains(t)', ''), gearProbe, 'кнопка качества и её иконка не являются щелчком мимо');
});
it('R256 контрфакт без применения качества не проходит настоящую строку меню', async () => {
  await rejectMutation(mutate(source, 'setStreamQuality(q);', '/* выбор потерян */'), selectionProbe,
    'выбор пункта передан общему регулятору качества');
});
it('R256 контрфакт потерянного Escape не закрывает открытое меню', async () => {
  await rejectMutation(mutate(source, "if (e.key === 'Escape') onClose();", "if (e.key === 'NeverEscape') onClose();"), escapeProbe,
    'Escape закрывает меню качества');
});
it('R256 контрфакт глобального документа перехватывает события не того окна', async () => {
  await rejectMutation(mutate(source, 'const doc = ref.current?.ownerDocument;', 'const doc = document;'), ownerDocumentProbe,
    'главный документ не закрывает меню другого окна');
});
