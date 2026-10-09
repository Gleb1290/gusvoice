import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, act, type ComponentType } from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';

type VideoProps = { a?: { url: string; durationMs?: number }; meta?: { once?: boolean; mine?: boolean; listened?: boolean; conversationId: string; messageId: string }; autoplay: boolean; src?: string };
type VideoComponent = ComponentType<VideoProps>;
let registered = false;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' }); registered = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => { if (registered) GlobalRegistrator.unregister(); });

function loadRoundVideo(effects: { spends: string[]; heard: string[]; pauses: number }, change?: (source: string) => string) {
  let source = readFileSync(new URL('./RoundVideo.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'исходниковый мутант действительно меняет код компонента');
    source = changed;
  }
  const module = { exports: {} as Record<string, unknown> };
  const dependencies: Record<string, unknown> = {
    react: { useEffect: ReactHooks.useEffect, useLayoutEffect: ReactHooks.useLayoutEffect, useRef: ReactHooks.useRef, useState: ReactHooks.useState },
    'react/jsx-runtime': { jsx, jsxs, Fragment },
    '@gusvoice/shared': { formatDuration: (ms: number) => `${Math.round(ms / 1000)}с` },
    '../voicePlayback': { voiceHeardKey: () => 'heard', voiceUnheard: (listened: boolean, heard: boolean) => !listened && !heard },
    '../voicePlayer': {
      getVoicePlayerState: () => ({ playing: false }),
      markHeard: (meta: VideoProps['meta']) => { if (meta) effects.heard.push(meta.messageId); },
      pauseVoice: () => { effects.pauses++; },
      spendOnce: (meta: VideoProps['meta']) => { if (meta) effects.spends.push(meta.messageId); },
      subscribeVoicePlayer: () => () => {},
      useVoiceBubble: () => ({ heard: false }),
    },
    './Icon': { Icon: () => null },
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, {
    module, exports: module.exports, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout,
    require: (id: string) => {
      assert.ok(id in dependencies, `неожиданная зависимость ${id}`);
      return dependencies[id];
    },
  });
  return module.exports.RoundVideo as VideoComponent;
}
import * as ReactHooks from 'react';

async function exercise(Component: VideoComponent, effects: { spends: string[]; heard: string[]; pauses: number }, expectSpent: boolean) {
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  const first = { once: false, mine: false, listened: false, conversationId: 'c', messageId: 'round-a' };
  const second = { once: true, mine: false, listened: false, conversationId: 'c', messageId: 'round-once' };
  try {
    await act(async () => { root!.render(createElement('div', null,
      createElement(Component, { meta: first, a: { url: '/a.webm', durationMs: 5000 }, autoplay: false }),
      createElement(Component, { meta: second, a: { url: '/b.webm', durationMs: 5000 }, autoplay: false }))); });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.round-msg-btn')];
    const videos = [...host.querySelectorAll<HTMLVideoElement>('video')];
    assert.equal(buttons.length, 2); assert.equal(videos.length, 2);
    for (const video of videos) {
      video.play = () => Promise.resolve();
      video.pause = () => {};
    }
    await act(async () => { buttons[0]!.click(); });
    assert.ok(buttons[0]!.closest('.round-msg')?.classList.contains('playing'), 'первый кружок начал играть со звуком');
    await act(async () => { buttons[1]!.click(); });
    assert.ok(!buttons[0]!.closest('.round-msg')?.classList.contains('playing'), 'второй кружок глушит предыдущего владельца звука');
    assert.ok(buttons[1]!.closest('.round-msg')?.classList.contains('playing'), 'со звуком остаётся только новый кружок');
    assert.deepEqual(effects.heard, ['round-a', 'round-once'], 'просмотр чужих кружков отмечается как просмотр');
    await act(async () => { root!.unmount(); }); root = null;
    assert.equal(effects.spends.filter((id) => id === 'round-once').length, expectSpent ? 1 : 0,
      'чужой одноразовый кружок сгорает при закрытии активного просмотра');
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove();
  }
}

async function endVideo(Component: VideoComponent, effects: { spends: string[]; heard: string[]; pauses: number }, meta: NonNullable<VideoProps['meta']>, startSound: boolean) {
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  try {
    await act(async () => { root!.render(createElement(Component, { meta, a: { url: '/ended.webm', durationMs: 5000 }, autoplay: false })); });
    const button = host.querySelector<HTMLButtonElement>('.round-msg-btn')!;
    const video = host.querySelector<HTMLVideoElement>('video')!;
    assert.ok(button && video);
    video.play = () => Promise.resolve(); video.pause = () => {};
    if (startSound) await act(async () => { button.click(); });
    await act(async () => { video.dispatchEvent(new Event('ended')); });
    return host.querySelector('.round-msg')?.classList.contains('playing');
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove();
  }
}

it('новый звук глушит первый кружок, а чужой одноразовый сгорает при размонтировании', async () => {
  const effects = { spends: [] as string[], heard: [] as string[], pauses: 0 };
  await exercise(loadRoundVideo(effects), effects, true);

  const mutantEffects = { spends: [] as string[], heard: [] as string[], pauses: 0 };
  const mutant = loadRoundVideo(mutantEffects, (source) => source.replace(
    'if (modeRef.current !== \'loop\' && m?.once && !m.mine) spendOnce(m);',
    'if (false) { /* мутант пропускает сгорание при размонтировании */ }',
  ));
  await assert.rejects(() => exercise(mutant, mutantEffects, true), assert.AssertionError);
});

type RoundCase = (h: { host: HTMLDivElement; button: HTMLButtonElement; video: HTMLVideoElement; pauses: () => number; plays: () => number; render: (autoplay: boolean) => Promise<void> }) => Promise<void>;
async function roundCase(check: RoundCase, change?: (source: string) => string) {
  const Component = loadRoundVideo({ spends: [], heard: [], pauses: 0 }, change);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = async (autoplay: boolean) => { await act(async () => { root.render(createElement(Component, { a: { url: '/seek.webm', durationMs: 20000 }, autoplay })); }); };
  try {
    await render(true);
    const button = host.querySelector<HTMLButtonElement>('button')!;
    const video = host.querySelector<HTMLVideoElement>('video')!;
    let paused = true; let pauses = 0; let plays = 0;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    Object.defineProperty(video, 'duration', { configurable: true, value: 20 });
    video.play = () => { paused = false; plays++; video.dispatchEvent(new Event('play')); return Promise.resolve(); };
    video.pause = () => { paused = true; pauses++; video.dispatchEvent(new Event('pause')); };
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} });
    await check({ host, button, video, pauses: () => pauses, plays: () => plays, render });
  } finally { await act(async () => { root.unmount(); }); host.remove(); }
}
let pointerClock = 1000;
async function point(button: HTMLButtonElement, type: string, x: number, y: number) {
  await act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'timeStamp', { value: pointerClock += 101 });
    button.dispatchEvent(event);
  });
}
const sound = async (button: HTMLButtonElement) => { await act(async () => { button.click(); }); };
const checkPause: RoundCase = async ({ button, pauses }) => {
  await sound(button); const n = pauses();
  await point(button, 'pointerdown', 100, 0); await point(button, 'pointermove', 104, 0);
  assert.equal(pauses(), n + 1, 'тяга ставит видео на паузу');
};
const checkAngles: RoundCase = async ({ button, video }) => {
  await sound(button);
  for (const [x, y, time] of [[100, 0, 0], [200, 100, 5], [100, 200, 10]]) {
    await act(async () => { video.pause(); }); // Пауза: захват полосы перематывает сразу.
    await point(button, 'pointerdown', x!, y!);
    assert.ok(Math.abs(video.currentTime - time!) < 0.001, 'верх/право/низ дают 0/четверть/половину длины');
    await point(button, 'pointerup', x!, y!);
  }
};
const checkSlop: RoundCase = async ({ button, pauses }) => {
  await sound(button); const n = pauses();
  await point(button, 'pointerdown', 100, 0); await point(button, 'pointermove', 103.9, 0);
  assert.equal(pauses(), n, 'сдвиг меньше 4px остаётся кликом');
  await point(button, 'pointermove', 104, 0);
  assert.equal(pauses(), n + 1, 'ровно 4px уже начинает тягу');
};
const checkSwallow: RoundCase = async ({ button, video, pauses, plays }) => {
  await sound(button); await point(button, 'pointerdown', 100, 0); await point(button, 'pointermove', 200, 100);
  const p = plays(); const n = pauses();
  // Click приходит в той же задаче, что pointerup; await act между ними дал бы погаснуть флагу.
  await act(async () => {
    const event = new Event('pointerup', { bubbles: true }); Object.assign(event, { pointerId: 1, clientX: 200, clientY: 100 });
    button.dispatchEvent(event); button.click();
  });
  assert.equal(plays(), p + 1, 'отпускание продолжает видео');
  assert.equal(pauses(), n, 'click после тяги не ставит паузу');
  assert.equal(video.currentTime, 5, 'отпускание фиксирует четверть длины');
};
const checkCenter: RoundCase = async ({ button, host, video }) => {
  await sound(button); await point(button, 'pointerdown', 100, 100); await point(button, 'pointermove', 150, 100);
  assert.equal(!!host.querySelector('.grabbed'), false, 'центр не начинает перемотку');
  await sound(button); assert.equal(video.paused, true, 'центр ставит паузу кликом');
  await sound(button); assert.equal(video.paused, false, 'повторный клик продолжает');
};
const checkKeys: RoundCase = async ({ button, host, video }) => {
  await sound(button);
  const slider = host.querySelector('[role=slider]')!;
  const key = async (value: string) => { await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); }); };
  video.currentTime = 7.7; await key('ArrowRight');
  assert.equal(video.currentTime, 12.7, 'стрелка прибавляет пять секунд');
  assert.equal(slider.getAttribute('aria-valuenow'), '12', 'aria позиция округляется вниз');
  await key('ArrowLeft'); assert.ok(Math.abs(video.currentTime - 7.7) < 0.001, 'левая стрелка вычитает пять секунд');
  video.currentTime = 2; await key('ArrowLeft'); assert.equal(video.currentTime, 0);
  video.currentTime = 18; await key('ArrowRight'); assert.equal(video.currentTime, 19.95);
};
const checkD7: RoundCase = async ({ video, render, pauses }) => {
  await act(async () => { await video.play(); }); const n = pauses();
  await render(false); assert.equal(pauses(), n + 1, 'D7 выключение autoplay останавливает беззвучный круг');
};
const roundMutations: [string, string, string, RoundCase, string][] = [
  ['пауза при тяге', '    v.pause();\n    setGrabbed(true);', '    setGrabbed(true);', checkPause, 'тяга ставит видео на паузу'],
  ['угол от верха по часовой', 'Math.atan2(dx, -dy)', 'Math.atan2(dy, dx)', checkAngles, 'верх/право/низ'],
  ['порог четыре пикселя', 'const SEEK_SLOP = 4;', 'const SEEK_SLOP = 0;', checkSlop, 'сдвиг меньше 4px'],
  ['поглощение клика после тяги', 'swallowClick.current = true;', 'swallowClick.current = false;', checkSwallow, 'click после тяги'],
  ['полоса захвата', 'if (!inSeekBand(box, e.clientX, e.clientY)) return;', '/* нет проверки полосы */', checkCenter, 'центр не начинает'],
  ['шаг стрелки пять секунд', 'const SEEK_KEY_S = 5;', 'const SEEK_KEY_S = 1;', checkKeys, 'стрелка прибавляет'],
  ['выключение autoplay D7', "if (v && !silentLoop && modeRef.current === 'loop' && !v.paused) v.pause();", '/* D7 удалён */', checkD7, 'D7 выключение'],
];
for (const [name, anchor, replacement, check, failure] of roundMutations) {
  it(`кружок: ${name} — оригинал проходит, исходниковый мутант ловится`, async () => {
    await roundCase(check);
    await assert.rejects(() => roundCase(check, (source) => {
      assert.equal(source.split(anchor).length, 2, 'точный якорь мутанта встречается один раз');
      return source.replace(anchor, replacement);
    }), (error: unknown) => error instanceof assert.AssertionError && error.message.includes(failure));
  });
}
it('беззвучный кружок без slider, звук открывает доступную перемотку; касание полосы не всплывает', async () => {
  await roundCase(async ({ host, button, video }) => {
    assert.equal(host.querySelector('[role=slider]'), null); assert.equal(video.muted, true);
    await sound(button); assert.equal(video.muted, false);
    const slider = host.querySelector('[role=slider]')!;
    assert.equal(slider.getAttribute('aria-valuemin'), '0'); assert.equal(slider.getAttribute('aria-valuemax'), '20');
    let touches = 0; document.body.addEventListener('touchstart', countTouch);
    function countTouch() { touches++; }
    const touch = async (x: number, y: number) => { await act(async () => {
      const event = new Event('touchstart', { bubbles: true }); Object.assign(event, { touches: [{ clientX: x, clientY: y }] }); button.dispatchEvent(event);
    }); };
    try { await touch(100, 0); assert.equal(touches, 0); await touch(100, 100); assert.equal(touches, 1); }
    finally { document.body.removeEventListener('touchstart', countTouch); }
  });
});
it('тяга играющего кружка перематывает к верху, правому краю и низу до отпускания', async () => {
  for (const [x, y, seconds] of [[100, 0, 0], [200, 100, 5], [100, 200, 10]]) {
    await roundCase(async ({ button, video, host }) => {
      await sound(button);
      await point(button, 'pointerdown', 0, 100);
      await point(button, 'pointermove', x!, y!);
      assert.equal(video.paused, true, 'во время тяги видео не играет');
      assert.ok(host.querySelector('.grabbed'));
      assert.ok(Math.abs(video.currentTime - seconds!) < 0.001, 'перемотка выполнена до pointerup');
      await point(button, 'pointerup', x!, y!);
      assert.equal(video.paused, false, 'после отпускания звук идёт дальше');
    });
  }
});

