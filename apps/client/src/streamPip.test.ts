import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as rules from './streamPipRules';
import type { PipTrackRef } from './streamPip';

const source = readFileSync(new URL('./streamPip.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type PipWindow = EventTarget & { document: Document; innerWidth: number; innerHeight: number; closes: number; closed: boolean; close(): void };
type PipState = {
  pipStreams: readonly string[];
  addPipStream(id: string, max?: number): void;
  removePipStream(id: string): void;
  clearPipStreams(): void;
};
type Options = { documentApi?: boolean; documentError?: Error; videoError?: Error; storageError?: boolean; android?: boolean; videoSupported?: boolean;
  tauri?: 'core' | 'no-core'; invokeError?: Error; invokeWait?: Promise<void> };
const track = { id: 'remote-screen', kind: 'video' } as MediaStreamTrack;
const ref = (id = 'peer-a#screen'): PipTrackRef => ({ participant: { identity: id }, publication: { track: { mediaStreamTrack: track } } });

async function fixture(check: (f: {
  api: typeof import('./streamPip'); state: PipState; changes: string[][];
  sizes: { width?: number; height?: number }[]; windows: PipWindow[]; saved: Map<string, string>; saves: string[];
  fallback: { tracks: MediaStreamTrack[]; leave: () => void }[]; readWindow(): Window | null; snapshots: (Window | null)[];
  invokes: { command: string; args: Record<string, unknown> }[]; order: string[];
  hide(w: PipWindow): void; tick(): Promise<void>; fallbackCloses(): number;
}) => Promise<void>, options: Options = {}, raw = source) {
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
  const previousDocumentApi = Object.getOwnPropertyDescriptor(globalThis, 'documentPictureInPicture');
  GlobalRegistrator.register({ url: 'https://chat.example.test/room', settings: {
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
  } });
  const changes: string[][] = [], saves: string[] = [];
  const saved = new Map<string, string>(), sizes: { width?: number; height?: number }[] = [];
  const windows: PipWindow[] = [], snapshots: (Window | null)[] = [], unsubs: (() => void)[] = [];
  const fallback: { tracks: MediaStreamTrack[]; leave: () => void }[] = [];
  const invokes: { command: string; args: Record<string, unknown> }[] = [], order: string[] = [];
  let activeLeave: (() => void) | null = null;
  let fallbackCloses = 0;
  let snapshot = (): Window | null => null;
  const state: PipState = {
    pipStreams: [],
    addPipStream(id, max) {
      const next = rules.pipAdd(this.pipStreams, id, max);
      if (next === this.pipStreams) return;
      this.pipStreams = next; changes.push([...next]);
    },
    removePipStream(id) {
      const next = rules.pipRemove(this.pipStreams, id);
      if (next === this.pipStreams) return;
      this.pipStreams = next; changes.push([...next]);
    },
    clearPipStreams() {
      if (!this.pipStreams.length) return;
      this.pipStreams = []; changes.push([]);
    },
  };
  const documentApi = { window: null, requestWindow: async (size: { width?: number; height?: number }) => {
    order.push('requestWindow');
    sizes.push({ ...size });
    if (options.documentError) throw options.documentError;
    const w = Object.assign(new EventTarget(), {
      document: document.implementation.createHTMLDocument('PiP'), innerWidth: 640, innerHeight: 360, closes: 0, closed: false,
      close: () => {},
    }) as PipWindow;
    w.close = () => { w.closes++; w.closed = true; w.dispatchEvent(new Event('pagehide')); };
    w.document.documentElement.setAttribute('data-stale', 'remove');
    windows.push(w);
    return w;
  } };
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: options.documentApi === false ? undefined : documentApi });
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: options.tauri === 'core' ? {
    core: { invoke: async (command: string, args: Record<string, unknown>) => {
      invokes.push({ command, args: { ...args } }); order.push('invoke');
      await options.invokeWait;
      if (options.invokeError) throw options.invokeError;
    } },
  } : options.tauri === 'no-core' ? { window: {} } : undefined });
  Object.defineProperty(window.screen, 'availWidth', { configurable: true, value: 1920 });
  Object.defineProperty(window.screen, 'availHeight', { configurable: true, value: 1080 });
  class TestMediaStream {
    constructor(readonly tracks: MediaStreamTrack[]) {}
    getTracks() { return [...this.tracks]; }
  }
  const deps: Record<string, unknown> = {
    react: { useSyncExternalStore: (subscribe: (f: () => void) => () => void, get: () => Window | null, server: () => Window | null) => {
      assert.equal(server(), null); snapshot = get; unsubs.push(subscribe(() => snapshots.push(get()))); return get();
    } },
    './hotkeys': { isAndroid: () => options.android === true },
    './store': { useStore: { getState: () => state } },
    './streamPipRules': rules,
    './videoPip': {
      pipSupported: () => options.videoSupported !== false,
      closeStreamVideoPip: () => { fallbackCloses++; const previous = activeLeave; activeLeave = null; previous?.(); },
      openStreamVideoPip: async (stream: TestMediaStream, leave: () => void) => {
        fallback.push({ tracks: [...stream.getTracks()], leave });
        if (options.videoError) throw options.videoError;
        activeLeave = leave;
      },
    },
  };
  const module = { exports: {} as typeof import('./streamPip') };
  let api: typeof import('./streamPip') | undefined;
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      module, exports: module.exports, window, document, HTMLLinkElement, MutationObserver, MediaStream: TestMediaStream,
      localStorage: {
        getItem: (key: string) => { if (options.storageError) throw new Error('storage'); return saved.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (options.storageError) throw new Error('storage'); saved.set(key, value); saves.push(key); },
      },
      require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `R254 описана граница ${id}`); return deps[id]; },
    });
    api = module.exports;
    assert.equal(api.useStreamPipWindow(), null);
    await check({ api, state, changes, sizes, windows, saved, saves, fallback, invokes, order, readWindow: () => snapshot(), snapshots,
      hide: w => { w.closed = true; w.dispatchEvent(new Event('pagehide')); },
      tick: () => new Promise<void>(resolve => window.setTimeout(resolve, 0)),
      fallbackCloses: () => fallbackCloses,
    });
  } finally {
    try { api?.closeStreamPip(); }
    finally {
      for (const unsub of unsubs) unsub();
      try { await GlobalRegistrator.unregister(); }
      finally {
        for (const [key, descriptor] of [['__TAURI__', previousTauri], ['documentPictureInPicture', previousDocumentApi]] as const) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    }
  }
}

