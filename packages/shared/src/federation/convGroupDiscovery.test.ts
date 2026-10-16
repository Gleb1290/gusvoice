import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { parseConvGroupExtras, parseConvGroupsList, serializeConvGroupExtras, serializeConvGroupsList,
  FED_CONV_GROUPS_MAX, FED_CONV_GROUPS_PATH } from './convGroup.js';
import { parseConvWire, serializeConvWire } from './convWire.js';

const fixture = (name: string): Record<string, unknown> => {
  const text = readFileSync(new URL(`./fixtures/v1/${name}.json`, import.meta.url), 'utf8');
  const hashes: Record<string, string> = { 'conv-groups-list-e7': '255c7039ff114fb624dbc2a574f2cd2b',
    'conv-group-e7-homes': '7d5de95e11774deedaf7cfea95ae4760' };
  assert.equal(createHash('sha256').update(text).digest('hex').slice(0, 32), hashes[name], 'историческая фикстура не подогнана под новый парсер');
  return JSON.parse(text);
};
const home = 'a'.repeat(32);

// Историческая запись списка должна пережить разбор без потери групп и имени отправителя.
it('R208 провод conv-groups-list-e7 разбирается и собирается обратно без изменений', () => {
  const raw = fixture('conv-groups-list-e7');
  const parsed = parseConvGroupsList(raw); assert.ok(parsed);
  assert.deepEqual(serializeConvGroupsList(parsed), raw);
  assert.equal(FED_CONV_GROUPS_PATH, '/fed/v1/conv/groups'); assert.equal(FED_CONV_GROUPS_MAX, 1000);
});

// Одно повреждённое имя группы не теряет правильных соседей; дубли не запускают повторный export.
it('R208 список групп убирает дубли и негодные id, порядок правильных сохраняется', () => {
  const raw = { instance_id: home, groups: ['g1', 'g1', '../bad', '', null, 5, 'x'.repeat(64), 'x'.repeat(65), 'g2'] };
  assert.deepEqual(parseConvGroupsList(raw), { instanceId: home, groups: ['g1', 'x'.repeat(64), 'g2'] });
  assert.deepEqual(raw.groups.slice(0, 2), ['g1', 'g1'], 'внешний массив не меняется');
});

// Пустой список легален, отсутствие массива или негодный отправитель — не пустой успешный ответ.
it('R208 список групп принимает пустой ответ и отвергает неверную оболочку', () => {
  assert.deepEqual(parseConvGroupsList({ instance_id: home, groups: [] }), { instanceId: home, groups: [] });
  for (const raw of [null, {}, { instance_id: '../bad', groups: [] }, { instance_id: home }, { instance_id: home, groups: 'g1' }])
    assert.equal(parseConvGroupsList(raw), null);
});

// Обе стороны провода ограничены одинаково: 1000 проходит, 1001-я группа не просачивается на приёме или отправке.
it('R208 список групп держит предел 1000 с обеих сторон, а дубли внутри окна не расширяют его', () => {
  const groups = Array.from({ length: 1001 }, (_, i) => `g${i}`);
  assert.equal(parseConvGroupsList({ instance_id: home, groups: groups.slice(0, 1000) })?.groups.length, 1000);
  assert.deepEqual(parseConvGroupsList({ instance_id: home, groups })?.groups, groups.slice(0, 1000));
  assert.deepEqual(serializeConvGroupsList({ instanceId: home, groups }), { instance_id: home, groups: groups.slice(0, 1000) });
  assert.deepEqual(parseConvGroupsList({ instance_id: home, groups: [...Array(1000).fill('same'), 'late'] })?.groups, ['same']);
});

// У третьего дома нет прямой связки: дополнительные подписи должны сохраниться в том же проводе группы.
it('R208 conv-group-e7-homes сохраняет дом третьего участника и домен с портом', () => {
  const raw = fixture('conv-group-e7-homes');
  const wire = parseConvWire(raw), extras = parseConvGroupExtras(raw); assert.ok(wire && extras);
  assert.deepEqual({ ...serializeConvWire(wire), ...serializeConvGroupExtras(extras) }, raw);
  assert.equal(extras.profiles[0].home, undefined);
  assert.deepEqual(extras.profiles[1].home, { name: 'Утиный пруд', domain: 'pond.example.org' });
  assert.deepEqual(extras.profiles[2].home, { name: null, domain: 'swans.example.org:8443' });
});

const profile = (home_name: unknown, home_domain: unknown) => ({ instance_id: home, user_id: 'peer', username: 'synthetic_peer',
  display_name: 'Участник', avatar_hash: null, home_name, home_domain });
// Плохой домен не должен попасть в подпись/ссылку, но сам корректный участник не теряется.
it('R208 профиль без правильного домена остаётся участником, но не получает home', () => {
  for (const domain of [undefined, null, '', 'https://peer.example.test', 'peer.example.test/path', 'peer name', '<b>peer</b>']) {
    const parsed = parseConvGroupExtras({ group_version: 1, profiles: [profile('Дом', domain)] });
    assert.equal(parsed?.profiles.length, 1); assert.equal(Object.hasOwn(parsed!.profiles[0], 'home'), false);
  }
  assert.deepEqual(parseConvGroupExtras({ group_version: 1, profiles: [profile('Дом', 'peer.example.test:8443')] })?.profiles[0].home,
    { name: 'Дом', domain: 'peer.example.test:8443' });
});

// Переполненное/скрытое имя заменяется null, а допустимый домен остаётся запасной подписью.
it('R208 имя дома длиной 40 принимается, 41 и скрытый символ дают null без потери домена', () => {
  for (const [name, expected] of [['Н'.repeat(40), 'Н'.repeat(40)], ['Н'.repeat(41), null], ['дом\u202e', null], ['', null], [null, null]]) {
    assert.deepEqual(parseConvGroupExtras({ group_version: 1, profiles: [profile(name, 'peer.example.test')] })?.profiles[0].home,
      { name: expected, domain: 'peer.example.test' });
  }
});
