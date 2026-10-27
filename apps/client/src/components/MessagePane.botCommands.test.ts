import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import type { BotCommandInfo, ChannelBotsInfo, InlineKeyboard, Message } from '@gusvoice/shared';
import type { ViteDevServer } from 'vite';
import { setupHarness, type Props } from './MessagePane.behavior.harness';
import { assertion, mutate } from './R297.bot.harness';
import { LEAVE_MS } from '../bubbleMotion';

const h = setupHarness(import.meta.url);
const commands: BotCommandInfo[] = [
  { command: 'status', description: 'Состояние сервера' },
  { command: 'start', description: 'Начать' },
];
const keyboard: InlineKeyboard = [[{ text: 'Обновить', callback_data: 'refresh' }]];
const channelBots: ChannelBotsInfo['bots'] = [
  { id: 'alpha', username: 'AlphaBot', displayName: 'Альфа', avatarUrl: null,
    commands: [{ command: 'status', description: 'Статус Альфы' }] },
  { id: 'beta', username: 'BetaBot', displayName: 'Бета', avatarUrl: null,
    commands: [{ command: 'help', description: 'Справка Беты' }] },
];
let sequence = 0;
type Options = { bot?: boolean; commands?: BotCommandInfo[]; mobile?: boolean; props?: Partial<Props>;
  channel?: boolean; channelBots?: ChannelBotsInfo['bots'] };
type Scene = { props: Partial<Props>; sent: Array<{ content: string; files: File[]; replyToId: string | null }>;
  pressed: Array<{ channel: string; message: string; data: string }> };

