import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DmChannel } from '@gusvoice/shared';
import * as rules from './dmListSearchRules';
import * as row from './dmRowRules';
import * as shared from '@gusvoice/shared';
import * as media from './sharedMediaRules';
function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./dmListSearchRules.ts', import.meta.url), 'utf8');
  assert.equal(source.split(from).length - 1, 1, 'уникальный якорь правил');
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => {
      const deps: Record<string, unknown> = { './dmRowRules': row, '@gusvoice/shared': shared, './sharedMediaRules': media };
      assert.ok(Object.hasOwn(deps, id), `неописанная зависимость правил ${id}`); return deps[id];
    } });
  return module.exports as typeof rules;
}
const dm = (id: string, displayName = id, extra: Partial<DmChannel> = {}): DmChannel => ({
  id, createdAt: '2026-01-01T00:00:00Z', otherUser: { id, displayName, username: id }, ...extra,
} as DmChannel);

it('недавний повтор поднимается без учёта регистра, лимит 12 и минимум два знака', () => {
  // Ловит разрастание истории и потерю наиболее свежего запроса.
  const list: rules.RecentSearch[] = [{ kind: 'query', text: 'Goose' }, { kind: 'person', convId: 'a' }];
  assert.deepEqual(rules.pushRecent(list, { kind: 'query', text: ' GOOSE ' }), [{ kind: 'query', text: 'GOOSE' }, list[1]]);
  for (const text of ['', ' ', ' а ']) assert.deepEqual(rules.pushRecent(list, { kind: 'query', text }), list);
  const full = Array.from({ length: 12 }, (_, i): rules.RecentSearch => ({ kind: 'person', convId: String(i) }));
  const next = rules.pushRecent(full, { kind: 'person', convId: 'new' });
  assert.equal(next.length, 12); assert.deepEqual(next[0], { kind: 'person', convId: 'new' });
  assert.deepEqual(next[11], full[10]);
  assert.deepEqual(rules.removeRecent(list, { kind: 'query', text: 'GOOSE' }), [list[1]]);
});

it('мусор кеша отбрасывается, допустимые записи теряют посторонние поля', () => {
  // Ловит падение поиска при повреждённом localStorage и протаскивание произвольного объекта.
  for (const raw of [undefined, null, '', '{', '7', '{}', 'null']) assert.deepEqual(rules.parseRecent(raw), []);
  assert.deepEqual(rules.parseRecent(JSON.stringify([null, 1, { kind: 'alien' }, { kind: 'query', text: '' },
    { kind: 'person', convId: 'a', secret: 1 }, { kind: 'query', text: 'гусь', secret: 2 }])),
    [{ kind: 'person', convId: 'a' }, { kind: 'query', text: 'гусь' }]);
  assert.equal(rules.parseRecent(JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ kind: 'person', convId: String(i) })))).length, 12);
});

it('сегодня и вчера задают местные полуоткрытые сутки, в том числе через Новый год', () => {
  // Ловит UTC вместо календарного дня и перенос вчера на неверный год.
  const now = new Date(2026, 0, 1, 12);
  assert.deepEqual(rules.parseDateQuery(' сегодня ', now), { label: 'Сегодня', since: new Date(2026, 0, 1).toISOString(), until: new Date(2026, 0, 2).toISOString() });
  assert.deepEqual(rules.parseDateQuery('ВЧЕРА', now), { label: 'Вчера', since: new Date(2025, 11, 31).toISOString(), until: new Date(2026, 0, 1).toISOString() });
});

it('названный будущий день уходит в прошлый год, месяцы и короткий год различаются', () => {
  // Ловит поиск в будущем и смешение марта с маем.
  const now = new Date(2026, 1, 10, 12);
  const check = (api: typeof rules) => assert.equal(api.parseDateQuery('5 марта', now)?.since, new Date(2025, 2, 5).toISOString());
  check(rules);
  assert.throws(() => check(mutant('yy -= 1', 'yy += 1')), assert.AssertionError);
  for (const word of ['май', 'мая']) assert.equal(rules.parseDateQuery(word, now)?.since, new Date(2025, 4, 1).toISOString());
  assert.equal(rules.parseDateQuery('март', now)?.until, new Date(2025, 3, 1).toISOString());
  assert.equal(rules.parseDateQuery('2025', now)?.until, new Date(2026, 0, 1).toISOString());
  assert.equal(rules.parseDateQuery('05.03.25', now)?.since, new Date(2025, 2, 5).toISOString());
  for (const text of ['31.02', '0.01', '01.13', '29.02.2025', '2027', '1999', 'мусор', '']) assert.equal(rules.parseDateQuery(text, now), null);
  assert.equal(rules.parseDateQuery('29.02.2024', now)?.until, new Date(2024, 2, 1).toISOString());
});

