import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { BotCallbackResult, InlineKeyboard } from '@gusvoice/shared';
import * as rules from '../botKeyboardRules';
import * as linkSafety from '../linkSafety';
import * as dangerousLinkRules from '../dangerousLinkRules';

const source = readFileSync(new URL('./MessageKeyboard.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const linkSource = readFileSync(new URL('../linkGuard.tsx', import.meta.url), 'utf8');
const iconSource = readFileSync(new URL('./Icon.tsx', import.meta.url), 'utf8');
const keyboard: InlineKeyboard = [[{ text: 'Первая', callback_data: 'one' }, { text: 'Вторая', callback_data: 'two' }]];

it('R303 target канала имеет приоритет над старым convId и вызывает только channelBotCallback', async () => {
  await withKeyboard(async f => {
    await f.mount(keyboard, 'channel-message', 'channel', { kind: 'channel', id: 'channel-id' });
    await f.click();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].kind, 'channel');
    assert.deepEqual(f.requests[0].args, ['channel-id', 'channel-message', 'one', rules.BOT_CALLBACK_CLIENT_WAIT_MS]);
    await f.settle(0, { text: 'Принято' });
    assert.deepEqual(f.toasts, [['info', 'Принято']]);
  });
});
it('R303 явная цель беседы и прежний convId сохраняют DM API', async () => {
  await withKeyboard(async f => {
    await f.click();
    assert.equal(f.requests[0].kind, 'conv');
    assert.equal(f.requests[0].args[0], 'conv');
    await f.settle(0, {});
    await f.mount(keyboard, 'dm-message', 'dm', { kind: 'conv', id: 'explicit-conv' });
    await f.click();
    assert.equal(f.requests[1].kind, 'conv');
    assert.deepEqual(f.requests[1].args, ['explicit-conv', 'dm-message', 'one', rules.BOT_CALLBACK_CLIENT_WAIT_MS]);
    await f.settle(1, {});
  });
});

