import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const storage = new Map<string, string>([['gv_token', 'test-token']]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
});

type NotifyEvent = (event: { payload: unknown }) => void;
const invokes: { cmd: string; args: unknown }[] = [];
const listeners: NotifyEvent[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {},
    __GUSVOICE_CONFIG__: {
      apiUrl: 'https://api.example.test',
      presenceWs: 'wss://presence.example.test',
      pushGateway: 'https://push.example.test',
      ntfyServer: 'https://ntfy.example.test',
    },
    __TAURI__: {
      core: {
        invoke: async (cmd: string, args: unknown) => {
          invokes.push({ cmd, args });
        },
      },
      event: {
        listen: async (_event: string, handler: NotifyEvent) => {
          listeners.push(handler);
          return () => {};
        },
      },
    },
  },
});

describe('нативные провода уведомлений', () => {
  it('уведомление с пустым текстом называет видео, фото и смешанные файлы по настоящему списку', async () => {
    // Проводка уведомления не должна потерять вид вложения между строкой беседы и ОС.
    const { messagePreview } = await import('./notifications.js');
    assert.equal(messagePreview({ content: '', attachments: [{ contentType: 'video/mp4', durationMs: 42_000 }] }), 'Видео');
    assert.equal(messagePreview({ content: '', attachments: [{ contentType: 'video/mp4' }, { contentType: 'video/webm' }] }), '2 видео');
    assert.equal(messagePreview({ content: '', attachments: [{ contentType: 'video/mp4' }, { contentType: 'image/png' }] }), '2 файла');
    assert.equal(messagePreview({ content: '', attachments: [{ contentType: 'image/png' }, { contentType: 'image/jpeg' }] }), '2 фото');
    assert.equal(messagePreview({ content: '', attachments: [null, 'junk'] }), 'Новое сообщение');
    assert.equal(messagePreview({ content: ' подпись ', attachments: [{ contentType: 'video/mp4' }] }), 'подпись');
  });
  for (const level of ['off', 'mentions', 'all'] as const) {
    it(`свежий ошибочный ключ ${level} побеждает прежний выбор и переносится без потери`, async () => {
      // Ловит сброс выбора людей, открывших настройки между ошибочным переименованием и исправлением.
      const snapshot = new Map(storage);
      try {
        storage.set('gv_os_notify', level === 'all' ? 'off' : 'all');
        storage.set('gv_notify_clickable', level);
        const { osNotifyLevel, osNotifyEnabled } = await import('./notifications.js');
        assert.equal(osNotifyLevel(), level);
        assert.equal(storage.get('gv_os_notify'), level);
        assert.equal(storage.has('gv_notify_clickable'), false);
        assert.equal(osNotifyLevel(), level, 'повторное чтение сохраняет перенесённый выбор');
        assert.equal(osNotifyEnabled(), level !== 'off');
      } finally { storage.clear(); for (const [k, v] of snapshot) storage.set(k, v); }
    });
  }
  it('мусор в ошибочном ключе не перебивает корректный, а отсутствие выбора даёт умолчание', async () => {
    // Ловит принятие старого булева или похожей строки за новый уровень уведомлений.
    const snapshot = new Map(storage);
    try {
      const { osNotifyLevel } = await import('./notifications.js');
      for (const bad of ['', '1', '0', 'ALL', ' all ', 'true', 'null']) {
        storage.set('gv_notify_clickable', bad);
        for (const good of ['off', 'mentions', 'all']) {
          storage.set('gv_os_notify', good);
          assert.equal(osNotifyLevel(), good, `${bad} не перебивает ${good}`);
        }
        storage.delete('gv_os_notify');
        assert.equal(osNotifyLevel(), 'mentions');
      }
      storage.delete('gv_notify_clickable');
      assert.equal(osNotifyLevel(), 'mentions');
    } finally { storage.clear(); for (const [k, v] of snapshot) storage.set(k, v); }
  });
  it('новая запись всех уровней очищает ошибочный ключ и не затрагивает настройки монет', async () => {
    // Ловит возврат старого выбора при следующем чтении и смешивание двух независимых настроек.
    const snapshot = new Map(storage);
    try {
      const { setOsNotifyLevel, osNotifyLevel } = await import('./notifications.js');
      storage.set('gv_coin_notify', 'mine');
      for (const level of ['off', 'mentions', 'all'] as const) {
        storage.set('gv_notify_clickable', level === 'all' ? 'off' : 'all');
        setOsNotifyLevel(level);
        assert.equal(storage.get('gv_os_notify'), level);
        assert.equal(storage.has('gv_notify_clickable'), false);
        assert.equal(osNotifyLevel(), level);
        assert.equal(storage.get('gv_coin_notify'), 'mine');
      }
    } finally { storage.clear(); for (const [k, v] of snapshot) storage.set(k, v); }
  });
  it('сбой чтения, записи и удаления не бросает; перенос сначала сохраняет выбор', async () => {
    // Ловит потерю единственной копии настройки при переполненном/запрещённом хранилище.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    const { osNotifyLevel, setOsNotifyLevel } = await import('./notifications.js');
    try {
      for (const failure of ['get', 'set', 'remove'] as const) {
        const values = new Map([['gv_notify_clickable', 'off'], ['gv_os_notify', 'all']]);
        const calls: string[] = [];
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
          getItem(k: string) { if (failure === 'get') throw new Error('storage denied'); return values.get(k) ?? null; },
          setItem(k: string, v: string) { calls.push(`set:${k}`); if (failure === 'set') throw new Error('quota'); values.set(k, v); },
          removeItem(k: string) { calls.push(`remove:${k}`); if (failure === 'remove') throw new Error('denied'); values.delete(k); },
        } });
        assert.equal(osNotifyLevel(), failure === 'get' ? 'mentions' : 'off');
        assert.equal(values.get('gv_notify_clickable'), 'off', 'неудачный перенос оставляет исходную копию');
        if (failure !== 'get') assert.deepEqual(calls, failure === 'set' ? ['set:gv_os_notify'] : ['set:gv_os_notify', 'remove:gv_notify_clickable']);
        assert.doesNotThrow(() => setOsNotifyLevel('mentions'));
      }
    } finally { Object.defineProperty(globalThis, 'localStorage', descriptor); }
  });
  it('браузер получает silent true только у тихого, но показ и действие клика сохраняются', async () => {
    // Ловит потерю Notification из-за тихости и утечку новой опции в обычные уведомления.
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const oldNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
    const shown: { title: string; options: Record<string, unknown>; onclick?: () => void; close(): void }[] = [];
    let focus = 0, clicks = 0, closed = 0;
    class FakeNotification {
      static permission = 'granted';
      onclick?: () => void;
      constructor(public title: string, public options: Record<string, unknown>) { shown.push(this); }
      close() { closed++; }
    }
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { Notification: FakeNotification, focus: () => focus++ } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { hasFocus: () => false, visibilityState: 'visible' } });
    try {
      const { osNotify } = await import('./notifications.js');
      osNotify('quiet', 'body', () => clicks++, false, { silent: true });
      osNotify('normal', 'body');
      osNotify('false', 'body', undefined, false, { silent: false });
      assert.deepEqual(shown.map((n) => [n.title, n.options]), [
        ['quiet', { body: 'body', silent: true }], ['normal', { body: 'body' }], ['false', { body: 'body' }],
      ]);
      shown[0].onclick?.();
      assert.deepEqual([focus, clicks, closed], [1, 1, 1]);
      FakeNotification.permission = 'denied';
      osNotify('denied', 'body', undefined, false, { silent: true });
      assert.equal(shown.length, 3, 'без разрешения не показывается и тихое');
    } finally {
      for (const [key, descriptor] of [['window', oldWindow], ['document', oldDocument], ['Notification', oldNotification]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  it('registerPush без ключей вообще не сериализует поле keys', async () => {
    // Ловит `keys: null`, которое старый сервер или строгая схема могли бы принять не так, как отсутствие поля.
    let sent: RequestInit | undefined;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (_url: string, init: RequestInit) => {
        sent = init;
        return new Response(null, { status: 204 });
      },
    });
    const { api } = await import('./api.js');
    await api.registerPush('https://ntfy.example.test/topic', 'device', null);
    const body = JSON.parse(String(sent?.body)) as Record<string, unknown>;
    assert.equal(Object.hasOwn(body, 'keys'), false);
    assert.deepEqual(body, {
      endpoint: 'https://ntfy.example.test/topic',
      deviceId: 'device',
      platform: 'android',
    });
  });

  it('десктопный тост передаёт одну метку и один раз исполняет обработчик клика', async () => {
    // Ловит потерянный переход по тосту и повторное действие от дублированного события оболочки.
    const { osNotifyRaw } = await import('./notifications.js');
    let clicks = 0;
    osNotifyRaw('ЛС', 'текст', () => clicks++);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(invokes[0]?.cmd, 'gv_notify_clickable');
    assert.equal(listeners.length, 1);
    const tag = (invokes[0]?.args as { tag?: unknown }).tag;
    assert.equal(typeof tag, 'string');
    listeners[0]?.({ payload: tag });
    listeners[0]?.({ payload: tag });
    assert.equal(clicks, 1);
  });
});