it('поиск требует двух знаков без чипа, чип допускает пустой и однобуквенный запрос', () => {
  // Ловит отсутствие запроса для поиска за день без текста.
  for (const q of ['', ' ', 'а']) assert.equal(rules.messageQuery(q, {}), null);
  assert.deepEqual(rules.messageQuery(' аб ', {}), { text: 'аб' });
  for (const q of ['', 'а']) assert.deepEqual(rules.messageQuery(q, { person: { convId: 'a', name: 'А' } }), { text: q });
  assert.deepEqual(rules.messageQuery('', { date: { label: 'день', since: 's', until: 'u' } }), { text: '' });
});

it('вкладки областей поиска появляются только с серверной возможностью и свободным запросом', () => {
  // Ловит выдачу пустой серверной вкладки старому серверу и потерю фильтров-чипов на неподходящем экране.
  const check = (api: typeof rules) => {
    const view = (scope: Parameters<typeof rules.scopeView>[0], q: string, chips: Parameters<typeof rules.scopeView>[2], on: boolean) =>
      JSON.parse(JSON.stringify(api.scopeView(scope, q, chips, on)));
    assert.deepEqual(view('all', 'кот', {}, true), { tabs: true, dm: true, servers: true, serversFull: false });
    assert.deepEqual(view('servers', 'кот', {}, true), { tabs: true, dm: false, servers: true, serversFull: true });
    assert.deepEqual(view('dm', 'кот', {}, true), { tabs: true, dm: true, servers: false, serversFull: false });
    assert.deepEqual(view('servers', 'кот', {}, false), { tabs: false, dm: true, servers: false, serversFull: false });
    assert.deepEqual(view('servers', 'кот', { kind: 'media' }, true), { tabs: false, dm: true, servers: false, serversFull: false });
    assert.deepEqual(view('all', 'а', {}, true), { tabs: false, dm: true, servers: false, serversFull: false });
  };
  check(rules);
  check(mutant("serversFull: scope === 'servers'", "serversFull: scope === 'servers'"));
  for (const [from, to] of [
    ['serversOn && !hasChips(chips)', '!hasChips(chips)'],
    ['!hasChips(chips)', 'true'],
    ["dm: scope !== 'servers'", 'dm: true'],
    ["servers: scope !== 'dm'", 'servers: true'],
    ["serversFull: scope === 'servers'", 'serversFull: true'],
  ] as const) {
    assert.throws(() => check(mutant(from, to)), assert.AssertionError,
      `мутант ${from} нарушает feature/chip/область/полную выдачу`);
  }
});

it('люди сортируются по свежести, включая архив, но исключая удалённых; подсказки понимают имя и логин', () => {
  // Частые люди сохраняются при архивировании; tombstone нельзя показывать как собеседника.
  const xs = [dm('old', 'Старый'), dm('new', 'Новый', { lastMessageAt: '2026-02-01T00:00:00Z' }), dm('archive', 'Архив', { archived: true }), dm('gone:a', 'Удалённый')];
  const check = (api: typeof rules) => assert.equal(api.peopleStrip(xs).map((x) => x.id).join(','), 'new,old,archive');
  check(rules);
  const archiveSource = ".filter((d) => !d.otherUser.id.startsWith('gone:'))";
  check(mutant(archiveSource, archiveSource));
  assert.throws(() => check(mutant(".filter((d) => !d.otherUser.id.startsWith('gone:'))", ".filter((d) => !d.archived && !d.otherUser.id.startsWith('gone:'))")), assert.AssertionError,
    'мутант снова скрывает архивные частые беседы');
  assert.throws(() => check(mutant(".filter((d) => !d.otherUser.id.startsWith('gone:'))", '.filter(() => true)')), assert.AssertionError,
    'мутант показывает удалённую запись как живого человека');
  assert.deepEqual(rules.peopleStrip(xs, 1).map((x) => x.id), ['new']);
  assert.deepEqual(rules.personSuggestions(xs, 'Ста'), [{ convId: 'old', name: 'Старый' }]);
  assert.deepEqual(rules.personSuggestions(xs, 'new'), [{ convId: 'new', name: 'Новый' }]);
  assert.deepEqual(rules.personSuggestions(xs, 'Уда'), []);
  assert.deepEqual(rules.personSuggestions(xs, 'н'), []);
});

