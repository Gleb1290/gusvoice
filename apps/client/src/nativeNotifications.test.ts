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