async function copiedStyles(raw = source) {
  await fixture(async f => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/assets/app.css'; document.head.append(link);
    const style = document.createElement('style'); style.textContent = '.probe { color: #f2b33d; }'; document.head.append(style);
    document.documentElement.setAttribute('lang', 'ru'); document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.setProperty('--accent', '#f2b33d'); document.body.className = 'desktop theme-dark';
    f.saved.set(rules.STREAM_PIP_SIZE_KEY, JSON.stringify({ width: 800, height: 100 }));
    await f.api.openStreamPip(ref());
    const doc = f.windows[0].document;
    assert.deepEqual(f.sizes, [{ width: 800, height: 450 }]);
    assert.equal(doc.querySelector('link[rel=stylesheet]')?.getAttribute('href'), 'https://chat.example.test/assets/app.css',
      'R254 адрес stylesheet в новом документе абсолютный');
    assert.equal(doc.querySelector('style')?.textContent, style.textContent);
    assert.equal(doc.documentElement.lang, 'ru'); assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(doc.documentElement.hasAttribute('data-stale'), false);
    assert.equal(doc.documentElement.style.getPropertyValue('--accent'), '#f2b33d');
    assert.ok(doc.documentElement.classList.contains('gv-stream-pip-doc')); assert.equal(doc.body.className, 'desktop theme-dark');
    assert.deepEqual(f.state.pipStreams, ['peer-a#screen']); assert.equal(f.readWindow(), f.windows[0]);
    assert.deepEqual(f.snapshots, [f.windows[0]]); assert.equal(f.fallback.length, 0);
  }, {}, raw);
}
// Класс ошибки: окошко теряет стили/тему или загружает относительный CSS не с того адреса.
it('R254 документ PiP получает стили, абсолютный CSS, атрибуты html и классы body', () => copiedStyles());