it('подсказки контактов ищут и по профилю, и по подписи, но показывают подпись', () => {
  // Старый профиль остаётся поисковым ключом, даже когда в списке показывается личная подпись.
  const peers = [dm('peer-a', 'Профиль Альфа'), dm('peer-b', 'Профиль Бета')];
  const nameOf = (id: string, fallback: string) => id === 'peer-a' ? 'Мастерская' : fallback;
  const check = (api: typeof rules) => {
    assert.deepEqual(api.personSuggestions(peers, 'Маст', 3, nameOf), [{ convId: 'peer-a', name: 'Мастерская' }]);
    assert.deepEqual(api.personSuggestions(peers, 'Альфа', 3, nameOf), [{ convId: 'peer-a', name: 'Мастерская' }]);
    assert.deepEqual(api.personSuggestions(peers, 'Бета', 3, nameOf), [{ convId: 'peer-b', name: 'Профиль Бета' }]);
  };
  check(rules);
  assert.throws(() => check(mutant('matchDmName(nameOf(d.otherUser.id, d.otherUser.displayName), q) ||', 'false ||')), assert.AssertionError,
    'мутант ищет только по исходному профилю и не находит знакомую подпись');
  assert.throws(() => check(mutant('matchDmName(d.otherUser.displayName, q) ||', 'false ||')), assert.AssertionError,
    'мутант ищет только по подписи и теряет совпадение с именем профиля');
});

it('фрагмент находит ё как е, сохраняет исходную букву и ограничивает хвост', () => {
  // Ловит отсутствие подсветки ё и переносы строк, разбивающие найденную фразу.
  const check = (api: typeof rules) => assert.equal(api.hitSnippet('  Ёж\nидёт ', 'еж').hit, 'Ёж');
  check(rules);
  assert.throws(() => check(mutant("s.toLowerCase().replace(/ё/g, 'е')", 's.toLowerCase()')), assert.AssertionError);
  assert.deepEqual(rules.hitSnippet('abc', ''), { pre: '', hit: '', post: 'abc' });
  assert.deepEqual(rules.hitSnippet('abcdef', 'нет', 5), { pre: '', hit: '', post: 'abcd…' });
  assert.ok(rules.hitSnippet('x'.repeat(30) + 'ёж' + 'z'.repeat(100), 'еж', 32).pre.startsWith('…'));
  assert.deepEqual(rules.hitSnippet('', 'еж'), { pre: '', hit: '', post: '' });
});

function searchApi(raw = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')) {
  const requests: { url: string; method: string }[] = [];
  const fail = () => { throw Error('неожиданная внешняя операция API'); };
  const deps: Record<string, unknown> = {
    './config': { config: { apiUrl: 'https://search.invalid' }, activeInstance: () => null, instances: () => [],
      activeInstanceId: () => 'test', updateActiveInstance: fail, updateInstance: fail },
    './bgGateways': { mirrorToBg: fail }, './imageSize': { measureMediaFile: fail },
  };
  const module = { exports: {} as typeof import('./api') };
  // Исполняется весь API с настоящим транспортом; fetch — явная граница, сети и настоящего реестра нет.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URLSearchParams, Response, Headers, AbortSignal, Map,
      localStorage: { getItem: () => null },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method ?? '' }); return new Response('{"hits":[],"next":null}', { status: 200 });
      }, require: (id: string) => { assert.ok(Object.hasOwn(deps, id), `неописанная зависимость API ${id}`); return deps[id]; } });
  return { api: module.exports.api, requests };
}
const uniqueChange = (source: string, anchor: string, replacement: string) => {
  assert.equal(source.split(anchor).length - 1, 1, 'уникальный якорь мутанта'); return source.replace(anchor, replacement);
};
it('API поиска передаёт chip `kind` вместе с пустым текстом и сохраняет остальные query-поля', async () => {
  // Чип «Медиа» сам по себе валиден: если клиент теряет kind, сервер получает пустой поиск и отвечает ошибкой.
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const check = async (body: string) => {
    const f = searchApi(body);
    await f.api.convSearchAll({ q: '', kind: 'media', conversationId: 'c', since: '2026-10-01', until: '2026-10-08', before: 'cursor', limit: 20 });
    assert.deepEqual(f.requests, [{ method: 'GET', url: 'https://search.invalid/api/conv/search?q=&conversationId=c&since=2026-10-01&until=2026-10-08&kind=media&before=cursor&limit=20' }], 'старые query-поля и kind сохранены');
  };
  await check(source);
  await assert.rejects(check(uniqueChange(source, "    if (a.kind) p.set('kind', a.kind);\n", '')),
    e => e instanceof assert.AssertionError && e.message.includes('старые query-поля'));
});