interface Request {
  kind: 'conv' | 'channel';
  args: [string, string, string, number];
  resolve: (value: BotCallbackResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}
interface Fixture {
  host: HTMLDivElement;
  requests: Request[];
  opened: string[];
  alerts: string[];
  toasts: Array<[string, string]>;
  errors: Array<[unknown, string]>;
  rowEvents: string[];
  mount: (kb?: InlineKeyboard, messageId?: string, instanceKey?: string, target?: { kind: 'conv' | 'channel'; id: string }) => Promise<void>;
  render: (node: React.ReactNode) => Promise<void>;
  linkCommands: (nodes: React.ReactNode, send: ((cmd: string) => void) | undefined) => React.ReactNode;
  click: (index?: number) => Promise<void>;
  settle: (index: number, value: BotCallbackResult | unknown, reject?: boolean) => Promise<void>;
}

// Настоящие полные TSX-модули, закрытый перечень импортов; подменены только сеть, окно ОС, диалог и тосты.
// happy-dom здесь проверяет DOM/события, не геометрию и не пиксели.
async function withKeyboard(check: (f: Fixture) => void | Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'https://client.example.test/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const requests: Request[] = [], opened: string[] = [], alerts: string[] = [], rowEvents: string[] = [];
  const toasts: Fixture['toasts'] = [], errors: Fixture['errors'] = [];
  window.open = (url?: string | URL) => { opened.push(String(url)); return null; };
  function load(text: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} as Record<string, any> };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, location: window.location, URL, require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `R302 неописанный импорт клавиатуры: ${id}`);
      return dependencies[id];
    } });
    return module.exports;
  }
  try {
    const linkGuard = load(linkSource, {
      react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
      './config': { config: { apiUrl: 'https://api.client.example.test' } },
      './hotkeys': { isDesktop: () => false },
      './desktopWindow': { openExternal: () => { throw new Error('R302 веб не зовёт ОС'); } },
      './linkSafety': linkSafety, './dangerousLinkRules': dangerousLinkRules,
      './dangerousLink': { DangerousMessageLink: () => { throw new Error('R302 неиспользуемая граница опасной ссылки'); } },
    });
    const request = (kind: Request['kind'], args: Request['args']) => new Promise<BotCallbackResult>((resolve, reject) => {
      const req: Request = { kind, args, settled: false,
        resolve: value => { req.settled = true; resolve(value); },
        reject: error => { req.settled = true; reject(error); } };
      requests.push(req);
    });
    const components = load(raw, {
      react: React, 'react/jsx-runtime': jsx, '../botKeyboardRules': rules,
      '../api': { api: { convBotCallback: (...args: Request['args']) => request('conv', args),
        channelBotCallback: (...args: Request['args']) => request('channel', args) } },
      '../confirm': { alertDialog: async (text: string) => { alerts.push(text); } },
      '../toast': { toast: (kind: string, text: string) => { toasts.push([kind, text]); },
        toastError: (error: unknown, fallback: string) => { errors.push([error, fallback]); } },
      '../linkGuard': linkGuard,
      './Icon': load(iconSource, { 'react/jsx-runtime': jsx }),
    });
    const render: Fixture['render'] = async node => {
      await React.act(async () => root.render(React.createElement('div', {
        className: 'message-row', onClick: () => rowEvents.push('click'), onMouseDown: () => rowEvents.push('mousedown'),
        onDoubleClick: () => rowEvents.push('dblclick'), onTouchStart: () => rowEvents.push('touchstart'),
      }, node)));
    };
    const f: Fixture = { host, requests, opened, alerts, toasts, errors, rowEvents, render,
      mount: async (kb = keyboard, messageId = 'mid', instanceKey = 'instance', target) => render(
        React.createElement(components.MessageKeyboard, { convId: 'conv', target, messageId, keyboard: kb, key: instanceKey })),
      linkCommands: components.linkBotCommands,
      click: async (index = 0) => {
        const button = host.querySelectorAll<HTMLButtonElement>('.bot-kb-btn')[index];
        assert.ok(button, 'R302 кнопка присутствует для настоящего клика');
        await React.act(async () => button.click());
      },
      settle: async (index, value, reject = false) => {
        assert.ok(requests[index], 'R302 запрос существует до ответа');
        await React.act(async () => { if (reject) requests[index].reject(value); else requests[index].resolve(value as BotCallbackResult); });
      },
    };
    await f.mount();
    await check(f);
  } finally {
    try {
      // Даже упавший контрфакт не оставляет обещаний, обновлений React и модульного pressing следующему сценарию.
      await React.act(async () => { for (const req of requests) if (!req.settled) req.resolve({}); });
      await React.act(async () => root.unmount());
    } finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}

function busy(f: Fixture, index = 0) {
  const button = f.host.querySelectorAll('.bot-kb-btn')[index];
  assert.ok(button);
  return { aria: button.getAttribute('aria-busy'), loading: button.classList.contains('loading'),
    spin: !!button.querySelector('.confirm-spin[aria-hidden="true"]') };
}
function noFeedback(f: Fixture) {
  assert.deepEqual([f.alerts.length, f.toasts.length, f.errors.length], [0, 0, 0]);
}

it('R302 клавиатура сохраняет ряды, порядок и подписи, отбрасывая пустые и непригодные кнопки', async () => {
  await withKeyboard(async f => {
    await f.mount([
      [], [{ text: 'Короткая', callback_data: 'a' }, { text: 'Длинная подпись', callback_data: 'b' }],
      [{ text: 'Ссылка', url: 'https://example.org/path' }],
      [{ text: 'Запрещено', url: 'javascript:alert(1)' }],
    ]);
    const group = f.host.querySelector('[role="group"][aria-label="Кнопки бота"]'); assert.ok(group);
    assert.deepEqual(Array.from(group.querySelectorAll('.bot-kb-row'), row =>
      Array.from(row.querySelectorAll('.bot-kb-btn'), b => b.textContent)), [['Короткая', 'Длинная подпись'], ['Ссылка']]);
    assert.equal(group.querySelectorAll('button[type="button"]').length, 3);
    assert.equal(group.querySelector('.url')?.getAttribute('title'), 'https://example.org/path');
    assert.equal(group.querySelectorAll('.url .bot-kb-ico svg').length, 1);
    noFeedback(f); assert.equal(f.requests.length, 0);
  });
});

