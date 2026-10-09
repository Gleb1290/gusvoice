import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DmChannel } from '@gusvoice/shared';
import * as rules from './dmListSearchRules';
import * as row from './dmRowRules';
function mutant(from: string, to: string): typeof rules {
  const source = readFileSync(new URL('./dmListSearchRules.ts', import.meta.url), 'utf8');
  assert.ok(source.includes(from));
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace(from, to), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: () => row });
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

it('API поиска передаёт chip `kind` вместе с пустым текстом и сохраняет остальные query-поля', () => {
  // Чип «Медиа» сам по себе валиден: если клиент теряет kind, сервер получает пустой поиск и отвечает ошибкой.
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  convSearchAll: (');
  assert.ok(start >= 0, 'найдена реальная обёртка api.convSearchAll');
  const end = source.indexOf('\n  },', start);
  assert.ok(end > start, 'найдена граница метода');
  const method = source.slice(start, end + 4);
  const check = (body: string) => {
    const requests: string[] = [];
    const module = { exports: {} as Record<string, unknown> };
    const code = ts.transpileModule(`const api = {${body}}; module.exports = api;`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, { module, exports: module.exports, URLSearchParams,
      req: (_method: string, path: string) => { requests.push(path); return path; } });
    const api = module.exports as { convSearchAll: (a: { q: string; kind?: string; conversationId?: string; since?: string; until?: string; before?: string; limit?: number }) => string };
    const result = api.convSearchAll({ q: '', kind: 'media', conversationId: 'c', since: '2026-10-01', until: '2026-10-08', before: 'cursor', limit: 20 });
    assert.equal(result, '/conv/search?q=&conversationId=c&since=2026-10-01&until=2026-10-08&kind=media&before=cursor&limit=20');
    assert.deepEqual(requests, [result]);
  };
  check(method);
  assert.throws(() => check(method.replace("    if (a.kind) p.set('kind', a.kind);\n", '')), assert.AssertionError,
    'мутант теряет фильтр вида: из пустого запроса серверу нечего искать');
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