async function fixture(options: Options, check: (scene: Scene) => Promise<void>, runtime = h.server) {
  // Вся лента и её новые импорты настоящие. Только ответ IO и приём очередью подставлены;
  // уникальная беседа исключает влияние 60-секундного кэша соседнего сценария.
  const { api } = await runtime.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const { MessagePane } = await runtime.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
  const original = api.convBotInfo, originalChannelBots = api.channelBots, originalCallback = api.channelBotCallback;
  const feedId = `r302-pane-${++sequence}`;
  const channelId = `r303-channel-${sequence}`;
  let dmCommandRequests = 0;
  api.convBotInfo = async id => {
    dmCommandRequests++;
    assert.equal(id, feedId, 'запрос команд адресован текущей беседе');
    return { id: 'test-bot', description: '', about: '', commands: options.commands ?? commands, commandsUpdatedAt: null };
  };
  api.channelBots = async id => {
    assert.equal(id, channelId, 'боты запрашиваются только для текущего канала');
    return { bots: options.channelBots ?? channelBots };
  };
  const pressed: Scene['pressed'] = [];
  api.channelBotCallback = async (channel, message, data) => { pressed.push({ channel, message, data }); return {}; };
  const sent: Scene['sent'] = [];
  const props: Partial<Props> = { botPeer: options.bot ?? !options.channel, feedId, bubbles: !options.channel,
    ...(options.channel ? { botChannelId: channelId } : {}),
    outbox: { items: [], enqueue: item => { sent.push(item); }, retry: () => {}, discard: () => {} }, ...options.props };
  try {
    if (options.mobile) h.mobile(); else h.desktop();
    await h.mount(props, MessagePane);
    await h.flush();
    await check({ props, sent, pressed });
    if (options.channel) assert.equal(dmCommandRequests, 0, 'канальная лента не запрашивает команды личной беседы');
  } finally {
    try { h.unmount(); } finally {
      api.convBotInfo = original; api.channelBots = originalChannelBots;
      api.channelBotCallback = originalCallback; h.desktop();
    }
  }
}
function field() {
  const node = h.host.querySelector<HTMLTextAreaElement>('.composer-input');
  assert.ok(node, 'настоящее поле ленты смонтировано'); return node;
}
async function input(text: string, caret = text.length) {
  const node = field();
  await act(async () => {
    Simulate.change(node, { target: { value: text, selectionStart: caret } as unknown as EventTarget });
  });
  node.setSelectionRange(caret, caret);
  return node;
}
async function key(name: string) {
  // ReactDOM загружен до before/register DOM и выбирает старый input-polyfill.
  // Native keydown после unmount обращался к его уже снятому activeElementInst (null.tag),
  // не к обработчику приложения. Как и Simulate.change выше, доставляем React-событие
  // настоящему смонтированному компоненту, не запускаем браузерный feature-polyfill HappyDOM.
  await act(async () => { Simulate.keyDown(field(), { key: name }); });
}
async function choose() {
  const node = h.host.querySelector<HTMLButtonElement>('.ac-cmd'); assert.ok(node, 'выбор существует');
  // Команда принимается на mousedown, чтобы blur поля не успел закрыть подсказку.
  await act(async () => { node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
}
function botMessage(mine = false, withConversation = true): Message {
  return { ...h.msg('r302-keyboard', mine ? 'me' : 'bot'), content: 'Проверь /status',
    author: { ...h.msg('author').author, id: mine ? 'me' : 'bot', bot: true },
    keyboard, ...(withConversation ? { conversationId: 'r302-message-conversation' } : {}) } as Message;
}
async function keyboardProbe(mode: 'dm' | 'channel' | 'mine' | 'no-conversation', runtime = h.server) {
  await fixture({ props: { bubbles: mode !== 'channel', messages: [botMessage(mode === 'mine', mode !== 'no-conversation')] } }, async () => {
    const row = h.host.querySelector('[data-mid="r302-keyboard"]'); assert.ok(row);
    assert.equal(row.querySelectorAll('.bot-kb').length, mode === 'dm' ? 1 : 0, 'R302-keyboard-location');
    if (mode === 'dm') {
      assert.equal(row.querySelector('.bot-kb-btn')?.textContent, 'Обновить');
      assert.ok(row.querySelector('.bub-stack > .bubble + .bot-kb'), 'клавиатура следует за пузырём в общем стеке');
    }
  }, runtime);
}
for (const [mode, label] of [['dm', 'чужое сообщение ЛС с conversationId показывает клавиатуру'],
  ['channel', 'канал не показывает клавиатуру даже с пришедшими keyboard и conversationId'],
  ['mine', 'своё сообщение не показывает клавиатуру'], ['no-conversation', 'без conversationId клавиатура не появляется']] as const) {
  it(`R302 ${label}`, () => keyboardProbe(mode));
}
it('R302 удалённый пузырь остаётся призраком анимации, но уже без рабочей клавиатуры', async () => {
  const before = h.msg('before', 'peer', 1000, 1), message = botMessage();
  await fixture({ props: { messages: [before, message] } }, async ({ props }) => {
    const row = h.host.querySelector<HTMLElement>('[data-mid="r302-keyboard"]')!;
    const feed = h.host.querySelector<HTMLElement>('.messages')!;
    assert.equal(row.querySelectorAll('.bot-kb').length, 1);
    // HappyDOM не вычисляет layout: задаём только геометрию видимой строки, не результат ветки ghost.
    row.getBoundingClientRect = () => new DOMRect(0, 50, 300, 50);
    feed.getBoundingClientRect = () => new DOMRect(0, 0, 400, 500);
    // Держим только таймер удаления призрака, не Vite/watchdog/flush. Под нагрузкой CI
    // реальные 260 мс иначе могут пройти между commit и проверкой ветки ghost.
    const held = new Set<unknown>();
    const restore: Array<() => void> = [];
    for (const target of [globalThis, window]) {
      const set = target.setTimeout.bind(target), clear = target.clearTimeout.bind(target);
      const oldSet = Object.getOwnPropertyDescriptor(target, 'setTimeout');
      const oldClear = Object.getOwnPropertyDescriptor(target, 'clearTimeout');
      Object.defineProperty(target, 'setTimeout', { configurable: true, writable: true,
        value: (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
          if (ms === LEAVE_MS && typeof fn === 'function') { const id = {}; held.add(id); return id; }
          return set(fn as () => void, ms, ...args);
        } });
      Object.defineProperty(target, 'clearTimeout', { configurable: true, writable: true,
        value: (id: unknown) => { if (!held.delete(id)) clear(id as never); } });
      restore.push(() => {
        if (oldSet) Object.defineProperty(target, 'setTimeout', oldSet); else Reflect.deleteProperty(target, 'setTimeout');
        if (oldClear) Object.defineProperty(target, 'clearTimeout', oldClear); else Reflect.deleteProperty(target, 'clearTimeout');
      });
    }
    try {
      await h.rerender({ ...props, messages: [before] });
      const ghost = h.host.querySelector('.bub-out'); assert.ok(ghost, 'удалённая видимая строка действительно стала призраком');
      assert.ok(held.size > 0, 'настоящая ветка ghost поставила таймер удаления');
      assert.equal(ghost.querySelectorAll('.bot-kb').length, 0);
      assert.equal(ghost.hasAttribute('data-mid'), false);
    } finally {
      try { h.unmount(); } finally { for (const undo of restore.reverse()) undo(); held.clear(); }
    }
  });
});

for (const [bot, nonempty] of [[true, true], [true, false], [false, true], [false, false]] as const) {
  it(`R302 список по /: собеседник-бот=${bot}, команды=${nonempty}`, async () => {
    await fixture({ bot, commands: nonempty ? commands : [] }, async ({ sent }) => {
      await input('/st');
      assert.equal(h.host.querySelectorAll('.ac-cmd').length, bot && nonempty ? 2 : 0);
      if (bot && nonempty) {
        assert.equal(h.host.querySelector('.ac-head')?.textContent, 'Команды бота');
        assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-name')].map(n => n.textContent), ['/status', '/start']);
        assert.equal(h.host.querySelector('.ac-cmd .ac-handle')?.textContent, 'Состояние сервера');
      }
      assert.equal(sent.length, 0);
    });
  });
}
async function acceptanceProbe(action: 'Enter' | 'click' | 'Tab' | 'ArrowRight', argumentsAfter = false, runtime = h.server) {
  await fixture({}, async ({ sent }) => {
    await input(argumentsAfter ? '/st аргумент' : '/st', 3);
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, 2);
    if (action === 'click') await choose(); else await key(action);
    const sends = !argumentsAfter && (action === 'Enter' || action === 'click');
    assert.equal(sent.length, sends ? 1 : 0, 'R302-command-send-count');
    // applyAc всегда добавляет разделитель, а уже набранный пробел аргументов сохраняет.
    assert.equal(field().value, sends ? '' : argumentsAfter ? '/status  аргумент' : '/status ');
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, 0, 'выбор закрывает список');
    if (sends) {
      assert.equal(sent[0].content, '/status');
      assert.deepEqual(sent[0].files, []); assert.equal(sent[0].replyToId, null);
    }
  }, runtime);
}
for (const action of ['Enter', 'click', 'Tab', 'ArrowRight'] as const) {
  it(`R302 ${action}: ${action === 'Enter' || action === 'click' ? 'команда отправляется один раз и поле пустеет' : 'команда только подставляется с пробелом'}`,
    () => acceptanceProbe(action));
}
for (const action of ['Enter', 'click'] as const) {
  it(`R302 ${action} при аргументах после каретки только дополняет команду и сохраняет аргументы`, () => acceptanceProbe(action, true));
}
async function menuProbe(empty: boolean, runtime = h.server) {
  await fixture({ commands: empty ? [] : commands }, async () => {
    assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, empty ? 0 : 1, 'R302-menu-commands');
  }, runtime);
}
it('R302 без команд Меню отсутствует', () => menuProbe(true));
for (const mobile of [false, true]) {
  it(`R302 ${mobile ? 'телефон сохраняет' : 'ПК скрывает'} Меню при обычном тексте, пустое поле и / сохраняют кнопку`, async () => {
    await fixture({ mobile }, async ({ sent }) => {
      assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 1);
      await input('/st'); assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 1);
      await input('обычный текст'); assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, mobile ? 1 : 0);
      assert.equal(sent.length, 0);
    });
  });
  it(`R302 ${mobile ? 'телефон' : 'ПК'} скрывает Меню во время правки`, async () => {
    await fixture({ mobile, props: { messages: [h.msg('edit-me')] } }, async () => {
      assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 1);
      // Настоящее действие строки, не искусственный setter состояния composerEdit.
      const edit = h.host.querySelector<HTMLButtonElement>('[data-mid="edit-me"] button[title="Изменить"]'); assert.ok(edit);
      await act(async () => { edit.click(); });
      assert.ok(h.host.querySelector('.edit-strip'), 'режим правки действительно открыт');
      assert.equal(h.host.querySelectorAll('.att-btn.botcmd').length, 0);
    });
  });
}
it('R302 Меню открывает все команды и /, повторный клик закрывает список без отправки', async () => {
  await fixture({}, async ({ sent }) => {
    const menu = h.host.querySelector<HTMLButtonElement>('.att-btn.botcmd'); assert.ok(menu);
    await act(async () => { menu.click(); });
    assert.equal(field().value, '/'); assert.equal(h.host.querySelectorAll('.ac-cmd').length, 2);
    await act(async () => { menu.click(); });
    assert.equal(field().value, '/'); assert.equal(h.host.querySelectorAll('.ac-cmd').length, 0);
    assert.equal(sent.length, 0);
  });
});
for (const bot of [false, true]) for (const mine of [false, true]) {
  it(`R302 команда в тексте кликабельна только у чужого бота: bot=${bot}, mine=${mine}`, async () => {
    const message = botMessage(mine); message.author = { ...message.author, bot: bot || undefined };
    await fixture({ props: { messages: [message] } }, async ({ sent }) => {
      await input('черновик остаётся');
      const links = h.host.querySelectorAll<HTMLButtonElement>('[data-mid="r302-keyboard"] .bot-cmd');
      assert.equal(links.length, bot && !mine ? 1 : 0);
      if (bot && !mine) {
        await act(async () => { links[0].click(); });
        assert.equal(sent.length, 1); assert.equal(sent[0].content, '/status');
        assert.equal(field().value, 'черновик остаётся', 'команда в сообщении не стирает набранный черновик');
      } else assert.equal(sent.length, 0);
    });
  });
}

