import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { createElement } from 'react';
import type { ViteDevServer } from 'vite';
import type { DmChannel, User } from '@gusvoice/shared';
import { emptyConvState } from '../convSyncRules';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url);
const me: User = { id: 'me', username: 'test_user', displayName: 'Участник', email: null, verified: true, avatarUrl: null,
  animatedAvatarUrl: null, animatedAvatarUnlocked: false, superAdmin: false, canCreateServers: false, twoFactorEnabled: false,
  status: 'online', customStatus: null, createdAt: '2026-01-01T00:00:00Z' };
type Options = { bot: boolean; online?: boolean; description?: string };

async function fixture(options: Options, check: (dm: DmChannel) => Promise<void>, runtime = h.server) {
  // Реальные компоненты, хуки, API-клиент и Zustand из одной Vite-сборки. Подменяем только исходные данные и IO.
  const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const { api } = await runtime.ssrLoadModule('/src/api.ts') as typeof import('../api');
  const previous = useStore.getState();
  const previousLastSeen = api.userLastSeen;
  const dm: DmChannel = { id: 'r300-conversation', otherUser: { id: 'r300-peer', username: 'r300_peer', displayName: 'Собеседник',
    avatarUrl: null, ...(options.bot ? { bot: true as const } : {}),
    ...(options.description !== undefined ? { botDescription: options.description } : {}) },
    createdAt: '2026-01-01T00:00:00Z', lastMessageAt: null };
  api.userLastSeen = async userId => ({ userId, online: false, at: null, approx: 'recently', byMe: false, exact: false, canCall: true });
  useStore.setState({ user: me, bootstrap: null, members: [], presence: {}, view: 'dm', convActive: true,
    serverFeatures: ['calls1', 'lastseen1', 'presence4'], dms: [dm], currentDmId: dm.id, mobilePane: 'content',
    dmMessages: { [dm.id]: [] }, historyFailed: [], blockedUsers: [], onlineUsers: options.online ? [dm.otherUser.id] : [],
    dmOnlineUsers: [], dmAwayUsers: [], userStatuses: {}, outbox: {}, drafts: {}, draftRev: {}, places: {},
    pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [],
    conv: { ...emptyConvState(), windows: { [dm.id]: { basePts: 0, hasMoreBefore: false, hasMoreAfter: false } } },
    readDmNow: () => {}, convSeen: () => {}, convSetPlace: () => {}, setDraft: () => {},
    loadOlderDmMessages: async () => false, convLoadNewer: async () => false,
  });
  try { h.desktop(); await check(dm); }
  finally { h.unmount(); api.userLastSeen = previousLastSeen; useStore.setState(previous, true); }
}

async function headerProbe(bot: boolean, runtime = h.server) {
  const { DmChatView } = await runtime.ssrLoadModule('/src/components/DmChatView.tsx') as typeof import('./DmChatView');
  await fixture({ bot, online: true }, async dm => {
    await h.mount({}, () => createElement(DmChatView, { dm }));
    assert.equal(h.host.querySelector('.dm-who-status')?.textContent, bot ? 'бот' : 'в сети');
    assert.equal(h.host.querySelectorAll('.dm-who .bot-tag').length, bot ? 1 : 0);
    assert.equal(h.host.querySelectorAll('.dm-ava .mp-dot-wrap').length, bot ? 0 : 1, 'R300-header-online-dot');
    assert.equal(h.host.querySelectorAll('button[aria-label="Позвонить"]').length, bot ? 0 : 1, 'R300-header-call');
    if (!bot) assert.equal(h.host.querySelector<HTMLButtonElement>('button[aria-label="Позвонить"]')?.disabled, false);
  }, runtime);
}
it('R300 шапка бота пишет «бот» и не показывает точку или звонок даже при online-событии', () => headerProbe(true));
it('R300 шапка человека сохраняет «в сети», точку и доступный звонок при тех же признаках сервера', () => headerProbe(false));

async function profileProbe(bot: boolean) {
  const { UserContextMenu } = await h.server.ssrLoadModule('/src/components/UserContextMenu.tsx') as typeof import('./UserContextMenu');
  await fixture({ bot }, async dm => {
    await h.mount({}, () => createElement(UserContextMenu, {
      target: { userId: dm.otherUser.id, name: dm.otherUser.displayName, username: dm.otherUser.username, convId: dm.id, bot },
      pos: { x: 20, y: 20 }, initialView: 'profile', onClose: () => {},
    }));
    // useLastSeen действительно получает ответ IO: у человека положительная пара доказывает, что строка не исчезла из-за пустого стаба.
    await h.flush();
    const card = document.querySelector('.pcard'); assert.ok(card, 'открылась настоящая карточка профиля в портале ContextMenu');
    assert.equal(card.querySelectorAll('.bot-tag').length, bot ? 1 : 0);
    assert.equal(card.querySelectorAll('.pcard-seen').length, bot ? 0 : 1);
    assert.equal(card.querySelectorAll('button[aria-label="Позвонить"]').length, bot ? 0 : 1);
    if (bot) assert.equal(card.textContent?.includes('был(а)'), false);
    else assert.equal(card.querySelector('.pcard-seen')?.textContent, 'был(а) недавно');
  });
}
it('R300 профиль бота не показывает «был(а)» и звонок при доступном ответе last-seen', () => profileProbe(true));
it('R300 профиль человека сохраняет «был(а) недавно» и звонок при том же ответе last-seen', () => profileProbe(false));

