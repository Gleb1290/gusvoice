import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import { dmNeedsServerUpdate, dmPeerHome, peerPresenceShown } from './dmRules';
import { peerPresenceShown as syncPresenceShown } from './convSyncRules';
import { dmBlockText, dmEmptyHint, dmComposeCandidates, DM_CANDIDATES_MAX, type DmCandidate, userSearchQuery, dmSearchHits, dmComposeHint, serverSearchesUsers, USER_SEARCH_DELAY_MS, dmRemoteQuery, remoteHandle, serverFedDm } from './dmRules.js';

const compatibilityCases = [
  ['признаки ещё не пришли (null)', null, false],
  ['признаки ещё не пришли (undefined)', undefined, false],
  ['сервер не объявил возможностей', [], true],
  ['только conv1 без новой рассылки', ['conv1'], true],
  ['только conv2 без бесед', ['conv2'], true],
  ['беседы и новая рассылка доступны', ['conv1', 'conv2'], false],
] as const;

it('R197 обе копии правила профиля не скрывают местного при null и не выдумывают статус соседа без fedm4', () => {
  for (const features of [null, undefined, [], ['fedm3'], ['fedm4'], ['FEDM4']] as const) for (const remote of [false, true]) {
    const expected = !remote || !!features?.includes('fedm4' as never);
    assert.equal(peerPresenceShown(remote, features), expected);
    assert.equal(syncPresenceShown(remote, features), expected);
  }
});
function homeContract(api: Pick<typeof import('./dmRules'), 'dmPeerHome'>) {
  const home = { instanceId: 'neighbor', name: 'Сосед', domain: 'neighbor.example' };
  const other = { instanceId: 'other', name: 'Другой', domain: 'other.example' };
  const rows = [
    { group: {}, otherUser: { id: 'peer', homeInstance: other } },
    { saved: true, otherUser: { id: 'peer', homeInstance: other } },
    { otherUser: { id: 'peer', homeInstance: home } },
    { otherUser: { id: 'local' } },
  ];
  assert.equal(api.dmPeerHome(rows, 'peer'), home, 'только домашний инстанс личной беседы');
  assert.equal(api.dmPeerHome(rows.slice(0, 2), 'peer'), null, 'группа и Избранное не задают дом человека');
  for (const id of ['missing', undefined, '']) assert.equal(api.dmPeerHome(rows, id), null);
  assert.equal(api.dmPeerHome(rows, 'local'), null); assert.equal(api.dmPeerHome(undefined, 'peer'), null);
}
it('R197 dmPeerHome берёт homeInstance из личной беседы без ростера, пропускает группы и Избранное', () => homeContract({ dmPeerHome }));
function loadDmRules(raw: string): typeof import('./dmRules') {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return shared; } });
  return module.exports as typeof import('./dmRules');
}
for (const [name, anchor, replacement, check, target] of [
  ['копия профиля рассинхронизирована', 'return !peerHome || !!features?.includes(FEATURE_FEDM4);', 'return true;',
    (api: typeof import('./dmRules')) => assert.equal(api.peerPresenceShown(true, null), false, 'сосед без fedm4 не виден'), 'сосед без fedm4'],
  ['группа или Избранное задают дом', '!d.group && !d.saved && d.otherUser.id === userId', 'd.otherUser.id === userId', homeContract, 'только домашний инстанс'],
] as const) it(`R197 мутант «${name}» ломает целый модуль dmRules`, () => {
  const original = readFileSync(new URL('./dmRules.ts', import.meta.url), 'utf8');
  check(loadDmRules(original)); assert.equal(original.split(anchor).length - 1, 1, 'единственный якорь');
  const mutant = loadDmRules(original.replace(anchor, replacement));
  assert.throws(() => check(mutant), e => e instanceof assert.AssertionError && e.message.includes(target));
});
for (const [label, features, expected] of compatibilityCases) {
  it(`ЛС требуют обновления сервера: ${label} → ${expected ? 'да' : 'нет'}`, () => {
    assert.equal(dmNeedsServerUpdate(features), expected);
  });
}
it('инверсия совместимости ЛС обнаруживается той же таблицей реального модуля', () => {
  for (const [, features, expected] of compatibilityCases) assert.equal(dmNeedsServerUpdate(features), expected);
  const original = readFileSync(new URL('./dmRules.ts', import.meta.url), 'utf8');
  const changed = original.replace('return !(features.includes(CAP_CONV1)', 'return (features.includes(CAP_CONV1)');
  assert.notEqual(changed, original);
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(changed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: (id: string) => { assert.equal(id, '@gusvoice/shared'); return shared; } });
  const bad = module.exports as typeof import('./dmRules');
  assert.throws(() => {
    for (const [, features, expected] of compatibilityCases) assert.equal(bad.dmNeedsServerUpdate(features), expected);
  }, assert.AssertionError);
});

