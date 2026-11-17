import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import type { TypingAction } from '@gusvoice/shared';
import type { VoiceTake } from '../voiceRecorder';
import { setupHarness } from './MessagePane.behavior.harness';
const h = setupHarness(import.meta.url);
function mediaFixture() {
  const saved: { target: object; key: string; descriptor: PropertyDescriptor | undefined }[] = [];
  const set = (target: object, key: string, value: unknown) => {
    saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  class Stream {
    constructor(private readonly tracks: { kind: string; stop(): void; label?: string; readyState?: string; getSettings?(): MediaTrackSettings }[] = []) {}
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  }
  const stream = (video = false) => new Stream([{ kind: 'audio', stop() {} }, ...(video ? [{
    kind: 'video', label: 'Front camera', readyState: 'live', stop() {},
    getSettings() { return { facingMode: 'user', deviceId: 'front' }; },
  }] : [])]);
  const requests: { video: boolean; at: number; resolve(value: Stream): void }[] = [];
  const recorders: Recorder[] = [];
  const paints: { canvas: HTMLCanvasElement; radius: number }[] = [];
  let amplitude = 0;
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
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(amplitude); } }; }
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
  set(HTMLCanvasElement.prototype, 'getContext', function (this: HTMLCanvasElement) {
    const canvas = this;
    let radius = 0;
    return {
      drawImage() {}, setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {},
      bezierCurveTo() {}, closePath() {}, fillStyle: '', globalAlpha: 1,
      arc(_x: number, _y: number, value: number) { radius = value; },
      fill() { paints.push({ canvas, radius }); },
    };
  });
  set(HTMLMediaElement.prototype, 'play', async () => {});
  set(HTMLVideoElement.prototype, 'play', async () => {});
  // HappyDOM иначе отвергает fixture Stream до настоящего MediaRecorder и скрывает ошибку открытия камеры.
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
  const dateNow = Date.now;
  let offset = 0;
  set(Date, 'now', () => dateNow() + offset);
  set(performance, 'now', () => offset);
  const timers = new Map<number, { at: number; run(): void }>(); let nextId = -10000, steps = 0;
  for (const target of [globalThis, window]) {
    const oldSet = target.setTimeout.bind(target); const oldClear = target.clearTimeout.bind(target);
    set(target, 'setTimeout', (callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 150 && typeof callback === 'function') { const id = nextId--; timers.set(id, { at: offset + ms, run: () => callback(...args) }); return id; }
      return oldSet(callback as () => void, ms, ...args);
    });
    set(target, 'clearTimeout', (id: unknown) => {
      if (typeof id === 'number' && timers.delete(id)) return;
      oldClear(id as never);
    });
  }
  const delivered = new Set<object>();
  return { requests, recorders, paints,
    setAmplitude(value: number) { assert.ok(Number.isFinite(value) && value >= 0 && value <= 1); amplitude = value; },
    advance(ms: number) {
    assert.ok(ms >= 0 && Number.isFinite(ms));
    offset += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= offset && timers.delete(id)) {
      assert.ok(++steps <= 100, 'ограничен бюджет таймеров удержания'); timer.run();
    }
    for (const request of requests) if (request.video && !delivered.has(request) && offset >= request.at + 700) {
      delivered.add(request); request.resolve(stream(true));
    }
  },
    get pending() { return timers.size; },
    restore() {
      timers.clear();
      for (const { target, key, descriptor } of saved.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
      }
    } };
}
// Настоящая кнопка, контроллер и рекордеры; подменены только устройства и часы браузера.
async function withRecording(check: (ctx: { media: ReturnType<typeof mediaFixture>; sent: VoiceTake[];
  pointer(type: string, id?: number, x?: number, y?: number): void }) => Promise<void>, roundOk = true, waitForSend?: Promise<void>,
  onUpload?: (onProgress?: (loaded: number, total: number) => void) => void,
  onTyping?: (action?: TypingAction) => void) {
  const savedMode = localStorage.getItem('gv.recMode');
  h.round12(); localStorage.setItem('gv.recMode', 'voice');
  const restoreLayout = h.pointerLayout(true, 390);
  const media = mediaFixture(), sent: VoiceTake[] = [];
  const pointer = (type: string, id = 1, x = 300, y = 500) => {
    const mic = h.host.querySelector<HTMLButtonElement>('.mic-btn'); assert.ok(mic);
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerType: 'touch', pointerId: id, button: 0, clientX: x, clientY: y }))
      Object.defineProperty(event, key, { value });
    mic.dispatchEvent(event);
  };
  try {
    await h.mount({ roundOk, onTyping, onSendVoice: async (take, _opts, onProgress) => { sent.push(take); onUpload?.(onProgress); await waitForSend; } });
    await check({ media, sent, pointer });
  } finally {
    try { h.unmount(); } finally {
      media.restore(); restoreLayout();
      if (savedMode === null) localStorage.removeItem('gv.recMode'); else localStorage.setItem('gv.recMode', savedMode);
    }
  }
}
for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'unmount'] as const) {
  it(`касание до 150 мс: ${end === 'pointerup' ? 'тап меняет режим' : end === 'unmount' ? 'уход снимает таймер' : end + ' отменяет жест'} без открытия устройства`, async () => {
    await withRecording(async ({ media, sent, pointer }) => {
      await act(async () => { pointer('pointerdown'); media.advance(149); await h.flush(); });
      assert.equal(media.requests.length, 0, 'на 149 мс устройство ещё не открывается');
      assert.equal(media.pending, 1);
      await act(async () => { if (end === 'unmount') h.unmount(); else pointer(end); await h.flush(); });
      assert.equal(media.pending, 0, 'отмена физически снимает отложенный press');
      await act(async () => { media.advance(501); await h.flush(); });
      assert.equal(media.requests.length, 0, 'отменённый таймер не оживает');
      assert.equal(localStorage.getItem('gv.recMode'), end === 'pointerup' ? 'round' : 'voice');
      assert.deepEqual(sent, []);
    });
  });
}
it('на 150 мс удержание начинается от исходного касания; короткая запись даёт подсказку без смены режима', async () => {
  await withRecording(async ({ media, sent, pointer }) => {
    const { useToasts } = await h.server.ssrLoadModule('/src/toast.ts') as typeof import('../toast');
    const before = useToasts.getState().toasts;
    try {
      await act(async () => { pointer('pointerdown'); media.advance(149); pointer('pointermove', 1, 280, 460); await h.flush(); });
      assert.equal(media.requests.length, 0);
      await act(async () => { media.advance(1); await h.flush(); });
      assert.equal(media.requests.length, 1); assert.equal(media.pending, 0);
      await act(async () => { pointer('pointerdown', 9); media.advance(150); await h.flush(); });
      assert.equal(media.requests.length, 1, 'второй палец при удержании не открывает другое устройство');
      await act(async () => { pointer('pointermove', 1, 300, 443); await h.flush(); });
      assert.ok(h.host.querySelector('.rec-stop'), '57 пикселей вверх от исходной точки фиксируют запись');
      await act(async () => { h.host.querySelector<HTMLButtonElement>('.rec-trash')!.click(); await h.flush(); });
      assert.equal(media.recorders.at(-1)!.state, 'inactive', 'корзина останавливает удерживаемое голосовое');
      assert.deepEqual(sent, [], 'корзина не отправляет голосовое');
      await act(async () => { pointer('pointerdown', 2); media.advance(150); await h.flush(); });
      await act(async () => { pointer('pointerup', 2); await h.flush(); });
      assert.equal(localStorage.getItem('gv.recMode'), 'voice'); assert.deepEqual(sent, []);
      assert.equal(media.recorders.at(-1)!.state, 'inactive');
      assert.ok(useToasts.getState().toasts.some(t => !before.includes(t) && t.type === 'info' && t.title === 'Удерживайте для записи'));
    } finally { useToasts.setState({ toasts: before }); }
  });
});