async function channelKeyboard(bot: boolean, webhook: boolean, withId: boolean, runtime = h.server) {
  const message = botMessage(false, false);
  message.author = { ...message.author, username: 'AlphaBot', bot: bot || undefined };
  if (webhook) message.webhookId = 'synthetic-webhook';
  await fixture({ channel: true, props: { messages: [message], ...(withId ? {} : { botChannelId: undefined }) } }, async ({ pressed, props }) => {
    const row = h.host.querySelector('[data-mid="r302-keyboard"]'); assert.ok(row);
    const expected = bot && !webhook && withId;
    assert.equal(row.querySelectorAll('.bot-kb').length, expected ? 1 : 0, 'R303-channel-клавиатура-только-у-бота');
    if (expected) {
      const button = row.querySelector<HTMLButtonElement>('.bot-kb-btn'); assert.ok(button);
      await act(async () => { button.click(); });
      assert.deepEqual(pressed, [{ channel: props.botChannelId, message: message.id, data: 'refresh' }]);
    } else assert.deepEqual(pressed, []);
  }, runtime);
}
for (const [bot, webhook, withId] of [[true, false, true], [false, false, true], [true, true, true], [true, false, false]] as const) {
  it(`R303 клавиатура канала: бот=${bot}, вебхук=${webhook}, botChannelId=${withId}`,
    () => channelKeyboard(bot, webhook, withId));
}
it('R303 пустая клавиатура бота в канале не оставляет пустой панели', async () => {
  const message = botMessage(false, false); message.keyboard = [];
  await fixture({ channel: true, props: { messages: [message] } }, async () => {
    assert.equal(h.host.querySelectorAll('.bot-kb').length, 0);
  });
});
it('R303 подсказки канала показывают аватар, ник и описание своего бота без HTTP к ЛС', async () => {
  await fixture({ channel: true }, async () => {
    await input('/');
    assert.equal(h.host.querySelector('.ac-head')?.textContent, 'Команды ботов');
    assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-name')].map(n => n.textContent), ['/status', '/help']);
    assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-bot')].map(n => n.textContent), ['@AlphaBot', '@BetaBot']);
    assert.deepEqual([...h.host.querySelectorAll('.ac-cmd .ac-handle')].map(n => n.textContent), ['Статус Альфы', 'Справка Беты']);
    assert.equal(h.host.querySelectorAll('.ac-cmd .ac-role-ico .avatar-letter').length, 2);
  });
});
const conflictBots: ChannelBotsInfo['bots'] = [channelBots[0], { ...channelBots[1], commands: [{ command: 'status', description: 'Статус Беты' }] }];
async function channelCommandProbe(conflict: boolean, action: 'Enter' | 'Tab' | 'click', runtime = h.server) {
  await fixture({ channel: true, channelBots: conflict ? conflictBots : channelBots }, async ({ sent }) => {
    await input('/st');
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, conflict ? 2 : 1);
    if (action === 'click') await choose(); else await key(action);
    const value = conflict ? '/status@AlphaBot' : '/status';
    assert.equal(action === 'Tab' ? field().value : sent[0]?.content, action === 'Tab' ? `${value} ` : value,
      'R303-channel-команда-имеет-правильного-адресата');
    assert.equal(sent.length, action === 'Tab' ? 0 : 1); assert.equal(h.host.querySelectorAll('.ac-cmd').length, 0);
  }, runtime);
}
for (const conflict of [false, true]) for (const action of ['Enter', 'Tab', 'click'] as const) {
  it(`R303 ${action} в канале: ${conflict ? 'конфликт требует @AlphaBot' : 'единственная команда не требует ника'}`,
    () => channelCommandProbe(conflict, action));
}
it('R303 /st@be в канале фильтрует по нику бота, существующие аргументы не теряются', async () => {
  await fixture({ channel: true, channelBots: conflictBots }, async ({ sent }) => {
    await input('/st@be аргумент', 6);
    assert.equal(h.host.querySelectorAll('.ac-cmd').length, 1);
    assert.equal(h.host.querySelector('.ac-cmd .ac-bot')?.textContent, '@BetaBot');
    await key('Enter');
    assert.equal(field().value, '/status@BetaBot  аргумент'); assert.equal(sent.length, 0);
  });
});
it('R303 команда в тексте канального бота адресуется ему при конфликте и не трогает черновик', async () => {
  const message = botMessage(false, false); message.author = { ...message.author, username: 'AlphaBot' };
  await fixture({ channel: true, channelBots: conflictBots, props: { messages: [message] } }, async ({ sent }) => {
    await input('черновик');
    const link = h.host.querySelector<HTMLButtonElement>('[data-mid="r302-keyboard"] .bot-cmd'); assert.ok(link);
    await act(async () => { link.click(); });
    assert.equal(sent[0]?.content, '/status@AlphaBot'); assert.equal(sent.length, 1); assert.equal(field().value, 'черновик');
  });
});

