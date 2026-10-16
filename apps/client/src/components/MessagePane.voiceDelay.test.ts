import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import { act } from 'react';
import { VOICE_HOLD, voiceCancelPath } from '../voiceHold';
import type { VoiceTake } from '../voiceRecorder';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const raw = readFileSync(new URL('./MessagePane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function declarations(source: string) {
  const ast = ts.createSourceFile('MessagePane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlers: string[] = [];
  let openMic = '';
  const names = ['onMicDown', 'onMicMove', 'onMicUp', 'onMicAbort'];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) handlers.push(node.getText(ast));
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'openMic') openMic = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(handlers.length, names.length, 'извлечены реальные обработчики кнопки');
  assert.ok(openMic, 'извлечён настоящий openMic контроллера');
  return { handlers, openMic };
}

function phoneHarness(source: string, initial = {}) {
  let now = 0; let nextId = 1; let toggles = 0; let opens = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: { id: number; x: number; y: number; path: number }[] = [];
  const state = { recording: false, preview: null, recBusy: false, holdUi: null, ...initial };
  const phonePressRef = { current: null as unknown };
  const sandbox = {
    VOICE_HOLD, voiceCancelPath, phonePressRef, roundOkRef: { current: true },
    window: { innerWidth: 390, setTimeout(callback: () => void, ms: number) { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id; } },
    clearTimeout(id: number) { timers.delete(id); },
    toggleRoundMode() { toggles++; },
    voice: { getState: () => state, press(p: { id: number; x: number; y: number }, opts: { path: number }) {
      calls.push({ ...p, path: opts.path }); opens++; return 'hold';
    }, move() {}, release() {}, abort() {} },
    api: {} as Record<string, (e: unknown) => void>,
  };
  runInNewContext(ts.transpileModule(declarations(source).handlers.join('\n') + '\nthis.api={onMicDown,onMicMove,onMicUp,onMicAbort};',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  function advance(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.callback();
  }
  const event = (x = 300, y = 500) => ({ pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: y,
    preventDefault() {}, currentTarget: { setPointerCapture() {} } });
  return { onMicDown: sandbox.api.onMicDown!, onMicMove: sandbox.api.onMicMove!, onMicUp: sandbox.api.onMicUp!,
    onMicAbort: sandbox.api.onMicAbort!, roundOkRef: sandbox.roundOkRef, advance, event, calls, timers,
    get toggles() { return toggles; }, get opens() { return opens; } };
}

function counterfacts(check: (source: string) => void, replacements: [string, string][]) {
  check(raw); // Падение оригинала никогда не выдаём за пойманного мутанта.
  for (const [from, to] of replacements) {
    const changed = raw.replace(from, to);
    assert.notEqual(changed, raw, `найден якорь ${from}`);
    assert.throws(() => check(changed), assert.AssertionError);
  }
}

it('R117 short при доступных кружках показывает подсказку, но не переключает режим', () => {
  // Страж AST: берём hint ТОЛЬКО из аргумента контроллера записи, не одноимённое
  // поле автодополнения упоминаний; исходник не исполняется в искусственном scope.
  counterfacts(source => {
    const ast = ts.createSourceFile('pane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hints: ts.Expression[] = [];
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createVoiceHoldController') {
        const options = n.arguments[0];
        assert.ok(options && ts.isObjectLiteralExpression(options), 'контроллер получает объект настроек');
        for (const property of options.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(ast) === 'hint') hints.push(property.initializer);
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(ast);
    assert.equal(hints.length, 1, 'ровно один hint принадлежит контроллеру записи');
    const hint = hints[0]!;
    assert.ok(ts.isArrowFunction(hint), 'hint контроллера — обработчик');
    assert.equal(hint.parameters.length, 0);
    let body: ts.Node = hint.body;
    // Допускаем равнозначную запись с блоком, но никаких дополнительных действий/ветвлений.
    if (ts.isBlock(body)) {
      assert.equal(body.statements.length, 1, 'short не является тапом-переключателем');
      const statement = body.statements[0]!;
      assert.ok(ts.isExpressionStatement(statement) || ts.isReturnStatement(statement), 'hint только показывает тост');
      assert.ok(statement.expression, 'hint содержит вызов тоста');
      body = statement.expression;
    }
    assert.ok(ts.isCallExpression(body), 'short не является тапом-переключателем');
    assert.ok(ts.isIdentifier(body.expression));
    assert.equal(body.expression.text, 'toast', 'hint без условий всегда показывает тост');
    assert.equal(body.arguments.length, 2);
    const [level, message] = body.arguments;
    assert.ok(level && ts.isStringLiteral(level));
    assert.ok(message && ts.isStringLiteral(message));
    assert.equal(level.text, 'info');
    assert.equal(message.text, 'Удерживайте для записи');
  }, [["hint: () => toast('info', 'Удерживайте для записи'),",
    "hint: () => { if (roundOkRef.current) toggleRoundMode(); else toast('info', 'Удерживайте для записи'); },"]]);
});

it('R117 размонтирование снимает отложенный телефонный press и очищает ссылку', () => {
  counterfacts(source => {
    const ast = ts.createSourceFile('pane.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let cleanup = '';
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect' &&
        n.getText(ast).includes('const pend = phonePressRef.current;')) cleanup = n.arguments[0]!.getText(ast);
      ts.forEachChild(n, visit);
    }
    visit(ast); assert.ok(cleanup, 'извлечён настоящий эффект уборки');
    const ref = { current: { timer: 42 } as { timer: number } | null }; const timers = new Set([42]);
    runInNewContext(ts.transpileModule(`(${cleanup})()()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { phonePressRef: ref, clearTimeout(id: number) { timers.delete(id); } });
    assert.equal(timers.size, 0, 'таймер физически снят, а не только скрыт');
    assert.equal(ref.current, null);
    // Повторная уборка уже пустой ссылки безопасна.
    runInNewContext(ts.transpileModule(`(${cleanup})()()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { phonePressRef: ref, clearTimeout() { assert.fail('пустая ссылка не имеет таймера'); } });
  }, [['if (pend) clearTimeout(pend.timer);', '/* таймер оставлен */']]);
});

it('D19 короткий тап 149 мс меняет режим без press и открытия устройства', () => {
  counterfacts(source => {
    const p = phoneHarness(source); p.onMicDown!(p.event()); p.advance(149);
    assert.equal(p.calls.length, 0, 'короткое касание не вызывает press');
    assert.equal(p.opens, 0, 'до срока контроллер не открывает микрофон');
    p.onMicUp!(p.event()); p.advance(1);
    assert.equal(p.toggles, 1, 'короткий тап переключил камеру и микрофон');
    assert.equal(p.calls.length, 0, 'отпущенное касание не оживает на 150 мс');
    assert.equal(p.timers.size, 0, 'таймер короткого касания снят');
  }, [['if (roundOkRef.current && !phonePressRef.current', 'if (false && !phonePressRef.current']]);
});

it('D19 ровно 150 мс начинает удержание от точки касания, а не последнего move', () => {
  counterfacts(source => {
    const p = phoneHarness(source); p.onMicDown!(p.event(300, 500)); p.advance(149);
    p.onMicMove!(p.event(280, 460));
    assert.equal(p.calls.length, 0, 'движение до срока не начинает запись');
    p.advance(1);
    assert.deepEqual(p.calls, [{ id: 7, x: 300, y: 500, path: voiceCancelPath(390) }], 'начало жеста остаётся в точке касания');
    p.advance(150); assert.equal(p.calls.length, 1, 'удержание стартует один раз');
  }, [['voice.move({ id: e.pointerId, x: e.clientX, y: e.clientY });',
    'if (phonePressRef.current) { phonePressRef.current.x=e.clientX; phonePressRef.current.y=e.clientY; } voice.move({ id: e.pointerId, x: e.clientX, y: e.clientY });']]);
});

it('D19 отправка при записи и прослушивании немедленная, новая запись без кружков тоже без задержки', () => {
  counterfacts(source => {
    for (const state of [{ recording: true }, { preview: { take: {} } }, { recBusy: true }, { holdUi: { dx: 0, dy: 0 } }]) {
      const p = phoneHarness(source, state); p.onMicDown!(p.event());
      assert.equal(p.calls.length, 1, 'касание «отправить» не ждёт 150 мс');
      assert.equal(p.timers.size, 0, 'отправке не назначен таймер записи');
    }
    // Старый сервер без circles1 должен сохранить исходное немедленное удержание.
    const noCircles = phoneHarness(source); noCircles.roundOkRef.current = false; noCircles.onMicDown!(noCircles.event());
    assert.equal(noCircles.calls.length, 1, 'без кружков задержки нет');
  }, [
    ['if (roundOkRef.current && !phonePressRef.current && !st.recording && !st.preview && !st.recBusy && !st.holdUi)',
      'if (roundOkRef.current && !phonePressRef.current && !st.recBusy && !st.holdUi)'],
    [' && !st.recBusy && !st.holdUi) {', ') {'],
  ]);
});

it('D19 системная отмена до 150 мс снимает таймер и не меняет режим', () => {
  counterfacts(source => {
    const p = phoneHarness(source); p.onMicDown!(p.event()); p.advance(149); p.onMicAbort!(p.event());
    assert.equal(p.timers.size, 0, 'onMicAbort действительно снял таймер, а не только спрятал press');
    p.advance(500); assert.equal(p.calls.length, 0, 'отменённое касание не открывает устройство');
    assert.equal(p.toggles, 0, 'системная отмена не равна короткому тапу');
  }, [['phonePressRef.current = null;\n      clearTimeout(pend.timer);\n      return;', 'phonePressRef.current = null;\n      return;']]);
});

it('D19 отмена старого кружка A сохраняет B, отмена своего A снимает его и вызывает исходный cancel с this', async () => {
  const check = async (source: string) => {
    type Recording = { cancel(): void };
    let live: Recording | null = null; let cancelled = 0;
    const a: Recording = { cancel() { assert.equal(this, a, 'метод cancel сохранил владельца'); cancelled++; } };
    const b: Recording = { cancel() {} };
    const sandbox = { roundModeRef: { current: true }, startRoundRecording: async () => a,
      startVoiceRecording: async () => b, setRoundLive(next: Recording | null | ((cur: Recording | null) => Recording | null)) {
        live = typeof next === 'function' ? next(live) : next;
      }, openMic: undefined as unknown as () => Promise<Recording> };
    runInNewContext(ts.transpileModule(`this.openMic = ${declarations(source).openMic};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    assert.equal(await sandbox.openMic(), a); assert.equal(live, a);
    live = b; a.cancel(); assert.equal(live, b, 'поздняя отмена A не убирает активный B');
    live = a; a.cancel(); assert.equal(live, null, 'отмена своего A снимает кружок');
    assert.equal(cancelled, 2, 'обёртка дважды вызвала исходное освобождение камеры');
  };
  await check(raw);
  for (const [from, to] of [
    ['cur === r ? null : cur', 'null'],
    ['r.cancel = () => {\n            setRoundLive((cur) => (cur === r ? null : cur));\n            cancel0.call(r);\n          };', '/* обёртка удалена */'],
  ]) {
    const changed = raw.replace(from!, to!); assert.notEqual(changed, raw);
    await assert.rejects(() => check(changed), assert.AssertionError);
  }
});

// Подменяем только устройства браузера, не MessagePane, openMic, контроллер или функции рекордеров.
function mediaFixture(staleCamera = false) {
  const saved: { target: object; key: string; descriptor: PropertyDescriptor | undefined }[] = [];
  const set = (target: object, key: string, value: unknown) => {
    saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  class Stream {
    constructor(private readonly tracks: { kind: string; stop(): void }[] = []) {}
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  }
  const stream = (video = false) => new Stream([{ kind: 'audio', stop() {} }, ...(video ? [{ kind: 'video', stop() {} }] : [])]);
  const requests: { video: boolean; at: number; resolve(value: Stream): void }[] = [];
  const recorders: Recorder[] = [];
  class Recorder extends EventTarget {
    static isTypeSupported(type: string) { return type.includes('webm'); }
    state = 'inactive';
    readonly mimeType: string;
    ondataavailable: ((event: Event & { data: Blob }) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    constructor(_stream: Stream, options?: { mimeType?: string }) { super(); this.mimeType = options?.mimeType ?? 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    requestData() {
      const event = Object.assign(new Event('dataavailable'), { data: new Blob(['recorded'], { type: this.mimeType }) });
      this.ondataavailable?.(event); this.dispatchEvent(event);
    }
    stop() { this.requestData(); this.state = 'inactive'; const event = new Event('stop'); this.onstop?.(event); this.dispatchEvent(event); }
  }
  class Audio {
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(0); } }; }
    createMediaStreamSource() { return { connect() {} }; }
    async decodeAudioData() { throw new Error('фиктивный звук — настоящая запасная огибающая'); }
    async close() {}
  }
  for (const target of [globalThis, window]) {
    set(target, 'MediaRecorder', Recorder); set(target, 'MediaStream', Stream); set(target, 'AudioContext', Audio);
  }
  set(navigator, 'mediaDevices', { getUserMedia(constraints: { video?: unknown }) {
    if (!constraints.video) { requests.push({ video: false, at: offset, resolve() {} }); return Promise.resolve(stream()); }
    return new Promise<Stream>(resolve => { requests.push({ video: true, at: offset, resolve }); });
  } });
  set(HTMLCanvasElement.prototype, 'captureStream', () => new Stream([{ kind: 'video', stop() {} }]));
  // RecordCircle теперь рисует кляксы настоящим RecordBlob; тот же canvas-мок обслуживает и круглый рекордер.
  // Это только контракт 2D API, не симуляция пикселей: контроллерные проверки записи остаются прежними.
  set(HTMLCanvasElement.prototype, 'getContext', () => ({
    drawImage() {}, setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {},
    bezierCurveTo() {}, closePath() {}, fill() {}, arc() {}, fillStyle: '', globalAlpha: 1,
  }));
  set(HTMLMediaElement.prototype, 'play', async () => {});
  // HappyDOM может иметь собственную реализацию play у video; она не должна оставлять
  // настоящий roundRecorder между getUserMedia и созданием MediaRecorder.
  set(HTMLVideoElement.prototype, 'play', async () => {});
  if (staleCamera) {
    // HappyDOM srcObject проверяет instanceof своего импортированного MediaStream,
    // не глобального заменённого конструктора. Без этого адаптера startRoundRecording
    // отвергает fixture Stream ДО MediaRecorder, а контроллер проглатывает отказ открытия.
    const target = HTMLVideoElement.prototype;
    saved.push({ target, key: 'srcObject', descriptor: Object.getOwnPropertyDescriptor(target, 'srcObject') });
    const streams = new WeakMap<object, Stream | null>();
    Object.defineProperty(target, 'srcObject', {
      configurable: true,
      get() { return streams.get(this) ?? null; },
      set(value: Stream | null) {
        assert.ok(value === null || value instanceof Stream, 'video получает поток нашего фиктивного устройства');
        streams.set(this, value);
      },
    });
  }
  const dateNow = Date.now;
  let offset = 0;
  set(Date, 'now', () => dateNow() + offset);
  set(performance, 'now', () => offset);
  const timers = new Map<number, () => void>(); let nextId = -10000;
  for (const target of [globalThis, window]) {
    const oldSet = target.setTimeout.bind(target); const oldClear = target.clearTimeout.bind(target);
    set(target, 'setTimeout', (callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 150 && typeof callback === 'function') { const id = nextId--; timers.set(id, () => callback(...args)); return id; }
      return oldSet(callback as () => void, ms, ...args);
    });
    set(target, 'clearTimeout', (id: unknown) => {
      if (typeof id === 'number' && timers.delete(id)) return;
      oldClear(id as never);
    });
  }
  const delivered = new Set<object>();
  return { requests, stream, recorders, advance(ms: number) {
    offset += ms;
    for (const request of requests) if (request.video && !delivered.has(request) && offset >= request.at + 700) {
      delivered.add(request); request.resolve(stream(true));
    }
  },
    startHold() { offset += 150; for (const [id, callback] of [...timers]) if (timers.delete(id)) callback(); },
    restore() {
      for (const { target, key, descriptor } of saved.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
      }
    } };
}

async function recordingScenario(component = h.Pane, staleCamera = false) {
  const savedMode = localStorage.getItem('gv.recMode');
  h.round12(); localStorage.setItem('gv.recMode', 'round');
  const restoreLayout = h.pointerLayout(true, 390);
  const media = mediaFixture(staleCamera); const sent: VoiceTake[] = [];
  const pointer = (type: string, id = 1, y = 500) => {
    const mic = h.host.querySelector<HTMLButtonElement>('.mic-btn'); assert.ok(mic, 'телефонная кнопка записи есть');
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerType: 'touch', pointerId: id, button: 0, clientX: 300, clientY: y }))
      Object.defineProperty(event, key, { value });
    mic.dispatchEvent(event);
  };
  try {
    await h.mount({ roundOk: true, onSendVoice: async take => { sent.push(take); } }, component);
    await act(async () => {
      pointer('pointerdown');
      if (staleCamera) media.startHold();
      if (staleCamera) media.advance(10);
      // Без ожидания реальных 150 мс: таймер ручной, обычный tap не открывает камеру вообще.
      pointer('pointerup'); await h.flush();
    });
    assert.equal(media.requests.filter(r => r.video).length, staleCamera ? 1 : 0, 'короткий тап не запрашивает камеру');
    if (staleCamera) {
      assert.equal(localStorage.getItem('gv.recMode'), 'round', 'короткая начатая запись не переключает режим');
      // После short режим прежний: только отдельный настоящий тап до 150 мс выбирает микрофон.
      await act(async () => { pointer('pointerdown', 4); pointer('pointerup', 4); await h.flush(); });
    }
    assert.equal(localStorage.getItem('gv.recMode'), 'voice', 'короткое касание переключило кружок на голосовое');
    if (staleCamera) media.advance(250);
    await act(async () => { pointer('pointerdown', 2); media.startHold(); await h.flush(); });
    assert.equal(media.requests.filter(r => !r.video).length, 1, 'новое удержание открыло именно микрофон');
    assert.equal(media.recorders.filter(r => r.mimeType.startsWith('audio/')).length, 1, 'аудиорекордер действительно создан до поздней камеры');
    await act(async () => { pointer('pointermove', 2, 443); pointer('pointerup', 2, 443); await h.flush(); });
    assert.ok(h.host.querySelector('.rec-stop'), 'подъём на 57 пикселей зафиксировал запись без рук');
    if (staleCamera) {
      // Камера A запрошена на t=150, отпущена на t=160; новое удержание B начинается
      // через 250 мс (t=410), микрофон B готов на t=560. A приходит на t=850:
      // token A уже dead, B уже пишет без рук. Контроллер обязан вызвать cancel A.
      assert.equal(media.recorders.filter(r => r.mimeType.startsWith('video/')).length, 0, 'камера ещё не пришла до замка голосового');
      await act(async () => { media.advance(290); await h.flush(); });
      const camera = media.recorders.filter(r => r.mimeType.startsWith('video/'));
      assert.equal(camera.length, 1, 'поздняя камера прошла настоящий roundRecorder до MediaRecorder');
      assert.equal(camera[0]!.state, 'inactive', 'контроллер отменил настоящий рекордер мёртвого касания');
    }
    const mic = h.host.querySelector<HTMLButtonElement>('.mic-btn'); assert.ok(mic);
    assert.equal(mic.title, 'Отправить голосовое', 'вид кнопки соответствует активному аудиорекордеру');
    assert.ok(!h.host.querySelector('.round-rec'), 'старое открытие камеры не оставило кружок над голосовым');
    media.advance(1000);
    await act(async () => { pointer('pointerdown', 3); pointer('pointerup', 3); await h.flush(); });
    assert.equal(sent.length, 1, 'зафиксированное голосовое отправлено одним касанием');
    assert.match(sent[0]!.file.name, /^voice-.*\.webm$/, 'имя файла соответствует видимой отправке голосового');
    assert.match(sent[0]!.file.type, /^audio\/webm(?:;|$)/, 'отправлен аудио MIME, не кружок');
    assert.equal(sent[0]!.round, undefined, 'у аудиофайла нет пометки видеосообщения');
  } finally {
    h.unmount(); media.restore(); restoreLayout();
    if (savedMode === null) localStorage.removeItem('gv.recMode'); else localStorage.setItem('gv.recMode', savedMode);
  }
}

h.mutantTest('D19 тап → удержание → замок → отправить не запускает задержанную камеру и отправляет видимое голосовое', async () => {
  await h.rejectMutant(source => source.replace('if (roundOkRef.current && !phonePressRef.current', 'if (false && !phonePressRef.current'),
    async component => recordingScenario(component), 'короткий тап не запрашивает камеру');
});

h.mutantTest('D19 поздняя камера отменённого касания не превращает текущий аудиофайл в видеосообщение', async () => {
  await h.rejectMutant(source => source.replace(
    'r.cancel = () => {\n            setRoundLive((cur) => (cur === r ? null : cur));\n            cancel0.call(r);\n          };',
    '/* D19 обёртка удалена */'), async component => recordingScenario(component, true), 'вид кнопки соответствует активному аудиорекордеру');
});
