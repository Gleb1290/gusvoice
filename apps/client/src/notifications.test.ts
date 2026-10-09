import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type NotifyApi = typeof import('./notifications');
let sandbox: Record<string, unknown>;

function loadNotifications(change?: (source: string) => string, options: { tauri?: boolean; desktop?: boolean } = {}): NotifyApi {
  let source = readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  if (change) {
    const changed = change(source);
    assert.notEqual(changed, source, 'мутант меняет именно проверяемый гейт уведомлений');
    source = changed;
  }
  const module = { exports: {} as Record<string, unknown> };
  const shared = {
    maskNotice: (_view: string, notice: { title: string; body: string }) => notice,
    notifyShowsText: () => true,
    stripFormatting: (text: string) => text,
  };
  const dependencies: Record<string, unknown> = {
    '@gusvoice/shared': shared,
    './coinNotifyRules': {},
    './dmRowRules': { messageAttachmentLabel: () => null },
    './hotkeys': { isDesktop: () => options.desktop === true, isTauri: () => options.tauri === true },
    './notifyRules': {},
  };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  sandbox = {
    module,
    exports: module.exports,
    require: (id: string) => {
      assert.ok(id in dependencies, `неожиданная зависимость ${id}`);
      return dependencies[id];
    },
  };
  runInNewContext(js, sandbox);
  return module.exports as NotifyApi;
}

function fixture(api: NotifyApi, tauri = false) {
  const shown: { title: string; options?: NotificationOptions }[] = [];
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const invocations: { command: string; args?: unknown }[] = [];
  class FakeNotification {
    static permission = 'granted';
    onclick: ((this: Notification, ev: Event) => unknown) | null = null;
    constructor(title: string, options?: NotificationOptions) { shown.push({ title, options }); }
    close() {}
  }
  const storage = new Map<string, string>();
  const window = { Notification: FakeNotification, focus() {} } as Record<string, unknown>;
  if (tauri) window.__TAURI__ = {
    core: { invoke: (command: string, args?: unknown) => { invocations.push({ command, args }); return Promise.resolve(); } },
    event: { listen: async (name: string, handler: (event: { payload: unknown }) => void) => { listeners.set(name, handler); return () => listeners.delete(name); } },
  };
  Object.assign(sandbox, {
    Notification: FakeNotification,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    window,
    navigator: { userAgent: 'Desktop test browser' },
    setTimeout: () => 0,
  });
  return { shown, listeners, invocations };
}

it('R125 тег беседы заменяет прежнее уведомление без повторного звука, тихое сохраняет silent', () => {
  // Повтор чата должен обновить существующую плашку, а не повторно озвучить её через renotify.
  const check = (api: NotifyApi) => {
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(api.webNoticeOptions('текст', false, 'dm-7')), { body: 'текст', tag: 'conv:dm-7' });
    assert.deepEqual(plain(api.webNoticeOptions('тихо', true, 'dm-7')), { body: 'тихо', silent: true, tag: 'conv:dm-7' });
    assert.deepEqual(plain(api.webNoticeOptions('текст', false)), { body: 'текст' });
    assert.deepEqual(plain(api.webNoticeOptions('тихо', true)), { body: 'тихо', silent: true });
    assert.deepEqual(plain(api.webNoticeOptions('текст', false, '')), { body: 'текст' });
  };
  check(loadNotifications());
  for (const mutate of [
    (s: string) => s.replace('`conv:${group}`', '`other:${group}`'),
    (s: string) => s.replace('if (group) o.tag = `conv:${group}`;', 'if (group) { o.tag = `conv:${group}`; if (!silent) o.renotify = true; }'),
    (s: string) => s.replace('if (group) o.tag = `conv:${group}`;', ''),
  ]) assert.throws(() => check(loadNotifications(mutate)), assert.AssertionError);
});

function timedNotices(api: NotifyApi, userAgent: string) {
  fixture(api);
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const shown: { title: string; closes: number; options?: NotificationOptions }[] = [];
  class Notice {
    static permission = 'granted';
    onclick: (() => void) | null = null;
    row: typeof shown[number];
    constructor(title: string, options?: NotificationOptions) {
      this.row = { title, closes: 0, options };
      shown.push(this.row);
    }
    close() { this.row.closes++; }
  }
  Object.assign(sandbox, {
    Notification: Notice,
    window: { Notification: Notice, focus() {} },
    navigator: { userAgent },
    setTimeout: (run: () => void, delay: number) => { timers.push({ at: now + delay, run }); return timers.length; },
  });
  return { shown, timers, advance(ms: number) {
    now += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > now) continue;
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  } };
}