it('R183 вкладки поиска начинаются Чатами и содержат GIF вместо отсутствующей Музыки', () => {
  // Класс ошибки: порядок или вид вкладки расходится с поддержанными сервером фильтрами.
  assert.deepEqual(rules.PHONE_SEARCH_TABS, ['chats', 'media', 'link', 'file', 'gif', 'voice']);
  assert.deepEqual(rules.PHONE_SEARCH_TABS.map(rules.phoneSearchTabLabel), ['Чаты', 'Медиа', 'Ссылки', 'Файлы', 'GIF', 'Голосовые']);
});
function tabsShown(api: typeof rules) {
  for (const q of ['', '  ', '\n\t']) {
    assert.equal(api.phoneSearchTabsShown(q, {}), false, 'закрытое пустое поле без вкладок');
    assert.equal(api.phoneSearchTabsShown(q, {}, false), false);
    assert.equal(api.phoneSearchTabsShown(q, {}, true), true, 'открытое пустое поле с вкладками');
  }
  for (const q of ['', 'а', ' отчёт ']) for (const open of [false, true]) {
    const text = q.trim() !== '';
    assert.equal(api.phoneSearchTabsShown(q, {}, open), open || text);
    assert.equal(api.phoneSearchTabsShown(q, { person: { convId: 'c', name: 'Беседа' } }, open), open || text);
    assert.equal(api.phoneSearchTabsShown(q, { date: { label: 'Сегодня', since: 's', until: 'u' } }, open), open || text);
    for (const kind of shared.SHARED_MEDIA_KINDS) assert.equal(api.phoneSearchTabsShown(q, { kind }, open), false, 'чип вида прячет вкладки');
  }
}
it('R185 фокус пустого поиска показывает вкладки, чипы человека и даты не мешают, чип вида скрывает', () => {
  // Класс ошибки: старое правило непустого запроса или обход явного чипа вида при фокусе.
  tabsShown(rules);
});
for (const [name, from, to, target] of [
  ['без open', "return (open || q.trim() !== '') && !chips.kind;", "return q.trim() !== '' && !chips.kind;", 'открытое пустое поле'],
  ['без запрета чипа', "return (open || q.trim() !== '') && !chips.kind;", "return open || q.trim() !== '';", 'чип вида'],
] as const) it(`R185 мутант ${name} обнаруживается матрицей открытого поля и чипов`, () => {
  // Проверяются обе стороны признака, не только один разрешённый ввод.
  tabsShown(rules); assert.throws(() => tabsShown(mutant(from, to)), e => e instanceof assert.AssertionError && e.message.includes(target));
});
for (const [name, from, to] of [
  ['Музыка вместо GIF', "['chats', 'media', 'link', 'file', 'gif', 'voice']", "['chats', 'media', 'link', 'file', 'music', 'voice']"],
  ['Чаты не первые', "['chats', 'media', 'link', 'file', 'gif', 'voice']", "['media', 'chats', 'link', 'file', 'gif', 'voice']"],
  ['неверная подпись Чатов', "return tab === 'chats' ? 'Чаты' : SHARED_MEDIA_TITLES[tab];", "return tab === 'chats' ? 'Все' : SHARED_MEDIA_TITLES[tab];"],
] as const) it(`R183 мутант ${name} обнаруживается по точному списку и подписи`, () => {
  // Протокольный набор и подписи не должны расходиться с вкладками UI.
  const check = (api: typeof rules) => {
    assert.equal(Array.from(api.PHONE_SEARCH_TABS).join('|'), 'chats|media|link|file|gif|voice', 'порядок и виды вкладок');
    assert.equal(api.phoneSearchTabLabel('chats'), 'Чаты', 'подпись первой вкладки');
  };
  check(rules); assert.throws(() => check(mutant(from, to)), e => e instanceof assert.AssertionError && /вклад/.test(e.message));
});
async function fullSearch(raw?: string) {
  const f = searchApi(raw); const args = { q: 'отчёт & фото', kind: 'file' as const, full: true, conversationId: 'c', since: 's', until: 'u', before: 'x', limit: 1 };
  await f.api.convSearchAll(args);
  assert.equal(f.requests.length, 1); const url = new URL(f.requests[0].url);
  assert.equal(f.requests[0].method, 'GET'); assert.equal(url.pathname, '/api/conv/search');
  assert.equal(url.searchParams.get('names'), '1', 'full включает поиск по именам');
  assert.equal(url.searchParams.get('full'), '1', 'full просит целые сообщения');
  for (const [key, value] of Object.entries(args)) if (key !== 'full') assert.equal(url.searchParams.get(key), String(value), `поле ${key}`);
  assert.equal(args.q, 'отчёт & фото', 'обёртка не меняет исходный запрос');
}
it('R183 full поиска передаёт names и full вместе, сохраняет и экранирует все прежние поля', async () => {
  // Класс ошибки: запрос получает плитки без сообщений либо теряет поиск по имени файла.
  await fullSearch();
});
it('R183 отсутствие full и явное false оставляют прежнюю строку запроса побайтово', async () => {
  // Парное принимается: старый вызов не получает новый режим или пустые flags.
  for (const extra of [{}, { full: false }]) {
    const f = searchApi(); await f.api.convSearchAll({ q: 'а б', ...extra });
    assert.equal(f.requests[0].url, 'https://search.invalid/api/conv/search?q=%D0%B0+%D0%B1');
  }
});
for (const [flag, target] of [['names', 'поиск по именам'], ['full', 'целые сообщения']] as const)
  it(`R183 потеря ${flag} обнаруживается вызовом целого API`, async () => {
    // Контрфакт меняет реальную обёртку, а не склеенный для теста метод.
    await fullSearch(); const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
    await assert.rejects(fullSearch(uniqueChange(source, `p.set('${flag}', '1');`, '')),
      e => e instanceof assert.AssertionError && e.message.includes(target));
  });

