import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { act, createElement } from 'react';
import type { ViteDevServer } from 'vite';
import type { DmChannel, User } from '@gusvoice/shared';
import { botUnavailablePlateText, emptyConvState } from '../convSyncRules';
import { newOutboxItem } from '../outboxRules';
import { setupHarness } from './MessagePane.behavior.harness';
import { assertion, mutate } from './R297.bot.harness';

const h = setupHarness(import.meta.url);
type Options = { kind?: 'human' | 'group' | 'saved' | 'messages' | 'draft' | 'queue' | 'feederror'; loading?: boolean; draft?: string; unavailable?: 'private' | 'disabled' };
type Scene = { host: HTMLDivElement; sent: { id: string; item: { content: string; key: string; files: File[]; replyToId: string | null } }[] };
const me: User = { id: 'me', username: 'test_user', displayName: 'Участник 1', email: null, verified: true, avatarUrl: null,
  animatedAvatarUrl: null, animatedAvatarUnlocked: false, superAdmin: false, canCreateServers: false, twoFactorEnabled: false,
  status: 'online', customStatus: null, createdAt: '2026-01-01T00:00:00Z' };

async function fixture(options: Options, check: (f: Scene) => Promise<void>, runtime: ViteDevServer = h.server) {
  // Настоящие DmChatView, MessagePane, хуки и Zustand из одной Vite-сборки. Подмена только исходных данных и IO:
  // очередь намеренно не обновляется после клика — поле обязано открыться от setBotStartedIn ДО ответа/синхронизации.
  const { DmChatView } = await runtime.ssrLoadModule('/src/components/DmChatView.tsx') as typeof import('./DmChatView');
  const { useStore } = await runtime.ssrLoadModule('/src/store.ts') as typeof import('../store');
  const previous = useStore.getState();
  const sent: Scene['sent'] = [];
  const dm: DmChannel = { id: 'r297-bot-conversation', otherUser: { id: 'test-bot', username: 'test_bot', displayName: 'Бот 1', avatarUrl: null,
    ...(options.kind === 'human' ? {} : { bot: true as const }), ...(options.unavailable ? { botUnavailable: options.unavailable } : {}) }, createdAt: '2026-01-01T00:00:00Z', lastMessageAt: null,
    ...(options.kind === 'saved' ? { saved: true } : {}),
    ...(options.kind === 'group' ? { group: { title: 'Группа 1', avatarUrl: null, ownerId: 'me', members: [], limit: 20 } } : {}),
  };
  const draft = options.draft ?? (options.kind === 'draft' ? 'неотправленный текст' : undefined);
  useStore.setState({ user: me, convActive: true, serverFeatures: [], dms: [dm], currentDmId: dm.id, mobilePane: 'content',
    dmMessages: options.loading ? {} : { [dm.id]: options.kind === 'messages' ? [h.msg('previous-message', 'test-bot')] : [] },
    historyFailed: options.kind === 'feederror' ? [dm.id] : [], blockedUsers: [], onlineUsers: [], dmOnlineUsers: [], dmAwayUsers: [],
    outbox: options.kind === 'queue' ? { [dm.id]: [newOutboxItem(dm.id, { key: 'test-queued', content: 'в очереди', files: [], replyToId: null }, h.now)] } : {},
    drafts: draft !== undefined ? { [dm.id]: { text: draft, replyToId: null } } : {}, draftRev: {}, places: {},
    pushMutedDmUsers: [], pushMuteUntil: {}, pushAlwaysTargets: [],
    conv: { ...emptyConvState(), windows: { [dm.id]: { basePts: 0, hasMoreBefore: false, hasMoreAfter: false } } },
    readDmNow: () => {}, convSeen: () => {}, convSetPlace: () => {}, setDraft: () => {},
    loadOlderDmMessages: async () => false, convLoadNewer: async () => false,
    outboxEnqueue: (id, item) => { sent.push({ id, item }); },
  });
  try {
    h.desktop();
    await h.mount({}, () => createElement(DmChatView, { dm }));
    await check({ host: h.host, sent });
  } finally {
    h.unmount();
    useStore.setState(previous, true);
  }
}
async function gateProbe(runtime = h.server) {
  await fixture({}, async f => {
    assert.equal(f.host.querySelectorAll('form.composer').length, 0, 'R297-bot-gate');
    assert.equal(f.host.querySelectorAll('.bot-start').length, 1);
    assert.equal(f.host.querySelector('.bot-start')?.textContent?.trim(), 'Старт');
    assert.equal(f.sent.length, 0);
  }, runtime);
}
it('R297 пустая беседа с ботом показывает Старт вместо настоящего form.composer', () => gateProbe());
it('R297 пока история бота грузится, composer не мелькает до определения пустой беседы', async () => {
  await fixture({ loading: true }, async f => { assert.equal(f.host.querySelectorAll('form.composer').length, 0);
    assert.equal(f.host.querySelectorAll('.bot-start').length, 0); assert.equal(f.sent.length, 0); });
});
async function startProbe(runtime = h.server) {
  await fixture({}, async f => {
    assert.equal(f.host.querySelectorAll('form.composer').length, 0);
    const start = f.host.querySelector<HTMLButtonElement>('.bot-start'); assert.equal(!!start, true);
    await act(async () => { start!.click(); });
    // Нет вставленного ответа и нет записи очереди: локальное действие само сразу открывает ввод.
    assert.equal(f.host.querySelectorAll('form.composer').length, 1, 'R297-bot-start-immediate');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].id, 'r297-bot-conversation');
    assert.equal(f.sent[0].item.content, '/start', 'R297-bot-start-command');
    assert.deepEqual(f.sent[0].item.files, []); assert.equal(f.sent[0].item.replyToId, null);
    assert.equal(typeof f.sent[0].item.key, 'string'); assert.equal(f.sent[0].item.key.length > 0, true);
  }, runtime);
}
it('R297 Старт отправляет ровно одну команду /start и немедленно открывает поле без ответа сервера', () => startProbe());
for (const kind of ['human', 'group', 'saved', 'messages', 'draft', 'queue', 'feederror'] as const) {
  it(`R297 ${kind}: бот-гейт не перекрывает настоящее поле ввода`, async () => {
    await fixture({ kind }, async f => {
      assert.equal(f.host.querySelectorAll('form.composer').length, 1, `R297-bot-exception-${kind}`);
      assert.equal(f.host.querySelectorAll('textarea.composer-input').length, 1); assert.equal(f.sent.length, 0);
      if (kind === 'draft') assert.equal(f.host.querySelector<HTMLTextAreaElement>('textarea.composer-input')?.value, 'неотправленный текст');
      if (kind === 'human' || kind === 'group' || kind === 'saved' || kind === 'messages' || kind === 'feederror')
        assert.equal(f.host.querySelectorAll('.bot-start').length, 0);
    });
  });
}
it('R297 пустой черновик не начинает бота, но один пробел уже сохраняет доступ к своему вводу', async () => {
  await fixture({ draft: '' }, async f => { assert.equal(f.host.querySelectorAll('form.composer').length, 0); });
  await fixture({ draft: ' ' }, async f => { assert.equal(f.host.querySelectorAll('form.composer').length, 1); });
});