it('R302 пустая и полностью невалидная клавиатура не оставляют пустую группу в DOM', async () => {
  await withKeyboard(async f => {
    for (const kb of [[], [[]], [[{ text: ' ', callback_data: 'a' }]],
      [[{ text: 'Два действия', callback_data: 'a', url: 'https://example.org' }]]]) {
      await f.mount(kb as InlineKeyboard);
      assert.equal(f.host.querySelector('.bot-kb'), null);
    }
    await f.mount(); assert.equal(f.host.querySelectorAll('.bot-kb-btn').length, 2);
  });
});

it('R302 одинаковый flex-контракт кнопок не зависит от длины подписи (страж CSS, не замер layout)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const block = /\.bot-kb-btn\s*\{([^}]+)\}/.exec(css)?.[1]; assert.ok(block);
  assert.match(block, /flex:\s*1\s+1\s+0\s*;/);
  assert.match(block, /min-width:\s*0\s*;/);
});

async function checkPending(raw = source) {
  await withKeyboard(async f => {
    await f.click();
    assert.deepEqual(busy(f), { aria: 'true', loading: true, spin: true });
    assert.deepEqual(busy(f, 1), { aria: null, loading: false, spin: false });
    assert.deepEqual(f.requests[0].args, ['conv', 'mid', 'one', rules.BOT_CALLBACK_CLIENT_WAIT_MS]);
    await f.click();
    assert.equal(f.requests.length, 1, 'R302 повтор ожидающей кнопки не повторяет API');
    await f.click(1);
    assert.equal(f.requests.length, 2, 'R302 другая кнопка не заблокирована ожиданием первой');
    assert.deepEqual(f.requests[1].args, ['conv', 'mid', 'two', rules.BOT_CALLBACK_CLIENT_WAIT_MS]);
    await f.settle(0, {});
    assert.deepEqual(busy(f), { aria: null, loading: false, spin: false });
    assert.equal(busy(f, 1).aria, 'true');
  }, raw);
}
it('R302 ожидающий callback показывает aria-busy и спиннер, гасит повтор, но не другую кнопку', () => checkPending());

async function checkFinally(raw = source) {
  await withKeyboard(async f => {
    await f.click(); await f.settle(0, {});
    assert.equal(busy(f).aria, null, 'R302 finally снимает ожидание после ответа');
    assert.equal(busy(f).loading, false);
    assert.equal(busy(f).spin, false);
    await f.click(); assert.equal(f.requests.length, 2, 'R302 завершённую кнопку можно нажать снова');
  }, raw);
}
it('R302 успешный и молчаливый ответ снимает loading и разрешает следующий callback', () => checkFinally());

it('R302 одинаковые данные в другом сообщении разрешены, а remount старого сообщения сохраняет запрет повтора', async () => {
  await withKeyboard(async f => {
    await f.click();
    await f.mount(keyboard, 'mid', 'remounted');
    assert.equal(busy(f).aria, 'true');
    await f.click(); assert.equal(f.requests.length, 1, 'R302 remount не снимает модульный запрет');
    await f.mount(keyboard, 'other-mid');
    assert.equal(busy(f).aria, null);
    await f.click(); assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].args[1], 'other-mid');
    await f.settle(0, {}); await f.mount(keyboard, 'mid', 'after-answer');
    assert.equal(busy(f).aria, null); await f.click(); assert.equal(f.requests.length, 3);
  });
});