async function isolated(name: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GUSVOICE_R302_PANE_MUTANT: name }; delete env.NODE_TEST_CONTEXT;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const child = spawn(process.execPath, ['--import', 'tsx', '--test-reporter', 'tap', '--test-name-pattern', `^${escaped}$`, fileURLToPath(import.meta.url)],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-24000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([finished, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error(`R302 watchdog 45 с: ${name}\n${output}`)); }, 45000);
    })]);
    assert.equal(code, 0, output); assert.match(output, /# pass 1(?:\r?\n|$)/);
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}
function mutant(name: string, from: string, to: string, probe: (runtime?: ViteDevServer) => Promise<void>, message: string, actual: number, expected: number) {
  it(name, async () => {
    await probe(); // Оригинал сначала; ошибка импорта или IO не засчитывается как пойманная регрессия.
    if (process.env.GUSVOICE_R302_PANE_MUTANT !== name) return isolated(name);
    const extra = await h.paneServer(source => mutate(source, from, to));
    try { await assert.rejects(() => probe(extra), assertion(message, actual, expected)); }
    finally { await extra.close(); }
  });
}
mutant('R302 контрфакт: клавиатура ошибочно попадает в канал', '<div className="message-main">\n          {quote}',
  '<div className="message-main">{(m as any).keyboard && <MessageKeyboard convId={(m as any).conversationId} messageId={m.id} keyboard={(m as any).keyboard} />}\n          {quote}',
  runtime => keyboardProbe('channel', runtime), 'R302-keyboard-location', 1, 0);
mutant('R302 контрфакт: Tab отправляет вместо подстановки', "item.kind === 'command' && !insert && onlyCommandInField(text)",
  "item.kind === 'command' && onlyCommandInField(text)", runtime => acceptanceProbe('Tab', false, runtime), 'R302-command-send-count', 1, 0);
mutant('R302 контрфакт: Меню появляется без команд', "botCommands?.length && !composerEdit && (isMobile() || !text || text.startsWith('/'))",
  "!composerEdit && (isMobile() || !text || text.startsWith('/'))", runtime => menuProbe(true, runtime), 'R302-menu-commands', 1, 0);
mutant('R303 контрфакт: клавиатура у человека в канале', 'kbChannel && !m.webhookId && m.author.bot && (m as { keyboard?: InlineKeyboard }).keyboard?.length',
  'kbChannel && !m.webhookId && (m as { keyboard?: InlineKeyboard }).keyboard?.length',
  runtime => channelKeyboard(false, false, true, runtime), 'R303-channel-клавиатура-только-у-бота', 1, 0);
