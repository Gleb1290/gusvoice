import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, before, after } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createElement, act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';

type OnlineApi = typeof import('./dmOnline');
let registered = false;
before(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  registered = true;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
after(() => { if (registered) GlobalRegistrator.unregister(); });

function loadOnline(change?: (source: string) => string): OnlineApi {
  let source = readFileSync(new URL('./dmOnline.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'мутант меняет операцию сброса активностей');
    source = changed;
  }
  const module = { exports: {} as Record<string, unknown> };
  const dependencies: Record<string, unknown> = {
    react: { useEffect: () => {}, useMemo: (fn: () => unknown) => fn(), useRef: () => ({ current: undefined }), useSyncExternalStore },
    '@gusvoice/shared': { FEATURE_LASTSEEN2: 'lastseen2', FEATURE_PRESENCE4: 'presence4' },
    './api': { api: {} },
    './store': { useStore: () => undefined },
  };
  const sandbox = {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (id: string) => {
      assert.ok(id in dependencies, `неожиданная зависимость ${id}`);
      return dependencies[id];
    },
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, sandbox);
  return module.exports as OnlineApi;
}

async function activityAfterReset(api: OnlineApi): Promise<boolean> {
  const host = document.createElement('div'); document.body.append(host);
  let root: Root | null = createRoot(host);
  function Harness() {
    const online = api.useLocalOnline('peer');
    return createElement('span', { 'data-online': String(online) }, online ? 'в сети' : 'не в сети');
  }
  try {
    await act(async () => { root!.render(createElement(Harness)); });
    await act(async () => { api.noteDmActivity('peer', Date.now()); });
    assert.equal(host.querySelector('span')?.getAttribute('data-online'), 'true', 'действие собеседника показывает локальную точку');
    await act(async () => { api.resetExactCache(); });
    return host.querySelector('span')?.getAttribute('data-online') === 'true';
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    root = null; host.remove();
  }
}

it('точка соблюдает приватность, действие живёт строго меньше 30 секунд', () => {
  const api = loadOnline();
  assert.equal(api.serverHidesOnline(['lastseen2']), true);
  assert.equal(api.serverHidesOnline([]), false);
  assert.equal(api.dotShown(true, undefined, true), false, 'пока приватность ещё не загружена, скрытый статус не мигает');
  assert.equal(api.dotShown(false, true, true, true), true, 'недавнее действие даёт локальную точку только при видимом времени захода');
  assert.equal(api.dotShown(false, false, true, true), false, 'локальная активность не раскрывает скрытое время');
  assert.equal(api.dotShown(true, false, false), true, 'старый сервер без lastseen2 сохраняет прежнее присутствие');
  assert.equal(api.localOnlineActive(100, 100), true);
  assert.equal(api.localOnlineActive(100, 30_099), true);
  assert.equal(api.localOnlineActive(100, 30_100), false, 'ровно 30 секунд — конец временного статуса');
  assert.equal(api.localOnlineActive(100, 99), false, 'действие из будущего не делает человека онлайн');
  assert.equal(api.localOnlineActive(undefined, 100), false);
});

it('dmAway перекрывает оба источника ЛС-присутствия, без нового поля сохраняется прежнее поведение', () => {
  const check = (api: OnlineApi) => {
    for (const state of [{ onlineUsers: ['peer'], dmOnlineUsers: [] }, { onlineUsers: [], dmOnlineUsers: ['peer'] }, { onlineUsers: ['peer'], dmOnlineUsers: ['peer'] }]) {
      assert.equal(api.dmPresent(state, 'peer'), true, 'старый снимок без away сохраняет присутствие');
      assert.equal(api.dmPresent({ ...state, dmAwayUsers: ['other'] }, 'peer'), true);
      assert.equal(api.dmPresent({ ...state, dmAwayUsers: ['peer'] }, 'peer'), false, 'away перекрывает любое присутствие');
      assert.equal(api.dmPresent(state, 'missing'), false);
    }
    assert.equal(api.dmPresent({ onlineUsers: [], dmOnlineUsers: [], dmAwayUsers: [] }, 'peer'), false);
  };
  check(loadOnline());
  assert.throws(() => check(loadOnline((s) => s.replace(' && !s.dmAwayUsers?.includes(userId)', ''))),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('away перекрывает любое присутствие'));
});

it('presence4 показывает локальную точку при скрытом времени, но dmOnline не заменяет локальную активность', () => {
  // ЛС с presence4 используют отдельный поток присутствия; краткое действие собеседника всё равно добавляет локальную точку.
  const api = loadOnline();
  assert.equal(api.dmDot(false, false, ['lastseen2', 'presence4'], true), true, 'локальное действие видно даже когда точное время скрыто');
  assert.equal(api.dmDot(false, false, ['lastseen2', 'presence4'], false), false, 'без присутствия и действия нельзя выдумать онлайн');
  assert.equal(api.dmDot(true, false, ['lastseen2', 'presence4'], false), true, 'серверное dm-присутствие видно независимо от приватности времени');
  assert.equal(api.dmDot(false, false, ['lastseen2'], true), false, 'до presence4 локальная точка по-прежнему требует видимого времени');

  const mutant = loadOnline(source => source.replace('return online || local;', 'return online;'));
  assert.equal(mutant.dmDot(false, false, ['lastseen2', 'presence4'], false), false, 'неизменённый контроль проходит и у мутанта');
  assert.equal(mutant.dmDot(false, false, ['lastseen2', 'presence4'], true), false, 'мутант теряет единственный локальный сигнал');
});

it('после смены исключений сброс кэша снимает временную точку, а мутант оставляет её', async () => {
  assert.equal(await activityAfterReset(loadOnline()), false, 'настоящий resetExactCache уведомляет подписчика и очищает активность');
  const mutant = loadOnline((source) => source.replace('  actionAt.clear();', '  // мутант: локальное действие переживает reset'));
  assert.equal(await activityAfterReset(mutant), true, 'исполняемый мутант сохраняет устаревший online до исходного таймера');
});