it('R303 причины недоступности бота имеют разные русские плашки, будущая причина безопасно означает выключенного бота', () => {
  assert.equal(botUnavailablePlateText('private', 'Погодный бот'), 'Погодный бот — приватный бот: писать ему может только его владелец.');
  assert.equal(botUnavailablePlateText('disabled', 'Погодный бот'), 'Погодный бот сейчас недоступен: бот выключен.');
  assert.equal(botUnavailablePlateText('future-reason', 'Погодный бот'), 'Погодный бот сейчас недоступен: бот выключен.');
});
async function unavailableProbe(runtime = h.server) {
  for (const unavailable of ['private', 'disabled'] as const) for (const kind of [undefined, 'messages', 'draft', 'queue'] as const) {
    await fixture({ unavailable, kind }, async f => {
      assert.equal(f.host.querySelectorAll('form.composer').length, 0, 'R303 недоступный бот не получает поле ввода');
      assert.equal(f.host.querySelectorAll('.bot-start').length, 0, 'R303 недоступному боту нельзя нажать Старт');
      assert.equal(f.host.querySelector('.composer-blocked')?.textContent?.trim(), botUnavailablePlateText(unavailable, 'Бот 1'));
      assert.equal(f.sent.length, 0);
    }, runtime);
  }
}
it('R303 недоступный бот получает плашку вместо поля и без Старт даже с историей, черновиком и очередью', () => unavailableProbe());