it('чужой одноразовый сгорает при конце просмотра, свой и не начатый — нет', async () => {
  const effects = { spends: [] as string[], heard: [] as string[], pauses: 0 };
  const Component = loadRoundVideo(effects);
  const foreignOnce = { once: true, mine: false, listened: false, conversationId: 'c', messageId: 'foreign-ended' };
  const ownOnce = { ...foreignOnce, mine: true, messageId: 'own-ended' };
  const loopOnce = { ...foreignOnce, messageId: 'loop-ended' };
  assert.equal(await endVideo(Component, effects, foreignOnce, true), false, 'ended возвращает активный просмотр в loop');
  await endVideo(Component, effects, ownOnce, true);
  await endVideo(Component, effects, loopOnce, false);
  assert.deepEqual(effects.spends, ['foreign-ended'], 'расходуется только просмотренный чужой одноразовый кружок');

  const mutantEffects = { spends: [] as string[], heard: [] as string[], pauses: 0 };
  const mutant = loadRoundVideo(mutantEffects, (source) => source.replace(
    'if (meta?.once && !meta.mine) spendOnce(meta);',
    'if (meta?.once) spendOnce(meta);',
  ));
  await assert.rejects(async () => {
    await endVideo(mutant, mutantEffects, { ...ownOnce, messageId: 'own-mutant' }, true);
    assert.deepEqual(mutantEffects.spends, [], 'мутант ошибочно списывает свой кружок');
  }, assert.AssertionError);
});