// Класс ошибки: смена темы не доходит до окошка, либо закрытое окно продолжает слушать страницу.
it('R254 тема и классы обновляются на лету, а закрытие отключает наблюдение', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); const w = f.windows[0];
    document.documentElement.setAttribute('data-theme', 'light'); document.body.className = 'theme-light'; await f.tick();
    assert.equal(w.document.documentElement.getAttribute('data-theme'), 'light'); assert.equal(w.document.body.className, 'theme-light');
    document.documentElement.removeAttribute('data-theme'); await f.tick();
    assert.equal(w.document.documentElement.hasAttribute('data-theme'), false);
    f.api.closeStreamPip(); document.documentElement.setAttribute('data-theme', 'dark'); document.body.className = 'after-close'; await f.tick();
    assert.equal(w.document.documentElement.hasAttribute('data-theme'), false); assert.equal(w.document.body.className, 'theme-light');
  });
});

async function hidden(raw = source) {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); const w = f.windows[0];
    await f.api.openStreamPip(ref('peer-b#screen'));
    w.innerWidth = 720; w.innerHeight = 405; f.hide(w);
    assert.deepEqual(f.state.pipStreams, [], 'R254 pagehide забывает все показы в сторе');
    assert.equal(f.readWindow(), null); assert.deepEqual(f.changes, [['peer-a#screen'], ['peer-a#screen', 'peer-b#screen'], []]);
    assert.equal(f.saved.get(rules.STREAM_PIP_SIZE_KEY), JSON.stringify({ width: 720, height: 405 }), 'R254 pagehide сохраняет размер окна');
    assert.deepEqual(f.saves, [rules.STREAM_PIP_SIZE_KEY]); assert.deepEqual(f.snapshots, [w, null]);
    f.hide(w); f.api.closeStreamPip();
    assert.deepEqual(f.changes, [['peer-a#screen'], ['peer-a#screen', 'peer-b#screen'], []]); assert.equal(f.saves.length, 1);
  }, {}, raw);
}
// Класс ошибки: закрытый системным крестиком показ остаётся в сторе или забывает выбранный размер.
it('R254 pagehide очищает все показы и сохраняет размер ровно один раз', () => hidden());

// Класс ошибки: наша кнопка закрытия и системный pagehide дважды снимают состояние/сохраняют размер.
it('R254 явное закрытие закрывает окно и освобождает его до повторного pagehide', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); const w = f.windows[0]; f.api.closeStreamPip();
    assert.equal(w.closes, 1); assert.deepEqual(f.state.pipStreams, []); assert.equal(f.readWindow(), null);
    assert.deepEqual(f.changes, [['peer-a#screen'], []]); assert.equal(f.saves.length, 1);
  });
});

async function added(raw = source) {
  await fixture(async f => {
    await f.api.openStreamPip(ref('peer-a#screen')); const first = f.windows[0];
    await f.api.openStreamPip(ref('peer-b#screen'));
    assert.deepEqual(f.state.pipStreams, ['peer-a#screen', 'peer-b#screen'], 'R256 открытое окно получает второй показ');
    assert.equal(first.closes, 0); assert.equal(f.windows.length, 1); assert.equal(f.sizes.length, 1);
    assert.deepEqual(f.changes, [['peer-a#screen'], ['peer-a#screen', 'peer-b#screen']]); assert.equal(f.readWindow(), first);
    assert.deepEqual(f.snapshots, [first]); assert.equal(f.fallback.length, 0); assert.deepEqual(f.saves, []);
    // Контракт позднего pagehide остаётся нужен и после отказа от замены окна вторым показом.
    f.api.closeStreamPip(); await f.api.openStreamPip(ref('peer-c#screen')); const current = f.windows[1];
    f.hide(first); assert.deepEqual(f.state.pipStreams, ['peer-c#screen']); assert.equal(f.readWindow(), current);
    assert.equal(current.closes, 0);
  }, {}, raw);
}
// Класс ошибки: второй показ теряется либо вместо добавления открывает и закрывает лишнее окно.
it('R256 второе открытие добавляет показ в тот же документ без нового requestWindow', () => added());