it('круг следует за микрофоном, ограничивает громкий сигнал и оставляет только подсказку отмены', async () => {
  await withRecording(async ({ media, pointer }) => {
    const lite = await h.server.ssrLoadModule('/src/liteMode.ts') as typeof import('../liteMode');
    const previous = lite.liteModeEnabled(), stored = localStorage.getItem('gv_lite_mode');
    try {
      await act(async () => { lite.setLiteModeEnabled(true); await h.flush(); });
      assert.equal(h.host.querySelector('.rec-circle,.rec-blob'), null, 'без удержания круг не появляется');
      media.setAmplitude(0.9);
      await act(async () => { pointer('pointerdown'); await h.flush(); });
      const mic = h.host.querySelector<HTMLButtonElement>('.mic-btn')!;
      const circle = mic.querySelector<HTMLElement>('.rec-circle');
      assert.ok(circle, 'настоящий лёгкий круг лежит внутри движущейся кнопки');
      assert.equal(h.host.querySelectorAll('.rec-circle').length, 1, 'нет второго отдельно нарисованного круга');
      // Ждём наблюдаемое обновление уровня, а не привязываем тест к периоду опроса рекордера.
      for (let step = 0; step < 20 && circle.style.getPropertyValue('--lvl') !== '1'; step++)
        await act(async () => { await h.delay(25); await h.flush(); });
      assert.equal(circle.style.getPropertyValue('--lvl'), '1', 'усиленный вход не раздувает круг выше максимума');
      await act(async () => { pointer('pointermove', 1, 260, 500); await h.flush(); });
      assert.equal(mic.style.getPropertyValue('--rx'), '-40px', 'круг движется вместе с кнопкой за пальцем');
      assert.ok(mic.contains(circle));
      assert.match(h.host.textContent ?? '', /Влево — отмена/);
      assert.doesNotMatch(h.host.textContent ?? '', /Вверх — продолжать запись/);
      assert.equal(h.host.querySelectorAll('.rec-lock').length, 1, 'замок доступен без отдельной подписи вверх');
      assert.equal(h.host.querySelector('.rec-lock-hint'), null);
      await act(async () => { pointer('pointercancel'); await h.flush(); });
      assert.equal(h.host.querySelector('.rec-circle'), null, 'лёгкий круг исчезает после отмены');
    } finally {
      try { h.unmount(); } finally {
        lite.setLiteModeEnabled(previous);
        if (stored === null) localStorage.removeItem('gv_lite_mode'); else localStorage.setItem('gv_lite_mode', stored);
      }
    }
  }, false);
});