it('серверный поиск требует users1 и паузы 300 мс, старый сервер не получает ручку', () => {
  // Незнакомая capability не должна включить запрос к отсутствующему endpoint.
  assert.equal(USER_SEARCH_DELAY_MS, 300);
  assert.equal(serverSearchesUsers(['users1']), true);
  for (const f of [null, undefined, [], ['conv9'], ['users2']]) assert.equal(serverSearchesUsers(f), false);
});

it('запрос @логина совпадает с маской сервера и обеими границами длины', () => {
  // Клиент не должен молча отвергать допустимый сервером логин или спамить 400 на каждый ввод.
  assert.equal(userSearchQuery(' @AbC._- '), 'abc._-');
  for (const n of [3, 32]) assert.equal(userSearchQuery('a'.repeat(n)), 'a'.repeat(n));
  for (const q of ['aa', 'a'.repeat(33), '@@abc', 'абв', 'a bc', '', '@']) assert.equal(userSearchQuery(q), null);
});

it('кандидаты с @ ищутся как без него, но второй @ не срезается', () => {
  // Упоминание знакомого человека раньше ошибочно считалось частью его логина.
  const person: DmCandidate = { id: 'p', username: 'alice', displayName: 'Peer', avatarUrl: null };
  const p = { members: [{ user: person }], dms: [], meId: 'me', query: '@ALI' };
  assert.deepEqual(dmComposeCandidates(p), [person]);
  assert.deepEqual(dmComposeCandidates({ ...p, query: '@@ALI' }), []);
});

it('серверные результаты исключают себя, локальные дубли и старые несовпадающие логины', () => {
  // Ответ предыдущего поиска не должен подмешать человека под текущий запрос.
  const hits = ['me', 'known', 'match', 'old'].map(id => ({ id, username: id === 'old' ? 'bob' : 'alice', displayName: id, avatarUrl: null }));
  const p = { hits, candidates: [{ id: 'known' }], meId: 'me', query: 'ali' };
  assert.deepEqual(dmSearchHits(p), [hits[2]]);
  assert.deepEqual(dmSearchHits({ ...p, query: null }), []);
  assert.deepEqual(dmSearchHits({ ...p, hits: [] }), []);
  assert.equal(hits.length, 4, 'фильтр не мутирует входной ответ');
});

it('пустое окно различает старый сервер, ввод, ожидание, отказ и пустую выдачу', () => {
  // Подпись не должна маскировать ошибку как «никого нет» или учить гостя недоступному поиску.
  const p = { searchOn: true, shown: 0, query: ' @abc ', search: null };
  assert.equal(dmComposeHint(p), 'Введите @имя');
  assert.equal(dmComposeHint({ ...p, searchOn: false }), 'Некому написать — откройте сервер с участниками.');
  assert.equal(dmComposeHint({ ...p, search: { state: 'loading' } }), 'Ищем…');
  assert.equal(dmComposeHint({ ...p, search: { state: 'error', error: 'слишком часто' } }), 'слишком часто');
  assert.equal(dmComposeHint({ ...p, search: { state: 'done' } }), 'По запросу «@abc» никого нет');
  assert.equal(dmComposeHint({ ...p, shown: 1, search: { state: 'error', error: 'ошибка' } }), null);
});