// Класс ошибки: наличие API скрывает его реальный отказ и не даёт посмотреть доступный поток.
it('R254 отказ requestWindow открывает запасной video PiP с тем же живым треком', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref());
    assert.equal(f.sizes.length, 1); assert.equal(f.windows.length, 0); assert.equal(f.readWindow(), null);
    assert.equal(f.fallback.length, 1); assert.deepEqual(f.fallback[0].tracks, [track]); assert.deepEqual(f.state.pipStreams, ['peer-a#screen']);
    f.fallback[0].leave(); assert.deepEqual(f.state.pipStreams, []);
  }, { documentError: new Error('window unavailable') });
});

// Класс ошибки: без API окна не работает video-путь, либо старое leave сбрасывает новый поток.
it('R254 без API документа используется video PiP, старый callback не закрывает следующий показ', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); const oldLeave = f.fallback[0].leave;
    await f.api.openStreamPip(ref('peer-b#screen'));
    oldLeave(); assert.deepEqual(f.state.pipStreams, ['peer-b#screen']); assert.equal(f.sizes.length, 0);
    assert.deepEqual(f.changes, [['peer-a#screen'], [], ['peer-b#screen']]); assert.equal(f.fallback.length, 2);
    f.api.closeStreamPip(); assert.deepEqual(f.state.pipStreams, []);
  }, { documentApi: false });
});

// Класс ошибки: после отказа обоих API сцена навсегда заменяет кадр заглушкой неоткрытого окошка.
it('R254 отказ запасного пути отклоняет Promise и очищает список показов', async () => {
  const failure = new Error('video unavailable');
  await fixture(async f => {
    await assert.rejects(f.api.openStreamPip(ref()), error => error === failure);
    assert.deepEqual(f.state.pipStreams, []); assert.equal(f.readWindow(), null); assert.deepEqual(f.changes, [['peer-a#screen'], []]);
  }, { documentError: new Error('document unavailable'), videoError: failure });
});

// Класс ошибки: без живой дорожки ложный fallback помечает показ открытым; документу дорожка не требуется.
it('R254 отсутствие дорожки отвергает только video-путь, окно документа остаётся доступным', async () => {
  const missing = { participant: { identity: 'peer-a#screen' } };
  await fixture(async f => {
    await assert.rejects(f.api.openStreamPip(missing), /stream pip: no track/); assert.deepEqual(f.changes, []); assert.equal(f.fallback.length, 0);
  }, { documentApi: false });
  await fixture(async f => { await f.api.openStreamPip(missing); assert.equal(f.windows.length, 1); assert.deepEqual(f.state.pipStreams, ['peer-a#screen']); });
});

// Класс ошибки: запрет localStorage блокирует показ/закрытие вместо обычного размера по умолчанию.
it('R254 недоступное хранилище не мешает открытию и закрытию с размером по умолчанию', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); assert.deepEqual(f.sizes, [rules.STREAM_PIP_DEFAULT]);
    f.hide(f.windows[0]); assert.deepEqual(f.state.pipStreams, []); assert.equal(f.saves.length, 0);
  }, { storageError: true });
});

// Класс ошибки: нулевые размеры закрывающегося окна затирают ранее сохранённый рабочий размер.
it('R254 закрытие с нулевым размером не перезаписывает сохранённый размер', async () => {
  await fixture(async f => {
    const saved = JSON.stringify({ width: 800, height: 450 }); f.saved.set(rules.STREAM_PIP_SIZE_KEY, saved);
    await f.api.openStreamPip(ref()); f.windows[0].innerWidth = 0; f.hide(f.windows[0]);
    assert.equal(f.saved.get(rules.STREAM_PIP_SIZE_KEY), saved); assert.equal(f.saves.length, 0); assert.deepEqual(f.state.pipStreams, []);
  });
});