for (const ending of ['send', 'cancel', 'lock'] as const)
  it(`круг доигрывает ${ending === 'send' ? 'отправку' : ending === 'cancel' ? 'отмену' : 'замок'} внутри кнопки и освобождает холст`, async () => {
    let release!: () => void;
    const sending = new Promise<void>(resolve => { release = resolve; });
    await withRecording(async ({ media, sent, pointer }) => {
      const lite = await h.server.ssrLoadModule('/src/liteMode.ts') as typeof import('../liteMode');
      const previous = lite.liteModeEnabled(), stored = localStorage.getItem('gv_lite_mode');
      const clock = h.controlUiClock();
      const frame = async () => act(async () => { media.advance(16); clock.runFrame(); await h.flush(); });
      try {
        await act(async () => { lite.setLiteModeEnabled(false); pointer('pointerdown'); await h.flush(); });
        const canvas = h.host.querySelector<HTMLCanvasElement>('.mic-btn .rec-blob');
        assert.ok(canvas, 'настоящий холст смонтирован внутри микрофона');
        // Достаточно длинная запись и для телефонного, и для десктопного порога;
        // этот сценарий проверяет уход круга, короткая запись проверена отдельно.
        for (let step = 0; step < 70; step++) await frame();
        if (ending === 'cancel') {
          const fullRadius = media.paints.at(-1)!.radius;
          await act(async () => { pointer('pointermove', 1, 260, 500); await h.flush(); });
          await frame();
          assert.ok(media.paints.at(-1)!.radius < fullRadius, 'приближение к отмене уменьшает настоящий нарисованный круг');
          await act(async () => { pointer('pointermove', 1, 300, 500); await h.flush(); });
          await frame();
          assert.ok(Math.abs(media.paints.at(-1)!.radius - fullRadius) < 0.001, 'возврат пальца восстанавливает размер');
        }
        const before = media.paints.at(-1)!;
        assert.equal(before.canvas, canvas); assert.ok(before.radius > 0);
        await act(async () => {
          if (ending === 'lock') pointer('pointermove', 1, 300, 443);
          pointer(ending === 'cancel' ? 'pointercancel' : 'pointerup'); await h.flush();
        });
        assert.equal(h.host.querySelector('.mic-btn .rec-blob'), canvas, 'снятие удержания не обрывает анимацию');
        assert.equal(media.recorders[0]!.state, ending === 'lock' ? 'recording' : 'inactive');
        assert.equal(sent.length, ending === 'send' ? 1 : 0);
        await frame();
        const first = media.paints.at(-1)!;
        if (ending === 'cancel') assert.ok(first.radius < before.radius, 'отмена сразу сжимает круг');
        else assert.ok(Math.abs(first.radius - before.radius) < 0.001, 'отправка и замок начинают уход с прежнего размера');
        for (let step = 0; step < 4; step++) await frame();
        const during = media.paints.at(-1)!;
        if (ending === 'send') assert.ok(during.radius > before.radius, 'отправка сначала раздувает круг');
        else assert.ok(during.radius < before.radius, 'отмена и замок уменьшают круг');
        for (let step = 0; step < 36; step++) await frame();
        assert.equal(h.host.querySelector('.rec-blob'), null, 'завершённый уход снимает холст');
      } finally {
        release();
        try { h.unmount(); } finally {
          clock.restore(); lite.setLiteModeEnabled(previous);
          if (stored === null) localStorage.removeItem('gv_lite_mode'); else localStorage.setItem('gv_lite_mode', stored);
        }
      }
    }, false, sending);
  });