it('вкладка «Все» сливает два курсора по времени и показывает только строки не глубже общего горизонта', () => {
  // При независимых курсорах нельзя показать старую строку одного источника, пока другой ещё не догружен до неё.
  const dmHits = { hits: [{ id: 'd12', createdAt: '2026-10-08T12:00:00Z' }, { id: 'd5', createdAt: '2026-10-08T05:00:00Z' }], next: 'dm-next' };
  const serverHits = { hits: [{ id: 's11', createdAt: '2026-10-08T11:00:00Z' }, { id: 's8', createdAt: '2026-10-08T08:00:00Z' }, { id: 's7', createdAt: '2026-10-08T07:00:00Z' }], next: 'server-next' };
  const check = (api: typeof rules) => {
    const merged = api.mergeSearchHits(dmHits, serverHits);
    const plain = JSON.parse(JSON.stringify(merged)) as { rows: { from: string; hit: { id: string } }[]; more: string | null };
    assert.deepEqual(plain.rows.map((r) => r.hit.id), ['d12', 's11', 's8', 's7']);
    assert.equal(plain.more, 'servers');
    const complete = api.mergeSearchHits({ hits: [{ id: 'd2', createdAt: '2026-10-08T02:00:00Z' }], next: null },
      { hits: [{ id: 's1', createdAt: '2026-10-08T01:00:00Z' }], next: null });
    assert.deepEqual(JSON.parse(JSON.stringify(complete)), { rows: [{ from: 'dm', hit: { id: 'd2', createdAt: '2026-10-08T02:00:00Z' } },
      { from: 'servers', hit: { id: 's1', createdAt: '2026-10-08T01:00:00Z' } }], more: null });
  };
  check(rules);
  check(mutant('const horizon = dmTail === null ? srvTail : srvTail === null ? dmTail : Math.max(dmTail, srvTail);',
    'const horizon = dmTail === null ? srvTail : srvTail === null ? dmTail : Math.max(dmTail, srvTail);'));
  assert.throws(() => check(mutant('Math.max(dmTail, srvTail)', 'Math.min(dmTail, srvTail)')), assert.AssertionError,
    'мутант выбирает минимальный хвост и преждевременно показывает старые строки');
  assert.throws(() => check(mutant('horizon === null || at(r.hit.createdAt) >= horizon', 'true')), assert.AssertionError,
    'мутант игнорирует горизонт и выдаёт страницы разных глубин вперемешку');
});