for (const [label, result, expected] of [
  ['alert', { text: '  Важное  ', alert: true }, 'alert'],
  ['text', { text: '  Готово  ' }, 'toast'],
  ['пустое тело', {}, 'none'],
  ['пробелы', { text: ' \n ' }, 'none'],
  ['серверный таймаут с текстом', { timeout: true, text: 'не показывать', alert: true }, 'none'],
] as const) it(`R302 ответ ${label} направляется настоящими правилами в нужный UI и снимает ожидание`, async () => {
  await withKeyboard(async f => {
    await f.click(); await f.settle(0, result);
    assert.deepEqual(f.alerts, expected === 'alert' ? ['Важное'] : []);
    assert.deepEqual(f.toasts, expected === 'toast' ? [['info', 'Готово']] : []);
    assert.equal(f.errors.length, 0);
    assert.deepEqual(busy(f), { aria: null, loading: false, spin: false });
    await f.click(); assert.equal(f.requests.length, 2);
  });
});

for (const [label, error, expected] of [
  ['устаревшая кнопка 409', { status: 409 }, 'stale'],
  ['свой таймаут', { timeout: true, message: 'timeout' }, 'silent'],
  ['сбой сервера 500', { status: 500, message: 'failed' }, 'error'],
] as const) it(`R302 ${label} снимает loading и позволяет повтор, показывая только положенный результат`, async () => {
  await withKeyboard(async f => {
    await f.click(); await f.settle(0, error, true);
    assert.equal(f.alerts.length, 0);
    assert.deepEqual(f.toasts, expected === 'stale' ? [['info', rules.STALE_BUTTON_TEXT]] : []);
    assert.deepEqual(f.errors, expected === 'error' ? [[error, 'Бот не получил нажатие']] : []);
    assert.deepEqual(busy(f), { aria: null, loading: false, spin: false });
    await f.click(); assert.equal(f.requests.length, 2);
  });
});

it('R302 своя url-кнопка открывается сразу через настоящий linkGuard без окна и callback API', async () => {
  await withKeyboard(async f => {
    for (const url of ['https://client.example.test/help', 'https://api.client.example.test/help']) {
      await f.mount([[{ text: 'Помощь', url }]]); await f.click();
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(f.opened.at(-1), url);
    }
    assert.equal(f.opened.length, 2); assert.equal(f.requests.length, 0); noFeedback(f);
  });
});

async function checkForeign(raw = source) {
  await withKeyboard(async f => {
    const url = 'https://example.org/actual-target';
    await f.mount([[{ text: 'client.example.test', url }]]); await f.click();
    assert.equal(f.opened.length, 0, 'R302 чужая подписанная ссылка не открывается до подтверждения');
    const dialog = document.querySelector('[role="dialog"].link-confirm'); assert.ok(dialog);
    assert.equal(dialog.querySelector('h2')?.textContent, 'Открыть ссылку?');
    assert.equal(dialog.querySelector('.lc-url')?.textContent, url);
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
    assert.deepEqual(Array.from(buttons, x => x.textContent), ['Отмена', 'Открыть']);
    await React.act(async () => buttons[0].click());
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(f.opened.length, 0);
    await f.click();
    const open = document.querySelectorAll<HTMLButtonElement>('.link-confirm button')[1]; assert.ok(open);
    await React.act(async () => open.click());
    assert.deepEqual(f.opened, [url]); assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(f.requests.length, 0); noFeedback(f);
  }, raw);
}
it('R302 чужая url-кнопка показывает настоящий LinkConfirmModal: отказ не открывает, согласие открывает точный адрес', () => checkForeign());

async function checkPropagation(raw = source) {
  await withKeyboard(async f => {
    const row = f.host.querySelector('.message-row'); assert.ok(row);
    for (const type of ['click', 'mousedown', 'dblclick', 'touchstart']) {
      const button = f.host.querySelector('.bot-kb-btn'); assert.ok(button);
      await React.act(async () => button.dispatchEvent(new window.Event(type, { bubbles: true })));
      assert.equal(f.rowEvents.length, 0, 'R302 события клавиатуры не доходят до строки');
      // Положительная пара: слушатель строки действительно работает, а не пропущен в harness.
      await React.act(async () => row.dispatchEvent(new window.Event(type, { bubbles: true })));
      assert.deepEqual(f.rowEvents.splice(0), [type]);
    }
  }, raw);
}
it('R302 click, mousedown, dblclick и touchstart кнопок не запускают действия родительской строки', () => checkPropagation());