describe('кандидаты новой беседы', () => {
  const u = (id: string): DmCandidate => ({ id, username: id, displayName: `Кот ${id}`, avatarUrl: null });
  it('ростер первый, дубли собеседников не теряют дом, себя и стёртых нет', () => {
    // Ловит повторные строки и потерю запрета гостевой ЛС после дедупликации.
    const roster: DmCandidate = { ...u('b'), homeInstance: { instanceId: 'peer', name: 'Дом', domain: 'peer.example.test' } };
    const result = dmComposeCandidates({ members: [{ user: u('me') }, { user: roster }], dms: ['b','c','gone:d','me'].map(id => ({ otherUser: u(id) })), meId: 'me', query: '' });
    assert.deepEqual(result, [roster, u('c')]); assert.equal(result[0], roster);
  });
  it('«Избранное» и группы не становятся кандидатами для личного сообщения', () => {
    // Иначе диалог «Написать» предлагает открыть личку с самим собой или с группой как с человеком.
    const saved = u('saved:conv-1');
    const group = u('group:conv-2');
    const ordinary = u('peer');
    assert.deepEqual(dmComposeCandidates({ members: [], dms: [saved, group, ordinary].map((otherUser) => ({ otherUser })), meId: 'me', query: '' }), [ordinary]);
  });
  it('устаревшая беседа не подменяет ростерную запись при поиске по старому имени', () => {
    // Если дедупликация идёт после поиска, устаревшее имя даст гостю строку без homeInstance и обойдёт запрет ЛС.
    const roster: DmCandidate = { ...u('same'), displayName: 'Новое имя', homeInstance: { instanceId: 'peer', name: 'Дом', domain: 'peer.example.test' } };
    const old: DmCandidate = { ...u('same'), displayName: 'Старое имя', homeInstance: null };
    const input = { members: [{ user: roster }], dms: [{ otherUser: old }], meId: null, query: '' };
    assert.deepEqual(dmComposeCandidates({ ...input, query: 'старое' }), []);
    assert.deepEqual(dmComposeCandidates({ ...input, query: 'новое' }), [roster]);
    assert.equal(dmComposeCandidates(input)[0].homeInstance, roster.homeInstance);
  });
  it('пустой ростер не прячет собеседников, пустая сессия не выдумывает людей', () => {
    // Ловит прежнее Некому написать до открытия сервера.
    for (const meId of [null, undefined]) assert.deepEqual(dmComposeCandidates({ members: [], dms: [{ otherUser: u('a') }], meId, query: ' ' }), [u('a')]);
    assert.deepEqual(dmComposeCandidates({ members: [], dms: [], meId: null, query: '' }), []);
  });
  it('имя и логин ищутся подстрокой без регистра и крайних пробелов', () => {
    // Ловит поиск лишь по одному полю и отказ запроса с пробелами.
    const base = { members: [{ user: u('ALPHA') }], dms: [], meId: undefined };
    for (const query of [' alpha ', ' КОТ ', 'PHA', '  ']) assert.equal(dmComposeCandidates({ ...base, query }).length, 1);
    assert.deepEqual(dmComposeCandidates({ ...base, query: 'нет' }), []);
  });
  it('подпись контакта тоже ищется, а найденный кандидат сохраняет профильные данные', () => {
    // Подпись — поисковое имя, но сам объект профиля нужен для аватара, логина и ограничения гостевой лички.
    const peer: DmCandidate = { ...u('peer-a'), displayName: 'Профиль Альфа', username: 'alpha' };
    const result = dmComposeCandidates({ members: [{ user: peer }], dms: [], meId: null, query: 'Мастер', nameOf: () => 'Мастерская' });
    assert.equal(result.length, 1);
    assert.equal(result[0], peer);
    assert.equal(result[0]?.displayName, 'Профиль Альфа');
    assert.deepEqual(dmComposeCandidates({ members: [{ user: peer }], dms: [], meId: null, query: 'Альфа', nameOf: () => 'Мастерская' }), [peer]);
  });
  it('ровно 50 кандидатов проходят, 51-й отсечён, явный предел управляет списком', () => {
    // Ловит ошибку на единицу и игнорирование limit.
    const base = { members: Array.from({ length: 51 }, (_, i) => ({ user: u(String(i)) })), dms: [], meId: null, query: '' };
    assert.equal(DM_CANDIDATES_MAX, 50); assert.equal(dmComposeCandidates(base).length, 50);
    assert.equal(dmComposeCandidates({ ...base, limit: 51 }).length, 51);
    assert.equal(dmComposeCandidates({ ...base, limit: 0 }).length, 0);
  });
});