async function tagProbe(authorBot: boolean, webhook: boolean, runtime = h.server) {
  const { MessagePane } = await runtime.ssrLoadModule('/src/components/MessagePane.tsx') as typeof import('./MessagePane');
  const message = h.msg('r297-author', 'test-author');
  if (authorBot) message.author = { ...message.author, bot: true };
  if (webhook) message.webhookId = 'test-webhook';
  try {
    // Значок автора расположен в серверной ленте (не в шапке бота/пустом состоянии ЛС).
    await h.mount({ messages: [message], bubbles: false }, MessagePane);
    assert.equal(h.host.querySelectorAll('[data-mid="r297-author"] .message-head').length, 1);
    assert.equal(h.host.querySelectorAll('[data-mid="r297-author"] .bot-tag').length, authorBot && !webhook ? 1 : 0, 'R297-bot-author-tag');
    assert.equal(h.host.querySelectorAll('[data-mid="r297-author"] .msg-webhook-tag').length, webhook ? 1 : 0);
  } finally { h.unmount(); }
}
for (const authorBot of [false, true]) for (const webhook of [false, true]) {
  it(`R297 значок автора: bot=${authorBot}, webhook=${webhook}`, () => tagProbe(authorBot, webhook));
}

// Тяжёлые целые компоненты-мутанты живут в отдельном процессе с внешним watchdog, как в старом pane-харнессе.
// Отличие этого локального запуска: windowsHide и адресная проверка ERR_ASSERTION/code/оператора/значений.
async function isolated(name: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GUSVOICE_R297_DM_MUTANT: name }; delete env.NODE_TEST_CONTEXT;
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
      timer = setTimeout(() => { child.kill(); reject(new Error(`R297 watchdog 45 с: ${name}\n${output}`)); }, 45000);
    })]);
    assert.equal(code, 0, `R297 дочерний сценарий завершился: ${output}`);
    assert.match(output, /# pass 1(?:\r?\n|$)/);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
type Probe = (runtime?: ViteDevServer) => Promise<void>;
function mutant(name: string, target: string, from: string, to: string, probe: Probe, message: string, actual: unknown, expected: unknown) {
  it(name, async () => {
    await probe(); // Оригинал обязан пройти до любой попытки засчитать мутант.
    if (process.env.GUSVOICE_R297_DM_MUTANT !== name) return isolated(name);
    const extra = await h.paneServer(source => mutate(source, from, to), target);
    try { await assert.rejects(() => probe(extra), assertion(message, actual, expected)); }
    finally { await extra.close(); }
  });
}
mutant('R297 контрфакт: бот-гейт снят', 'DmChatView', 'peerBot && !failed && messages.length === 0', 'false && !failed && messages.length === 0',
  gateProbe, 'R297-bot-gate', 1, 0);
mutant('R303 контрфакт: плашка недоступного бота снята', 'DmChatView', ') : botUnavailable ? (', ') : false ? (',
  unavailableProbe, 'R303 недоступный бот не получает поле ввода', 1, 0);
mutant('R297 контрфакт: Старт ждёт обновления очереди вместо немедленного ввода', 'DmChatView', 'setBotStartedIn(dm.id);', '',
  startProbe, 'R297-bot-start-immediate', 0, 1);
mutant('R297 контрфакт: Старт посылает другую команду', 'DmChatView', "content: '/start', files: []", "content: '/begin', files: []",
  startProbe, 'R297-bot-start-command', '/begin', '/start');
mutant('R297 контрфакт: вебхук ошибочно получает значок бота', 'MessagePane', 'm.author.bot && !m.webhookId && (', 'm.author.bot && (',
  runtime => tagProbe(true, true, runtime), 'R297-bot-author-tag', 1, 0);
mutant('R297 контрфакт: обычный автор ошибочно получает значок бота', 'MessagePane', 'm.author.bot && !m.webhookId && (', '!m.webhookId && (',
  runtime => tagProbe(false, false, runtime), 'R297-bot-author-tag', 1, 0);