// Класс ошибки: связка с платформой/API предлагает заведомо неработающую кнопку либо прячет запасной путь.
it('R254 доступность кнопки учитывает Android и каждый независимый API', async () => {
  for (const [options, expected] of [
    [{ android: true }, false], [{ documentApi: false, videoSupported: false }, false],
    [{ documentApi: false, videoSupported: true }, true], [{ videoSupported: false }, true],
  ] as const) await fixture(async f => { assert.equal(f.api.streamPipAvailable(), expected); }, options);
});

for (const [label, from, to, check, message] of [
  ['относительный stylesheet', 'if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;', '', copiedStyles, 'R254 адрес stylesheet'],
  ['pagehide оставляет показы', '    useStore.getState().clearPipStreams();', '', hidden, 'R254 pagehide забывает'],
  ['pagehide теряет размер', '    saveSize(w);', '', hidden, 'R254 pagehide сохраняет'],
  ['добавление в открытое окно потеряно', '    useStore.getState().addPipStream(identity, PIP_MAX);', '', added, 'R256 открытое окно получает второй'],
] as const) {
  // Класс ошибки: потеря стилей, очистки, размера или добавления обязана быть замечена сценарием.
  it(`R254 контрфакт окна: ${label}`, async () => {
    await check(); assert.equal(source.split(from).length - 1, 1, 'единственный адресный якорь');
    await assert.rejects(check(source.replace(from, to)), error => error instanceof assert.AssertionError && error.message.startsWith(message));
  });
}

async function desktopArm(raw = source) {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await fixture(async f => {
    f.saved.set(rules.STREAM_PIP_SIZE_KEY, JSON.stringify({ width: 1500, height: 1 }));
    const opening = f.api.openStreamPip(ref());
    try {
      for (let i = 0; i < 6; i++) await Promise.resolve();
      assert.deepEqual(f.invokes, [{ command: 'gv_pip_arm', args: { width: 960, height: 540 } }],
        'R255 разрешение получает тот же ограниченный размер');
      assert.deepEqual(f.sizes, [], 'R255 requestWindow ждёт завершения разрешения');
      assert.deepEqual(f.state.pipStreams, []);
      release(); await opening;
      assert.deepEqual(f.sizes, [{ width: 960, height: 540 }]);
      assert.deepEqual(f.order, ['invoke', 'requestWindow']);
      assert.equal(f.fallback.length, 0);
    } finally { release(); await opening.catch(() => {}); }
  }, { tauri: 'core', invokeWait: wait }, raw);
}
// Класс ошибки: окно приходит раньше одноразового разрешения или с другим размером в WebView2.
it('R255 десктоп дожидается gv_pip_arm с тем же рассчитанным размером до requestWindow', () => desktopArm());

// Класс ошибки: веб начинает зависеть от отсутствующего IPC вместо обычного PiP.
it('R255 веб без Tauri открывает документ PiP без вызова invoke', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); assert.deepEqual(f.invokes, []); assert.deepEqual(f.order, ['requestWindow']);
    assert.equal(f.windows.length, 1);
  });
});

// Класс ошибки: старый десктопный мост без core ломает путь окна вместо совместимости с вебом.
it('R255 Tauri без core не требует IPC и не мешает окну документа', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); assert.deepEqual(f.invokes, []); assert.equal(f.windows.length, 1);
  }, { tauri: 'no-core' });
});

// Класс ошибки: отказ необязательной команды запрещает доступный браузерный requestWindow.
it('R255 отказ gv_pip_arm не мешает requestWindow и не включает запасной video-путь', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); assert.equal(f.invokes.length, 1);
    assert.deepEqual(f.order, ['invoke', 'requestWindow']); assert.equal(f.windows.length, 1); assert.equal(f.fallback.length, 0);
    assert.deepEqual(f.sizes, [f.invokes[0].args]);
  }, { tauri: 'core', invokeError: new Error('command unavailable') });
});