const guest = { id: 'home', name: 'Соседи' } as never;

it('R189 fedm1 открывает ЛС с гостем-собеседником, но не отменяет запрет для самого гостя', () => {
  // Класс ошибки: новый признак снимает двусторонний запрет без различения инициатора и собеседника.
  assert.equal(dmBlockText(null, guest, true), null);
  assert.equal(dmBlockText(null, null, true), null);
  assert.match(dmBlockText(null, guest, false)!, /людьми других инстансов/);
  for (const target of [null, guest]) for (const on of [false, true]) assert.match(dmBlockText(guest, target, on)!, /Вы здесь гость/);
});
it('R189 удалённый поиск сохраняет запрос как введён, только обрезая края, и требует fedm1', () => {
  // Класс ошибки: сервер получает локально нормализованный запрос и теряет дом/регистр введённого адреса.
  for (const value of ['@Peer@Neighbor.example', 'Peer@Neighbor.example:4300']) {
    assert.equal(dmRemoteQuery(`  ${value}  `, true), value);
    assert.equal(dmRemoteQuery(value, false), null);
  }
  for (const value of ['', '@peer', 'peer', '@@peer@neighbor.example', '@peer@', 'перо@neighbor.example', 'a'.repeat(33) + '@neighbor.example']) {
    assert.equal(dmRemoteQuery(value, true), null);
  }
});
it('R189 возможность удалённых ЛС включается только точным fedm1, до загрузки признаков не включается', () => {
  // Класс ошибки: клиент открывает ещё не подключённый маршрут по похожему или следующему признаку.
  assert.equal(serverFedDm(['fedm1']), true);
  for (const features of [null, undefined, [], ['dm1'], ['fedm2'], ['FEDM1']]) assert.equal(serverFedDm(features), false);
});
it('R189 подпись удалённого человека содержит его домашний логин и дом, без домена не выводит undefined', () => {
  // Класс ошибки: служебный id теневого или неизвестный дом выдаются человеку как адрес для поиска.
  assert.equal(remoteHandle({ username: 'peer', instance: { name: 'Сосед', domain: 'neighbor.example' } }), '@peer@neighbor.example');
  assert.equal(remoteHandle({ username: 'peer', instance: { name: null, domain: '' } }), '@peer');
});

describe('личка между инстансами', () => {
  it('двое местных могут открыть личку', () => {
    // Ловит чрезмерный запрет обычной локальной переписки.
    assert.equal(dmBlockText(null, null), null);
  });

  it('гость получает объяснение про себя независимо от дома собеседника', () => {
    // Ловит ошибочный совет выбрать другого собеседника, когда запрет относится к самому гостю.
    assert.match(dmBlockText(guest, null)!, /Вы здесь гость/);
    assert.match(dmBlockText(guest, guest)!, /Вы здесь гость/);
  });

  it('местному объясняют запрет для гостя, а пустой экран меняется по его дому', () => {
    // Ловит интерфейс, который зовёт гостя начать заведомо недоступную личку.
    assert.match(dmBlockText(null, guest)!, /людьми других инстансов/);
    assert.match(dmEmptyHint(guest), /Гостю/);
    assert.match(dmEmptyHint(null), /Откройте участников/);
  });
});