for (const description of [undefined, '', 'Показываю погоду.\nОтвечаю на /help.']) {
  it(`R300 пустая беседа бота: ${description ? 'описание показано под «Что умеет этот бот?»' : description === '' ? 'пустое описание не создаёт блок' : 'старый сервер без описания не создаёт блок'}`, async () => {
    const { DmChatView } = await h.server.ssrLoadModule('/src/components/DmChatView.tsx') as typeof import('./DmChatView');
    await fixture({ bot: true, description }, async dm => {
      await h.mount({}, () => createElement(DmChatView, { dm }));
      assert.equal(h.host.querySelectorAll('.bot-start-empty').length, 1);
      assert.equal(h.host.querySelectorAll('.bot-start-desc').length, description ? 1 : 0);
      assert.equal(h.host.querySelectorAll('.bot-start-what').length, description ? 1 : 0);
      if (description) {
        assert.equal(h.host.querySelector('.bot-start-what')?.textContent, 'Что умеет этот бот?');
        assert.equal(h.host.querySelector('.bot-start-desc')?.textContent, `Что умеет этот бот?${description}`);
      }
      assert.equal(h.host.querySelector('.bot-start')?.textContent?.trim(), 'Старт');
    });
  });
}

async function embedProbe(mode: 'text' | 'fallback' | 'plain', runtime = h.server) {
  const { MessagePane } = await runtime.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
  const message = h.msg('r300-embed', 'r300-peer');
  message.author = { ...message.author, bot: true };
  message.content = mode === 'fallback' ? 'Текст для старого клиента' : 'Текст сообщения';
  message.createdAt = '2026-10-26T10:15:00.000Z';
  if (mode !== 'plain') message.embeds = [{ title: 'Карточка бота', description: 'Содержимое карточки' }];
  if (mode === 'fallback') message.embedsFallback = true;
  try {
    await h.mount({ messages: [message], bubbles: true }, MessagePane);
    const row = h.host.querySelector('[data-mid="r300-embed"]'); assert.ok(row);
    assert.equal(row.querySelectorAll('.embed').length, mode === 'plain' ? 0 : 1, 'R300-dm-embed');
    assert.equal(row.querySelectorAll('.message-body').length, mode === 'fallback' ? 0 : 1);
    assert.equal(row.textContent?.includes(message.content), mode !== 'fallback');
    const meta = row.querySelector('.bub-meta'); assert.ok(meta, 'время осталось в настоящем пузыре');
    assert.equal(meta.textContent, new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt)));
    if (mode !== 'plain') {
      const embed = row.querySelector('.embed')!;
      assert.equal(embed.querySelector('.embed-title')?.textContent, 'Карточка бота');
      assert.equal(embed.querySelector('.embed-desc')?.textContent, 'Содержимое карточки');
      assert.equal(row.querySelectorAll('.bub-meta-row .bub-meta').length, 1);
      // Порядок DOM, не имитация layout: HappyDOM не доказывает пиксельное положение/CSS.
      assert.equal(!!(embed.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING), true);
      if (mode === 'text') assert.equal(!!(row.querySelector('.message-body')!.compareDocumentPosition(embed) & Node.DOCUMENT_POSITION_FOLLOWING), true);
    }
  } finally { h.unmount(); }
}
it('R300 пузырь ЛС показывает карточку бота после обычного текста, время — после карточки', () => embedProbe('text'));
it('R300 embedsFallback скрывает запасной текст, но сохраняет карточку и время в пузыре ЛС', () => embedProbe('fallback'));
it('R300 обычный пузырь без embeds сохраняет текст и время и не создаёт пустую карточку', () => embedProbe('plain'));

async function isolated(name: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GUSVOICE_R300_UI_MUTANT: name }; delete env.NODE_TEST_CONTEXT;
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
      timer = setTimeout(() => { child.kill(); reject(new Error(`R300 watchdog 45 с: ${name}\n${output}`)); }, 45000);
    })]);
    assert.equal(code, 0, `R300 дочерний сценарий завершился: ${output}`);
    assert.match(output, /# pass 1(?:\r?\n|$)/);
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}

function mutant(name: string, target: string, from: string, to: string, probe: (runtime?: ViteDevServer) => Promise<void>, message: string, actual: number, expected: number) {
  it(name, async () => {
    await probe(); // Оригинал проходит первым; ошибки импорта/стенда не считаются убийством мутанта.
    if (process.env.GUSVOICE_R300_UI_MUTANT !== name) return isolated(name);
    const extra = await h.paneServer(source => {
      assert.equal(source.split(from).length - 1, 1, 'единственный точный якорь UI-мутанта');
      return source.replace(from, to);
    }, target);
    try {
      await assert.rejects(() => probe(extra), (error: unknown) => error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
        && error.message.split(/\r?\n/)[0] === message && error.operator === 'strictEqual' && error.actual === actual && error.expected === expected);
    } finally { await extra.close(); }
  });
}
mutant('R300 контрфакт: шапка разрешает звонок боту', 'DmChatView', '            !peerBot && (', '            true && (',
  runtime => headerProbe(true, runtime), 'R300-header-call', 1, 0);
mutant('R300 контрфакт: шапка рисует online-точку боту', 'DmChatView', 'const peerOnline = online && !conn && !peerBot;', 'const peerOnline = online && !conn;',
  runtime => headerProbe(true, runtime), 'R300-header-online-dot', 1, 0);
mutant('R300 контрфакт: пузырь ЛС теряет embedCards', 'MessagePane', 'const embedCards = m.embeds?.length ? (', 'const embedCards = false ? (',
  runtime => embedProbe('text', runtime), 'R300-dm-embed', 0, 1);