// Класс ошибки: разрешение окна взводится для video PiP и остаётся пригодным постороннему window.open.
it('R255 без Document API запасной video PiP не взводит разрешение окна Tauri', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); assert.deepEqual(f.invokes, []); assert.deepEqual(f.order, []); assert.equal(f.fallback.length, 1);
  }, { tauri: 'core', documentApi: false });
});

// Класс ошибки: добавление повторно взводит разрешение, либо настоящее новое окно остаётся без него.
it('R256 добавление не взводит разрешение снова, новое окно после закрытия взводит отдельно', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); await f.api.openStreamPip(ref('peer-b#screen'));
    assert.deepEqual(f.order, ['invoke', 'requestWindow']); assert.equal(f.invokes.length, 1);
    assert.equal(f.windows.length, 1); assert.equal(f.windows[0].closes, 0);
    assert.deepEqual(f.state.pipStreams, ['peer-a#screen', 'peer-b#screen']);
    f.api.closeStreamPip(); await f.api.openStreamPip(ref('peer-c#screen'));
    assert.deepEqual(f.order, ['invoke', 'requestWindow', 'invoke', 'requestWindow']);
    assert.equal(f.invokes.length, 2); assert.equal(f.windows[0].closes, 1);
    assert.deepEqual(f.invokes.map(call => call.args), f.sizes);
    assert.deepEqual(f.changes, [['peer-a#screen'], ['peer-a#screen', 'peer-b#screen'], [], ['peer-c#screen']]);
  }, { tauri: 'core' });
});

for (const [label, from, to, message] of [
  ['разрешение не ожидается', 'await armDesktopPip(size);', 'void armDesktopPip(size);', 'R255 requestWindow ждёт'],
  ['IPC получает другой размер', "core.invoke('gv_pip_arm', { width: size.width, height: size.height })",
    "core.invoke('gv_pip_arm', { width: 480, height: 270 })", 'R255 разрешение получает тот же'],
] as const) {
  // Класс ошибки: успешный requestWindow не маскирует неверный порядок IPC или передачу его размера.
  it(`R255 контрфакт стыковки: ${label}`, async () => {
    await desktopArm(); assert.equal(source.split(from).length - 1, 1, 'единственный адресный якорь');
    await assert.rejects(desktopArm(source.replace(from, to)), error =>
      error instanceof assert.AssertionError && error.message.startsWith(message));
  });
}

// Класс ошибки: повторный клик создаёт дубль, меняет порядок либо заново запрашивает окно.
it('R256 повторный показ не дублируется и не вытесняет соседа из открытого документа', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); await f.api.openStreamPip(ref('peer-b#screen'));
    const before = f.state.pipStreams; const changes = f.changes.length;
    await f.api.openStreamPip(ref());
    assert.equal(f.state.pipStreams, before); assert.equal(f.changes.length, changes);
    assert.deepEqual(f.state.pipStreams, ['peer-a#screen', 'peer-b#screen']);
    assert.equal(f.windows.length, 1); assert.equal(f.windows[0].closes, 0); assert.equal(f.sizes.length, 1);
    assert.equal(f.fallback.length, 0);
  });
});

// Класс ошибки: четвёртый показ ошибочно вытесняется или пятый раздувает список вместо удаления старейшего.
it('R256 четыре показа помещаются, пятый вытесняет старейший без пересоздания окна', async () => {
  await fixture(async f => {
    for (const id of ['a', 'b', 'c', 'd']) await f.api.openStreamPip(ref(id));
    assert.deepEqual(f.state.pipStreams, ['a', 'b', 'c', 'd']);
    await f.api.openStreamPip(ref('e'));
    assert.deepEqual(f.state.pipStreams, ['b', 'c', 'd', 'e']);
    assert.equal(f.windows.length, 1); assert.equal(f.sizes.length, 1); assert.equal(f.windows[0].closes, 0);
    assert.deepEqual(f.snapshots, [f.windows[0]]); assert.deepEqual(f.saves, []); assert.equal(f.fallback.length, 0);
  });
});