it('R302 linkBotCommands делает команды кнопками в строках, массивах и вложенных HTML-тегах, сохраняя текст', async () => {
  await withKeyboard(async f => {
    const sent: string[] = [];
    const node = ['Начало /start! ', React.createElement('strong', { key: 'bold' },
      'Жирный ', React.createElement('em', null, '(/status)'))];
    await f.render(f.linkCommands(node, cmd => sent.push(cmd)));
    assert.equal(f.host.textContent, 'Начало /start! Жирный (/status)');
    const commands = f.host.querySelectorAll<HTMLButtonElement>('.bot-cmd');
    assert.deepEqual(Array.from(commands, x => x.textContent), ['/start', '/status']);
    assert.ok(f.host.querySelector('strong > em > .bot-cmd'));
    for (const button of commands) await React.act(async () => button.click());
    assert.deepEqual(sent, ['/start', '/status']); assert.deepEqual(f.rowEvents, []);
  });
});

it('R302 linkBotCommands не меняет исходный узел без обработчика и не превращает пути и URL в команды', async () => {
  await withKeyboard(async f => {
    const nodes = React.createElement('strong', null, '/start');
    assert.equal(f.linkCommands(nodes, undefined), nodes);
    await f.render(f.linkCommands(nodes, undefined));
    assert.equal(f.host.querySelector('.bot-cmd'), null);
    await f.render(f.linkCommands('и/или http://x/y /etc/hosts a/b', () => assert.fail('R302 это не команда')));
    assert.equal(f.host.querySelector('.bot-cmd'), null);
    assert.equal(f.host.textContent, 'и/или http://x/y /etc/hosts a/b');
  });
});

it('R302 linkBotCommands не заходит в pre, code, a, button и пользовательские компоненты', async () => {
  await withKeyboard(async f => {
    function Custom({ children }: { children?: React.ReactNode }) { return React.createElement('span', { className: 'custom' }, children); }
    const nodes = ['pre', 'code', 'a', 'button'].map(tag => React.createElement(tag, { key: tag }, '/start'));
    const custom = React.createElement(Custom, { key: 'custom' }, '/status');
    assert.equal(f.linkCommands(custom, () => {}), custom);
    await f.render(f.linkCommands([...nodes, custom], () => assert.fail('R302 защищённые узлы не команды')));
    assert.equal(f.host.querySelectorAll('.bot-cmd').length, 0);
    assert.equal(f.host.textContent, '/start/start/start/start/status');
    await f.render(f.linkCommands(React.createElement('blockquote', null, '/start'), () => {}));
    assert.equal(f.host.querySelectorAll('blockquote .bot-cmd').length, 1);
  });
});

for (const [label, anchor, replacement, scenario, message, actual, expected] of [
  ['убран запрет повторного callback', 'if (pressing.has(key)) return;', '', checkPending,
    'R302 повтор ожидающей кнопки не повторяет API', 2, 1],
  ['чужая ссылка обходит окно', "if (kbUrlAction(isOwnLink(b.url)) === 'open')", 'if (true)', checkForeign,
    'R302 чужая подписанная ссылка не открывается до подтверждения', 1, 0],
  ['finally не освобождает кнопку', 'pressing.delete(key);', '', checkFinally,
    'R302 finally снимает ожидание после ответа', 'true', null],
  ['события всплывают к строке', '=> e.stopPropagation();', '=> undefined;', checkPropagation,
    'R302 события клавиатуры не доходят до строки', 1, 0],
] as const) it(`R302 контрфакт «${label}» ловится точным AssertionError реального компонента`, async () => {
  await scenario();
  assert.equal(source.split(anchor).length - 1, 1, 'R302 одна точка мутации');
  await assert.rejects(scenario(source.replace(anchor, replacement)), (error: unknown) =>
    error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual' &&
    error.message.split('\n')[0] === message && error.actual === actual && error.expected === expected);
});
