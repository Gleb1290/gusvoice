import { counterfact } from '../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { React, environment, mutate } from './components/R171.phoneHarness';

const source = readFileSync(new URL('./externalLinks.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const href = 'https://outside.example.org/docs?section=bots#start';
const P = 'R362/integration/check/';
type Registration = { type: string; listener: EventListener; options?: boolean | AddEventListenerOptions };

async function check(raw: string, guarded: boolean, platform: 'desktop' | 'web' | 'android' = 'desktop') {
  await environment(async (host, render) => {
    const toasts: unknown[][] = [];
    const nativeOpened: string[][] = [];
    const oldBridge = Object.getOwnPropertyDescriptor(window, 'GusVoiceNative');
    let browserOpens = 0;
    let operations = 0, reactClicks = 0;
    let budgetError: Error | undefined;
    const step = (operation: string) => {
      if (++operations > 100) {
        budgetError ??= new Error(`R362/integration/budget/${operation}`);
        throw budgetError;
      }
    };
    const opened: string[] = [], order: string[] = [], registrations: Registration[] = [];
    const oldAddDescriptor = Object.getOwnPropertyDescriptor(window, 'addEventListener');
    const oldOpenDescriptor = Object.getOwnPropertyDescriptor(window, 'open');
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    const restore = (name: 'addEventListener' | 'open', descriptor?: PropertyDescriptor) => {
      if (descriptor) Object.defineProperty(window, name, descriptor);
      else Reflect.deleteProperty(window, name);
    };
    // Настройки environment ниже запрещают default-action навигации. Прямой window.open тоже
    // перехвачен; доставка click и preventDefault проходят настоящий React DOM и window.
    Object.defineProperty(window, 'open', { configurable: true, writable: true, value: () => {
      step('browser-open'); browserOpens++; return null;
    } });
    try {
      if (platform === 'android') {
        Object.defineProperty(window, 'GusVoiceNative', { configurable: true, value: {
          openExternalUri: (url: string, fallback: string) => {
            nativeOpened.push([url, fallback]); return true;
          },
        } });
      }
      const module = { exports: {} };
      const dependencies: Record<string, unknown> = {
        './hotkeys': {
          isDesktop: () => { step('isDesktop'); return platform === 'desktop'; },
          isAndroid: () => { step('isAndroid'); return platform === 'android'; },
        },
        './toast': { toast: (...args: unknown[]) => { toasts.push(args); return toasts.length; } },
        './desktopWindow': { openExternal: (url: string) => {
          step('openExternal'); opened.push(url); order.push('external'); return Promise.resolve();
        } },
      };
      // Загружается целый production-модуль, подменены только платформенный IO и его признак.
      runInNewContext(ts.transpileModule(raw, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      } }).outputText, { module, exports: module.exports, window, URL, require: (id: string) => {
        if (!Object.hasOwn(dependencies, id)) throw new Error(`R362/integration/setup/граница:${id}`);
        return dependencies[id];
      } }, { timeout: 200 });
      const links = module.exports as { installExternalLinks(): void };
      function Link() {
        step('render');
        return React.createElement('a', { href, target: '_blank', onClick: guarded ? (e: React.MouseEvent) => {
          step('react-click'); reactClicks++; order.push('react'); e.preventDefault();
        } : undefined }, React.createElement('span', { 'data-click': true }, 'Документация'));
      }
      step('update');
      await render(React.createElement(Link));
      const targets = host.querySelectorAll<HTMLSpanElement>('[data-click]');
      assert.equal(targets.length, 1, 'R362/integration/setup/настоящий-смонтированный-React');
      assert.equal(opened.length, 0, P + 'рендер-не-открывает');

      // Перехватываем лишь регистрацию: реальное всплытие/захват остаются у happy-dom.
      // Исходник не возвращает dispose, поэтому храним настоящие обёртки для finally.
      Object.defineProperty(window, 'addEventListener', { configurable: true, writable: true,
        value: (type: string, listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions) => {
          step('add-listener');
          if (!listener) return;
          const wrapped: EventListener = event => {
            step('window-click');
            if (typeof listener === 'function') listener.call(window, event);
            else listener.handleEvent(event);
          };
          registrations.push({ type, listener: wrapped, options });
          add(type, wrapped, options);
        } });
      try { step('install'); links.installExternalLinks(); }
      finally { restore('addEventListener', oldAddDescriptor); }
      if (platform !== 'android') {
        const expected = platform === 'desktop' ? 1 : 0;
        assert.equal(registrations.length, expected, P + 'слушатель-только-в-десктопе');
        assert.equal(registrations.filter(registration => registration.type === 'click').length,
          expected, P + 'установлен-именно-click');
      }

      const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 });
      await React.act(async () => { step('dispatch'); targets[0].dispatchEvent(event); });
      // DOM может поглотить ошибку listener: предохранитель всё равно должен краснить харнесс,
      // а не случайно считаться адресным kill из-за недоставленного события.
      if (budgetError) throw budgetError;
      assert.deepEqual(nativeOpened, platform === 'android' && !guarded ? [[href, '']] : []);
      assert.deepEqual(toasts, [], 'успешное открытие не показывает предупреждение');
      if (platform === 'android') assert.equal(browserOpens, 0);
      if (guarded) {
        assert.equal(reactClicks, 1, P + 'React-получил-настоящий-click');
        // Как MessageLink: подтверждение уже забрало клик, системный браузер нельзя открыть раньше него.
        assert.equal(opened.length, 0, P + 'React-preventDefault-не-обойдён');
        assert.equal(order.join(','), 'react', P + 'обработчик-React-раньше-перехватчика');
        assert.equal(event.defaultPrevented, true, P + 'React-отменил-переход');
      } else if (platform === 'android') {
        assert.deepEqual(opened, [], 'Android не вызывает десктопное открытие');
        assert.equal(event.defaultPrevented, true, 'Android отменяет переход внутри WebView');
      } else if (platform === 'desktop') {
        assert.equal(opened.length, 1, P + 'голая-ссылка-открыта-ровно-раз');
        assert.equal(opened[0], href, P + 'системному-браузеру-передан-свой-href');
        assert.equal(event.defaultPrevented, true, P + 'перехватчик-отменил-переход');
        assert.equal(reactClicks, 0, P + 'голая-ссылка-без-React-обработчика');
      } else {
        assert.equal(opened.length, 0, P + 'веб-не-зовёт-десктопный-IO');
        assert.equal(event.defaultPrevented, false, P + 'веб-переходит-обычным-способом');
      }
    } finally {
      restore('addEventListener', oldAddDescriptor);
      for (const registration of registrations) remove(registration.type, registration.listener, registration.options);
      restore('open', oldOpenDescriptor);
      if (oldBridge) Object.defineProperty(window, 'GusVoiceNative', oldBridge);
      else Reflect.deleteProperty(window, 'GusVoiceNative');
    }
  }, { settings: { navigation: {
    disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true,
  } } });
}

it('R362 React preventDefault оставляет подтверждение ссылки хозяином клика и не открывает браузер', async () => {
  await check(source, true);
});

it('R362 голая target=_blank через настоящий click открывает свой href ровно раз и отменяет переход', async () => {
  await check(source, false);
});

it('R362 вне десктопа общий перехватчик не ставит слушатель и не меняет обычный клик', async () => {
  await check(source, false, 'web');
});

it('на Android голая ссылка уходит в системный браузер с отменой перехода в WebView', async () => {
  await check(source, false, 'android');
});

it('на Android отменённый обработчиком React клик не открывает системный браузер', async () => {
  await check(source, true, 'android');
});

it('R362 контрфакт захвата обходит React preventDefault и адресно отвергается', async () => {
  await check(source, true);
  await counterfact(async () => {
    const capture = mutate(source, '  });\n}', '  }, true);\n}');
    await assert.rejects(check(capture, true), error => error instanceof assert.AssertionError
      && error.message.startsWith(P + 'React-preventDefault-не-обойдён')
      && error.actual === 1 && error.expected === 0,
    'захват убит лишним openExternal, а не ошибкой загрузки, setup или бюджета');
  });
  await check(source, true);
});