// Класс ошибки: закрытие одной карточки гасит весь документ и прерывает оставшийся показ.
it('R256 удаление не последнего показа сохраняет окно и остальных, чужой id ничего не меняет', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); await f.api.openStreamPip(ref('peer-b#screen'));
    const w = f.windows[0]; const closes = f.fallbackCloses();
    f.api.removeFromStreamPip('peer-a#screen');
    assert.deepEqual(f.state.pipStreams, ['peer-b#screen']); assert.equal(f.readWindow(), w);
    assert.equal(w.closes, 0); assert.equal(f.fallbackCloses(), closes); assert.deepEqual(f.saves, []);
    assert.deepEqual(f.snapshots, [w]);
    const changes = f.changes.length;
    f.api.removeFromStreamPip('missing'); f.api.removeFromStreamPip('peer-a#screen');
    assert.equal(f.changes.length, changes); assert.deepEqual(f.state.pipStreams, ['peer-b#screen']);
    assert.equal(w.closes, 0); assert.equal(f.readWindow(), w);
  });
});

// Класс ошибки: удалён последний показ, но пустой документ остаётся поверх приложений и слушает тему.
it('R256 удаление последнего показа закрывает документ, сохраняет размер и отключает тему', async () => {
  await fixture(async f => {
    await f.api.openStreamPip(ref()); const w = f.windows[0];
    w.innerWidth = 720; w.innerHeight = 405;
    f.api.removeFromStreamPip('peer-a#screen');
    assert.equal(w.closes, 1); assert.deepEqual(f.state.pipStreams, []); assert.equal(f.readWindow(), null);
    assert.deepEqual(f.changes, [['peer-a#screen'], []]); assert.deepEqual(f.snapshots, [w, null]);
    assert.equal(f.saved.get(rules.STREAM_PIP_SIZE_KEY), JSON.stringify({ width: 720, height: 405 }));
    assert.deepEqual(f.saves, [rules.STREAM_PIP_SIZE_KEY]);
    document.documentElement.setAttribute('data-after-remove', 'changed'); await f.tick();
    assert.equal(w.document.documentElement.hasAttribute('data-after-remove'), false);
    f.api.removeFromStreamPip('peer-a#screen'); f.hide(w);
    assert.equal(w.closes, 1); assert.equal(f.saves.length, 1);
  });
});

async function removedFallback(raw = source) {
  for (const extra of [false, true]) await fixture(async f => {
    await f.api.openStreamPip(ref());
    // Нормальный video PiP содержит один id. Дополнительный id моделирует рассинхрон стора:
    // именно при длине > 1 ветка !pipWindow отличается от проверки «последний показ».
    if (extra) f.state.addPipStream('stale#screen', 4);
    const closes = f.fallbackCloses();
    f.api.removeFromStreamPip('peer-a#screen');
    assert.equal(f.fallbackCloses(), closes + 1, 'R256 удаление в запасном пути закрывает video PiP независимо от списка');
    assert.deepEqual(f.state.pipStreams, []); assert.equal(f.readWindow(), null);
    assert.equal(f.windows.length, 0); assert.deepEqual(f.saves, []);
    f.fallback[0].leave(); assert.deepEqual(f.state.pipStreams, []);
  }, { documentApi: false }, raw);
}
// Класс ошибки: запасное video-окно продолжает жить после удаления его показа из списка.
it('R256 удаление показа запасного пути закрывает video PiP при одном и нескольких id стора', () => removedFallback());

// Класс ошибки: без проверки отсутствия документа непоследний id удаляется, но video PiP не закрывается.
it('R256 контрфакт удаления: без !pipWindow запасное окно не закрывается при нескольких id', async () => {
  await removedFallback();
  const from = 'if (!pipWindow || st.pipStreams.length <= 1)';
  assert.equal(source.split(from).length - 1, 1, 'единственный адресный якорь');
  await assert.rejects(removedFallback(source.replace(from, 'if (st.pipStreams.length <= 1)')), error =>
    error instanceof assert.AssertionError && error.message.startsWith('R256 удаление в запасном пути закрывает'));
});