for (const preview of [false, true]) {
  it(preview ? 'прослушивание при доступных кружках отправляется без задержки' : 'без кружков микрофон открывается сразу и замок отправляется без задержки', async () => {
    await withRecording(async ({ media, sent, pointer }) => {
      await act(async () => { pointer('pointerdown'); if (preview) media.advance(150); await h.flush(); });
      assert.equal(media.requests.length, 1); assert.equal(media.pending, 0);
      await act(async () => { pointer('pointermove', 1, 300, 443); pointer('pointerup'); media.advance(1000); await h.flush(); });
      if (preview) await act(async () => { h.host.querySelector<HTMLButtonElement>('.rec-stop')!.click(); await h.flush(); });
      await act(async () => { pointer('pointerdown', 2); pointer('pointerup', 2); await h.flush(); });
      assert.equal(media.pending, 0); assert.equal(media.requests.length, 1);
      assert.equal(sent.length, 1); assert.match(sent[0]!.file.type, /^audio\/webm(?:;|$)/);
    }, preview);
  });
}

for (const round of [false, true]) {
  it(round ? 'загрузка записанного кружка показывает байты до подтверждения сообщения' : 'загрузка голосового показывает байты до подтверждения сообщения', async () => {
    let finish!: () => void;
    let report: ((loaded: number, total: number) => void) | undefined;
    const actions: (TypingAction | undefined)[] = [];
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    try {
      await withRecording(async ({ media, pointer, sent }) => {
        const progress = await h.server.ssrLoadModule('/src/uploadProgress.ts') as typeof import('../uploadProgress');
        if (round) await act(async () => { pointer('pointerdown'); pointer('pointerup'); await h.flush(); });
        await act(async () => { pointer('pointerdown', 2); media.advance(150); await h.flush(); });
        await act(async () => { pointer('pointermove', 2, 300, 443); pointer('pointerup', 2); media.advance(700); await h.flush(); });
        media.advance(1000);
        await act(async () => { pointer('pointerdown', 3); pointer('pointerup', 3); await h.flush(); });
        assert.equal(sent.length, 1);
        assert.deepEqual(actions.filter((action) => action?.endsWith('_upload')), [round ? 'round_upload' : 'voice_upload']);
        assert.ok(report);
        assert.ok(h.host.querySelector('.recorded-upload'));
        assert.match(h.host.querySelector('.recorded-upload-title')!.textContent!, round ? /Видеосообщение/ : /Голосовое/);
        await act(async () => { report!(512, 1024); await h.flush(); });
        assert.equal(h.host.querySelector('.recorded-upload .att-up-status')!.getAttribute('aria-label'), '0,5 / 1,0 КБ');
        assert.equal(progress.hasActiveUploads(), true);
        await act(async () => { report!(1024, 1024); await h.flush(); });
        assert.equal(h.host.querySelector('.recorded-upload .att-up-status')!.getAttribute('aria-label'), 'Отправляется…');
        await act(async () => { finish(); await pending; await h.flush(); });
        assert.equal(h.host.querySelector('.recorded-upload'), null);
        assert.equal(progress.hasActiveUploads(), false);
        report!(1, 1024);
        assert.equal(progress.hasActiveUploads(), false, 'поздние байты завершённой отправки не создают новую загрузку');
      }, true, pending, (callback) => { report = callback; }, (action) => actions.push(action));
    } finally { finish(); }
  });
}

it('уход со страницы снимает счётчик записи и игнорирует поздние байты загрузки', async () => {
  let finish!: () => void;
  let report: ((loaded: number, total: number) => void) | undefined;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await withRecording(async ({ media, pointer }) => {
      const progress = await h.server.ssrLoadModule('/src/uploadProgress.ts') as typeof import('../uploadProgress');
      await act(async () => { pointer('pointerdown'); media.advance(150); await h.flush(); });
      await act(async () => { pointer('pointermove', 1, 300, 443); pointer('pointerup'); media.advance(1000); await h.flush(); });
      await act(async () => { pointer('pointerdown', 2); pointer('pointerup', 2); await h.flush(); });
      assert.ok(report);
      assert.equal(progress.hasActiveUploads(), true);
      await act(async () => h.unmount());
      assert.equal(progress.hasActiveUploads(), false);
      report!(100, 1000);
      assert.equal(progress.hasActiveUploads(), false);
      await act(async () => { finish(); await pending; await h.flush(); });
    }, true, pending, (callback) => { report = callback; });
  } finally { finish(); }
});

