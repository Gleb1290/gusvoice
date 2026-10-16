import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import type { ConvMessage, ConvSearchAllHit, ConvSearchAllResponse, DmChannel, SharedMediaKind } from '@gusvoice/shared';
import * as rules from '../dmListSearchRules';
import * as listRules from '../dmListRules';
import * as rowRules from '../dmRowRules';
import * as mediaRules from '../sharedMediaRules';
import { loadMenu, withMenuDom } from './ContextMenu.back.harness';

const source = readFileSync(new URL('./DmSearchKinds.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const chipsSource = readFileSync(new URL('./DmListSearch.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dm = { id: 'dm', otherUser: { id: 'peer', username: 'peer', displayName: 'Беседа', avatarUrl: null }, createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null } as DmChannel;
type Query = Parameters<typeof import('../api').api.convSearchAll>[0];
function whole<T>(raw: string, deps: Record<string, unknown>): T {
  const parsed = ts.createSourceFile('module.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
    const b = node.importClause?.namedBindings;
    if (b && ts.isNamedImports(b) && b.elements.every(x => x.isTypeOnly)) continue;
    assert.equal(Object.hasOwn(deps, (node.moduleSpecifier as ts.StringLiteral).text), true, `явный импорт ${node.moduleSpecifier.getText(parsed)}`);
  }
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, window, document, Date, IntersectionObserver: undefined,
      require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `неизвестный импорт ${id}`); return deps[id]; } });
  return module.exports as T;
}
function fullHit(id: string, kind: SharedMediaKind = 'media', conversationId = 'dm'): ConvSearchAllHit {
  const content = kind === 'link' ? 'https://example.test/page' : 'совпадение';
  const attachment = { id: `att-${id}`, name: `${id}.bin`, url: `/media/${id}`, size: 12,
    contentType: kind === 'voice' ? 'audio/ogg' : kind === 'file' ? 'application/pdf' : 'image/png',
    ...(kind === 'voice' ? { waveform: [1, 2], durationMs: 1200 } : {}), ...(kind === 'gif' ? { gif: true } : {}) };
  const message = { id, conversationId, sortKey: 1, content, createdAt: '2026-10-12T00:00:00Z',
    author: { id: 'peer', displayName: 'Автор', username: 'peer', avatarUrl: null }, attachments: kind === 'link' ? [] : [attachment] } as ConvMessage;
  return { id, conversationId, sortKey: 1, authorId: 'peer', content, createdAt: message.createdAt, message };
}
interface Scene {
  host: HTMLDivElement; calls: Query[]; delays: number[]; leaves: string[]; jumps: string[];
  render: (props?: Partial<React.ComponentProps<typeof import('./DmSearchKinds').DmKindHits>>) => Promise<void>;
  timers: () => Promise<void>; answer: (index: number, response: ConvSearchAllResponse) => Promise<void>;
  more: () => Promise<void>; chips: (phone: boolean) => Promise<void>;
}
async function scene(check: (s: Scene) => Promise<void>, raw = source, chipsRaw = chipsSource) {
  await withMenuDom(620, async (host, root) => {
    const calls: Query[] = [], delays: number[] = [], leaves: string[] = [], jumps: string[] = [];
    const answers: Array<(value: ConvSearchAllResponse) => void> = [];
    const timers = new Map<number, () => void>(); let timerId = 0;
    const set = window.setTimeout, clear = window.clearTimeout;
    window.setTimeout = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); const id = ++timerId; timers.set(id, fn); return id; }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
    let intersect: (() => void) | undefined;
    class Observer { constructor(callback: IntersectionObserverCallback) { intersect = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); } observe() {} disconnect() { intersect = undefined; } }
    const api = { convSearchAll: (q: Query) => { calls.push(q); return new Promise<ConvSearchAllResponse>(resolve => answers.push(resolve)); },
      attachmentDownloadUrl: (att: { url: string }) => `${att.url}?download` };
    const nameOf = (_id: string, fallback: string) => fallback;
    const common = { react: React, 'react/jsx-runtime': jsx, '../api': { api }, '../dmListSearchRules': rules,
      '../peerName': { usePeerName: () => nameOf, dmPeerLabel: () => 'Беседа' }, '../sharedMediaRules': mediaRules,
      '../toast': { toastError: () => assert.fail('неожиданный отказ API') } };
    try {
      const list = whole<typeof import('./DmListSearch')>(chipsRaw, { ...common, '../dmListRules': listRules, '../dmRowRules': rowRules,
        '../feedJump': { requestFeedJump: () => assert.fail('прямой feedJump не ожидается') },
        '../store': { useStore: () => assert.fail('стор вне контракта chips/HitRow') },
        './Avatar': { Avatar: () => null }, './Icon': { Icon: () => null }, './ContextMenu': loadMenu() });
      const row = (type: string) => (p: { it: mediaRules.SharedItem; source?: string; onLeave: () => void }) => React.createElement('button',
        { 'data-render': type, 'data-hit': p.it.msg.id, 'data-source': p.source, onClick: p.onLeave }, type);
      const shared = { FileRow: row('file'), LinkRow: row('link'), VoiceRow: row('voice'),
        MediaTile: (p: { it: mediaRules.SharedItem; gif: boolean; onOpen: () => void }) => React.createElement('button',
          { 'data-render': p.gif ? 'gif' : 'media', 'data-hit': p.it.msg.id, onClick: p.onOpen }, p.it.msg.id),
        showInChat: (cid: string, id: string, leave: () => void) => { leave(); jumps.push(`${cid}/${id}`); } };
      const deps = { ...common, './DmListSearch': list, './SharedMedia': shared,
        './Lightbox': { Lightbox: (p: { index: number; images: Array<{ url: string }>; actions: (_x: unknown, i: number) => Array<{ run: () => void }> }) => React.createElement('button',
          { 'data-viewer': p.images[p.index].url, onClick: () => p.actions({}, p.index)[0].run() }, 'Показать в чате') } };
      const module = { exports: {} as typeof import('./DmSearchKinds') };
      // Весь модуль; observer — явная сигнализация конца списка, не выдуманный layout HappyDOM.
      runInNewContext(ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
        { module, exports: module.exports, window, document, Date, IntersectionObserver: Observer,
          require: (id: string) => { assert.equal(Object.hasOwn(deps, id), true, `граница kinds ${id}`); return deps[id as keyof typeof deps]; } });
      let props: React.ComponentProps<typeof module.exports.DmKindHits> = { q: '', chips: {}, kind: 'media', dms: [dm], meId: 'me', onLeave: h => leaves.push(h.conversationId) };
      const s: Scene = { host, calls, delays, leaves, jumps,
        render: async patch => { props = { ...props, ...patch }; await React.act(async () => root.render(React.createElement(module.exports.DmKindHits, props))); },
        timers: async () => React.act(async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }),
        answer: async (i, response) => { assert.equal(typeof answers[i], 'function', `ответ запроса ${i}`); await React.act(async () => answers[i](response)); },
        more: async () => { assert.equal(typeof intersect, 'function', 'порция имеет observer'); await React.act(async () => intersect!()); },
        chips: async phone => React.act(async () => root.render(React.createElement(list.DmSearchChips, { q: '', dms: [dm], chips: {}, phone, onChips() {}, onText() {} }))) };
      await check(s);
    } finally { window.setTimeout = set; window.clearTimeout = clear; }
  });
}
async function queryContract(raw = source) {
  await scene(async s => {
    await s.render({ q: '  отчёт  ', kind: 'file', chips: { person: { convId: 'dm', name: 'Человек' }, date: { since: '2026-10-01', until: '2026-10-13', label: 'Октябрь' } } });
    assert.equal(s.calls.length, 0); assert.equal(s.delays[0], rules.MESSAGE_SEARCH_DELAY_MS); await s.timers();
    const q = s.calls[0]; assert.equal(q.q, 'отчёт'); assert.equal(q.kind, 'file'); assert.equal(q.full, true, 'полное сообщение запрошено');
    assert.equal(q.conversationId, 'dm'); assert.equal(q.since, '2026-10-01'); assert.equal(q.until, '2026-10-13'); assert.equal(q.limit, rules.MESSAGE_SEARCH_PAGE);
    await s.answer(0, { hits: [], next: null }); await s.render({ q: '', chips: {}, kind: 'voice' }); await s.timers();
    assert.equal(s.calls[1].q, ''); assert.equal(s.calls[1].kind, 'voice'); assert.equal(s.calls[1].full, true); assert.equal(s.delays.at(-1), 0);
  }, raw);
}
it('R183/185 виды поиска передают kind/full и чипы человека/дат, пустой запрос ищет сразу', async () => {
  // Без full новый сервер выглядел бы старым; без чипов поиск утекал бы за выбранные ограничения.
  await queryContract();
});
it('R183 поздний ответ прежнего запроса не подменяет выдачу новой вкладки', async () => {
  // Класс ошибки: гонка вкладок рисует файл в медиа после уже показанного свежего ответа.
  await scene(async s => { await s.render({ q: 'старое' }); await s.timers(); await s.render({ q: 'новое' }); await s.timers();
    await s.answer(1, { hits: [fullHit('new')], next: null }); await s.answer(0, { hits: [fullHit('old')], next: null });
    assert.equal(s.host.querySelector('[data-hit]')?.getAttribute('data-hit'), 'new'); assert.equal(s.host.querySelectorAll('[data-hit]').length, 1); });
});
for (const kind of ['media', 'file', 'link', 'voice', 'gif'] as const) it(`R183 полное сообщение вида ${kind} использует нужную плитку/строку и корректно открывается`, async () => {
  // Класс ошибки: все full-хиты превращены в legacy-строки или GIF ошибочно открывает фотопросмотрщик.
  await scene(async s => { await s.render({ kind }); await s.timers(); await s.answer(0, { hits: [fullHit(kind, kind)], next: null });
    assert.equal(s.host.querySelectorAll(`[data-render="${kind}"]`).length, 1); assert.equal(s.host.querySelector('.dm-msg-hit') === null, true);
    const button = s.host.querySelector<HTMLButtonElement>(`[data-render="${kind}"]`)!;
    if (kind === 'file' || kind === 'link' || kind === 'voice') assert.equal(button.getAttribute('data-source'), 'Беседа');
    await React.act(async () => button.click());
    if (kind === 'media') { assert.equal(s.host.querySelector('[data-viewer]')?.getAttribute('data-viewer'), '/media/media');
      assert.equal(s.leaves.length, 0); await React.act(async () => s.host.querySelector<HTMLButtonElement>('[data-viewer]')!.click()); }
    assert.equal(s.leaves.join('|'), 'dm'); if (kind === 'media' || kind === 'gif') assert.equal(s.jumps.join('|'), `dm/${kind}`);
    if (kind === 'gif') assert.equal(s.host.querySelector('[data-viewer]') === null, true); });
});
it('R183 старый сервер без message рисует настоящий DmHitRow, неизвестная беседа отбрасывается', async () => {
  // Класс ошибки: требование full ломает совместимость либо возвращает удалённую/чужую беседу.
  await scene(async s => { await s.render({ kind: 'file', q: 'отчёт' }); await s.timers();
    const legacy = fullHit('legacy', 'file'); delete legacy.message;
    const unknown = fullHit('unknown', 'file', 'not-in-dms'); delete unknown.message;
    await s.answer(0, { hits: [legacy, unknown], next: null }); assert.equal(s.host.querySelectorAll('.dm-msg-hit').length, 1);
    assert.equal(s.host.querySelector('.dm-name-text')?.textContent, 'Беседа');
    await React.act(async () => s.host.querySelector<HTMLButtonElement>('.dm-msg-hit')!.click()); assert.equal(s.jumps.join('|'), 'dm/legacy'); });
});
async function emptyItems(raw = source) {
  await scene(async s => { await s.render({ kind: 'media' }); await s.timers();
    await s.answer(0, { hits: [fullHit('not-media', 'file'), fullHit('unknown', 'media', 'unknown')], next: null });
    assert.equal(s.host.querySelectorAll('[data-hit]').length, 0); assert.equal(s.host.textContent?.includes('Ничего не найдено'), true, 'пустые items показывают отсутствие результатов');
    await s.render({ q: 'вторая' }); await s.timers(); await s.answer(1, { hits: [], next: 'cursor' });
    assert.equal(s.host.textContent?.includes('Ничего не найдено'), false, 'пока есть следующая порция пустота не окончательная');
  }, raw);
}
it('R183 пустой результат определяется элементами нужного вида, но next не объявляет окончательную пустоту', async () => {
  // Хиты могут существовать, но не давать ни одного вложения выбранного вида.
  await emptyItems();
});
async function pagination(raw = source) {
  await scene(async s => { await s.render({ kind: 'file' }); await s.timers(); await s.answer(0, { hits: [fullHit('first', 'file')], next: 'cursor' });
    await s.more(); assert.equal(s.calls[1].before, 'cursor'); assert.equal(s.calls[1].full, true); assert.equal(s.calls[1].kind, 'file');
    await s.more(); assert.equal(s.calls.length, 2, 'параллельная догрузка не запускается');
    await s.answer(1, { hits: [fullHit('first', 'file'), fullHit('second', 'file')], next: null });
    assert.equal([...s.host.querySelectorAll('[data-hit]')].map(x => x.getAttribute('data-hit')).join('|'), 'first|second', 'догрузка без дубля id');
  }, raw);
}
it('R183 догрузка передаёт курсор и оставляет каждый id один раз, пока порция pending повтор не идёт', async () => {
  // Класс ошибки: дубль на границе страниц или параллельные запросы одним observer.
  await pagination();
});
async function chipKinds(raw = chipsSource) {
  await scene(async s => { await s.chips(true); assert.equal(s.host.querySelectorAll('[data-kind]').length, 0, 'на телефоне виды скрыты');
    await s.chips(false); assert.equal([...s.host.querySelectorAll('[data-kind]')].map(x => x.getAttribute('data-kind')).join('|'), rules.KIND_CHIPS.join('|')); }, source, raw);
}
it('R185 телефон прячет пять чипов вида, ПК сохраняет все пять', async () => {
  // Типы на телефоне представлены вкладками, а не дублирующими чипами.
  await chipKinds();
});
function replace(raw: string, anchor: string, replacement: string) { assert.equal(raw.split(anchor).length - 1, 1, 'уникальный якорь'); return raw.replace(anchor, replacement); }
const targeted = (message: string) => (error: unknown) => error instanceof assert.AssertionError && error.message.includes(message);
it('R183 контрфакт без full отвергается контрактом запроса', async () => {
  // Уникальный полный запрос отличает первую порцию от loadMore.
  await queryContract(); const mutant = replace(source, 'kind, limit: MESSAGE_SEARCH_PAGE, full: true', 'kind, limit: MESSAGE_SEARCH_PAGE');
  await assert.rejects(queryContract(mutant), targeted('полное сообщение запрошено'));
});
it('R183 контрфакт повторов страниц отвергается по DOM id найденных файлов', async () => {
  // Исполняется целый модуль с изменением только дедупликации ответа.
  await pagination(); await assert.rejects(pagination(replace(source, '...r.hits.filter((h) => !seen.has(h.id))', '...r.hits')), targeted('догрузка без дубля id'));
});
it('R183 контрфакт rows.length вместо items.length скрывает пустую выдачу и обнаруживается', async () => {
  // Неподходящий full-hit нужен, иначе rows/items одновременно пусты и мутант не различается.
  await emptyItems(); await assert.rejects(emptyItems(replace(source, 'legacy ? rows.length === 0 : items.length === 0', 'legacy ? rows.length === 0 : rows.length === 0')), targeted('пустые items'));
});
it('R185 контрфакт игнорирования phone показывает лишние чипы и отвергается', async () => {
  // Парный ПК-сценарий сохраняет разрешённую старую поверхность фильтров.
  await chipKinds(); await assert.rejects(chipKinds(replace(chipsSource, 'chips.kind || phone ? []', 'chips.kind ? []')), targeted('на телефоне виды скрыты'));
});