it('R116 браузер ПК закрывает беседу ровно через восемь секунд, а прочтение не закрывает её повторно', () => {
  const check = (api: NotifyApi) => {
    const f = timedNotices(api, 'Mozilla/5.0 Windows NT 10.0');
    assert.equal(api.WEB_NOTICE_AUTOCLOSE_MS, 8000);
    api.osNotify('первая', 'текст', undefined, true, { group: 'A' });
    f.advance(4000);
    api.osNotify('вторая', 'текст', undefined, true, { group: 'A', silent: true });
    api.osNotifyRaw('без беседы', 'текст');
    f.advance(3999);
    assert.deepEqual(f.shown.map(n => n.closes), [0, 0, 0]);
    f.advance(1);
    assert.deepEqual(f.shown.map(n => n.closes), [1, 0, 0]);
    api.clearOsNotifications('чужая');
    api.clearOsNotifications('A');
    assert.deepEqual(f.shown.map(n => n.closes), [1, 1, 0], 'просроченная удалена из индекса, новая ещё закрывается прочтением');
    api.clearOsNotifications('A');
    assert.deepEqual(f.shown.map(n => n.closes), [1, 1, 0]);
    f.advance(4000);
    api.clearOsNotifications('A');
    assert.deepEqual(f.shown.map(n => n.closes), [1, 2, 0], 'оставшийся таймер безопасен; уведомление без беседы не автозакрывается');
  };
  check(loadNotifications());
  for (const mutate of [
    (s: string) => s.replace('WEB_NOTICE_AUTOCLOSE_MS = 8000', 'WEB_NOTICE_AUTOCLOSE_MS = 7999'),
    (s: string) => s.replace('cur.filter((x) => x !== n)', 'cur.filter(() => true)'),
    (s: string) => s.replace('n.close();\n          } catch', '/* закрытие потеряно */\n          } catch'),
  ]) assert.throws(() => check(loadNotifications(mutate)), assert.AssertionError);
});

it('R116 телефонные браузеры сохраняют уведомление до прочтения, без таймера автозакрытия', () => {
  const check = (api: NotifyApi) => {
    for (const ua of ['Mozilla Android 15', 'Mozilla iPhone', 'Mozilla iPad', 'Mozilla iPod']) {
      const f = timedNotices(api, ua);
      api.osNotify('беседа', 'текст', undefined, true, { group: ua });
      assert.equal(f.timers.length, 0, ua);
      f.advance(8001);
      assert.equal(f.shown[0].closes, 0, ua);
      api.clearOsNotifications(ua);
      assert.equal(f.shown[0].closes, 1, 'прочтение закрывает даже без автоматического таймера');
    }
  };
  check(loadNotifications());
  assert.throws(() => check(loadNotifications(s => s.replace('if (!phoneBrowser()) {', 'if (true) {'))), assert.AssertionError);
});

it('выключение всплывашек личных сообщений не глушит отдельный поток уведомлений групп', () => {
  const api = loadNotifications();
  const { shown } = fixture(api);
  api.setNotifyPrefs({ view: 'all', groups: true, dm: false });

  api.osNotify('ЛС', 'личное', undefined, true, { dmChat: true });
  assert.equal(shown.length, 0, 'когда ЛС выключены, ни имя, ни текст личной беседы не всплывают');

  api.osNotify('Группа', 'групповое', undefined, true, { groupChat: true });
  assert.deepEqual(shown.map((notice) => notice.title), ['Группа'], 'выключение ЛС не отключает разрешённые уведомления группы');
});

it('мутант без гейта ЛС действительно показывает запрещённую всплывашку', () => {
  const api = loadNotifications((source) => source.replace('if (opts.dmChat && !notifyPrefs.dm) return;', ''));
  const { shown } = fixture(api);
  api.setNotifyPrefs({ view: 'all', groups: true, dm: false });
  api.osNotify('ЛС', 'личное', undefined, true, { dmChat: true });
  assert.equal(shown.length, 1, 'исполняемый мутант проходит через настоящий osNotify до границы Notification');
});