for (const preview of [false, true]) {
  it(preview ? 'корзина удаляет предпросмотр кружка без отправки и потери режима камеры' : 'корзина отменяет зафиксированную запись кружка без отправки', async () => {
    await withRecording(async ({ media, sent, pointer }) => {
      await act(async () => { pointer('pointerdown'); pointer('pointerup'); await h.flush(); });
      await act(async () => { pointer('pointerdown', 2); media.advance(150); await h.flush(); });
      await act(async () => { pointer('pointermove', 2, 300, 443); pointer('pointerup', 2); media.advance(700); await h.flush(); });
      assert.ok(h.host.querySelector('.round-rec-flip'), 'у идущего кружка есть смена камеры');
      media.advance(1000);
      if (preview) await act(async () => { h.host.querySelector<HTMLButtonElement>('.rec-stop')!.click(); await h.flush(); });
      const trash = h.host.querySelector<HTMLButtonElement>('.rec-trash')!;
      assert.ok(trash);
      const down = new Event('pointerdown', { bubbles: true, cancelable: true });
      trash.dispatchEvent(down);
      assert.equal(down.defaultPrevented, true, 'клавиатура не закрывается и не уводит кнопку до click');
      await act(async () => { trash.click(); await h.flush(); });
      assert.equal(media.recorders.at(-1)!.state, 'inactive');
      assert.equal(h.host.querySelector('.round-rec'), null);
      assert.equal(h.host.querySelector('.rec-trash'), null);
      assert.deepEqual(sent, []);
      assert.equal(localStorage.getItem('gv.recMode'), 'round');
    });
  });
}

it('поздняя отменённая камера не меняет активное голосовое; замок отправляет именно аудио', async () => {
  await withRecording(async ({ media, sent, pointer }) => {
    await act(async () => { pointer('pointerdown'); pointer('pointerup'); await h.flush(); });
    assert.equal(localStorage.getItem('gv.recMode'), 'round'); assert.equal(media.requests.length, 0);
    await act(async () => { pointer('pointerdown'); media.advance(150); media.advance(10); pointer('pointerup'); await h.flush(); });
    assert.equal(media.requests.filter(r => r.video).length, 1);
    assert.equal(localStorage.getItem('gv.recMode'), 'round', 'короткая начатая запись не переключает режим');
    await act(async () => { pointer('pointerdown', 4); pointer('pointerup', 4); media.advance(250); await h.flush(); });
    await act(async () => { pointer('pointerdown', 2); media.advance(150); await h.flush(); });
    assert.equal(media.recorders.filter(r => r.mimeType.startsWith('audio/')).length, 1);
    await act(async () => { pointer('pointermove', 2, 300, 443); pointer('pointerup', 2); await h.flush(); });
    assert.ok(h.host.querySelector('.rec-stop'));
    assert.equal(media.recorders.filter(r => r.mimeType.startsWith('video/')).length, 0);
    await act(async () => { media.advance(290); await h.flush(); });
    const camera = media.recorders.filter(r => r.mimeType.startsWith('video/'));
    assert.equal(camera.length, 1); assert.equal(camera[0]!.state, 'inactive', 'мёртвое касание освобождает позднюю камеру');
    assert.equal(media.recorders.find(r => r.mimeType.startsWith('audio/'))!.state, 'recording', 'поздняя камера не останавливает активное аудио');
    assert.equal(h.host.querySelector<HTMLButtonElement>('.mic-btn')!.title, 'Отправить голосовое');
    assert.ok(!h.host.querySelector('.round-rec'));
    media.advance(1000);
    await act(async () => { pointer('pointerdown', 3); pointer('pointerup', 3); await h.flush(); });
    assert.equal(media.pending, 0); assert.equal(sent.length, 1);
    assert.match(sent[0]!.file.name, /^voice-.*\.webm$/); assert.match(sent[0]!.file.type, /^audio\/webm(?:;|$)/);
    assert.equal(sent[0]!.round, undefined);
    await act(async () => { pointer('pointerdown', 5); pointer('pointerup', 5); await h.flush(); });
    await act(async () => { pointer('pointerdown', 6); media.advance(150); media.advance(700); await h.flush(); });
    assert.equal(media.recorders.at(-1)!.state, 'recording');
    await act(async () => { pointer('pointercancel', 6); await h.flush(); });
    assert.equal(media.recorders.at(-1)!.state, 'inactive');
    assert.ok(!h.host.querySelector('.round-rec')); assert.equal(sent.length, 1, 'отмена своей камеры не отправляет файл');
  });
});
