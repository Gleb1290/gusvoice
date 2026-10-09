import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dmBlockText, dmEmptyHint, dmComposeCandidates, DM_CANDIDATES_MAX, type DmCandidate, userSearchQuery, dmSearchHits, dmComposeHint, serverSearchesUsers, USER_SEARCH_DELAY_MS } from './dmRules.js';

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