it('исключение беседы разрешает всплывашку при выключенных личных или групповых уведомлениях', () => {
  // Адресное исключение не должно включать все беседы и не должно обходить выключение OS-уведомлений целиком.
  const check = (api: NotifyApi) => {
    const { shown } = fixture(api);
    const checked: Array<string | undefined> = [];
    api.setNotifyPrefs({ view: 'all', groups: false, dm: false });
    api.setNotifyAlwaysProbe((id) => { checked.push(id); return id === 'enabled-dm' || id === 'enabled-group'; });
    api.osNotify('Личная', 'текст', undefined, true, { dmChat: true, conv: 'disabled-dm' });
    api.osNotify('Личная', 'текст', undefined, true, { dmChat: true, conv: 'enabled-dm' });
    api.osNotify('Группа', 'текст', undefined, true, { groupChat: true, group: 'enabled-group', conv: 'another-id' });
    api.osNotify('Группа', 'текст', undefined, true, { groupChat: true, group: 'disabled-group' });
    assert.deepEqual(shown.map((n) => n.title), ['Личная', 'Группа'], 'адресное исключение разрешает только свои беседы');
    assert.deepEqual(checked, ['disabled-dm', 'enabled-dm', 'enabled-group', 'disabled-group'], 'group важнее conv для пробы');
    api.setOsNotifyLevel('off');
    api.osNotify('Скрыто', 'текст', undefined, true, { dmChat: true, conv: 'enabled-dm' });
    assert.equal(shown.length, 2, 'общий OS off главнее исключения');
    api.setOsNotifyLevel('all'); api.setNotifyAlwaysProbe(() => false);
    api.osNotify('Скрыто', 'текст', undefined, true, { dmChat: true, conv: 'enabled-dm' });
    assert.equal(shown.length, 2, 'снятие исключения возвращает общий запрет');
  };
  check(loadNotifications());
  assert.throws(() => check(loadNotifications((s) => s.replace('if (!notifyAlwaysProbe(opts.group ?? opts.conv)) {', 'if (true) {'))),
    (e: unknown) => e instanceof assert.AssertionError && e.message.includes('адресное исключение разрешает только'));
});

it('нативное уведомление беседы маршрутизирует ответ, прочтение и обычный клик по своим меткам', async () => {
  const check = async (api: NotifyApi, calls: { reply: unknown[]; read: string[]; clicked: number[] }, fixtureState: ReturnType<typeof fixture>) => {
    api.setConvNotifyActions({ reply: (conv, text) => calls.reply.push([conv, text]), read: conv => calls.read.push(conv) });
    const notify = (clicked: () => void) => api.osNotify('Беседа', 'сообщение', clicked, true, { conv: 'conv-7', groupChat: true });
    notify(() => calls.clicked.push(1));
    await Promise.resolve(); await Promise.resolve();
    const command = fixtureState.invocations.find(item => item.command === 'gv_notify_conversation');
    assert.ok(command, 'для беседы выбран нативный тост с быстрыми действиями');
    const tag = (command.args as { tag: string }).tag;
    const action = fixtureState.listeners.get('gv://notify-action'); assert.ok(action, 'подписка на действие создана');
    action({ payload: { tag, group: 'conv-7', action: 'reply', text: '  ответ  ' } });
    assert.deepEqual(calls.reply, [['conv-7', 'ответ']], 'ответ обрезан и направлен ровно в адресованную беседу');

    notify(() => calls.clicked.push(2)); await Promise.resolve(); await Promise.resolve();
    const readTag = (fixtureState.invocations.filter(item => item.command === 'gv_notify_conversation').at(-1)!.args as { tag: string }).tag;
    action({ payload: { tag: readTag, group: 'conv-7', action: 'read' } });
    assert.deepEqual(calls.read, ['conv-7'], 'действие «Прочитано» помечает только эту беседу');

    notify(() => calls.clicked.push(3)); await Promise.resolve(); await Promise.resolve();
    const clickTag = (fixtureState.invocations.filter(item => item.command === 'gv_notify_conversation').at(-1)!.args as { tag: string }).tag;
    action({ payload: { tag: clickTag, group: 'conv-7', action: 'open' } });
    assert.deepEqual(calls.clicked, [3], 'обычное действие уведомления открывает беседу, а не вызывает reply/read');
  };

  const calls = { reply: [] as unknown[], read: [] as string[], clicked: [] as number[] };
  const api = loadNotifications(undefined, { tauri: true, desktop: true });
  const state = fixture(api, true);
  await check(api, calls, state);

  const brokenCalls = { reply: [] as unknown[], read: [] as string[], clicked: [] as number[] };
  const mutant = loadNotifications(source => source.replace("if (p.action === 'reply') {", "if (false) {"), { tauri: true, desktop: true });
  const mutantState = fixture(mutant, true);
  await assert.rejects(() => check(mutant, brokenCalls, mutantState), assert.AssertionError);
});
