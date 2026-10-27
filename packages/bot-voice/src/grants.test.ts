import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as grants from './grants.js';

// Только синтетическая полезная нагрузка. Этот модуль не проверяет подпись; права держит сам SFU.
const token = (payload: unknown) => `test-header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
const invalid = [undefined, null, '', 'not-jwt', 'header.payload', 'a.b.c.d', 'header..signature',
  'header.@@@.signature', `header.${Buffer.from('{broken').toString('base64url')}.signature`,
  `header.${Buffer.from([0xff]).toString('base64url')}.signature`];

it('R309 декодирование сохраняет объект с Unicode и вложенными правами без проверки подписи', () => {
  const payload = { sub: 'music-user', name: 'Музыка 🪿', video: { canPublish: true, canPublishSources: ['microphone'] } };
  assert.deepEqual(grants.decodeJwtPayload(token(payload)), payload);
  assert.deepEqual(grants.decodeJwtPayload(token({})), {});
});
it('R309 не-JWT, два/четыре сегмента, пустая нагрузка и мусор дают неизвестно, не запрет', () => {
  for (const value of invalid) {
    assert.equal(grants.decodeJwtPayload(value), null);
    assert.equal(grants.canSpeakFromToken(value), null);
  }
});
it('R309 JSON-массив и скаляры в нагрузке не подменяют объект прав', () => {
  for (const value of [[], [{}], null, true, false, 42, 'text']) {
    assert.equal(grants.decodeJwtPayload(token(value)), null);
    assert.equal(grants.canSpeakFromToken(token(value)), null);
  }
});

const cases: { name: string; video: Record<string, unknown>; expected: boolean }[] = [
  { name: 'явный publish и микрофон', video: { canPublish: true, canPublishSources: ['microphone'] }, expected: true },
  { name: 'publish false без списка', video: { canPublish: false }, expected: false },
  { name: 'publish false с пустым списком', video: { canPublish: false, canPublishSources: [] }, expected: false },
  { name: 'publish false важнее разрешённого источника', video: { canPublish: false, canPublishSources: ['microphone'] }, expected: false },
  { name: 'одна камера не разрешает микрофон', video: { canPublish: true, canPublishSources: ['camera'] }, expected: false },
  { name: 'микрофон среди камеры достаточен', video: { canPublish: true, canPublishSources: ['camera', 'microphone'] }, expected: true },
  { name: 'пустой список значит любые источники', video: { canPublish: true, canPublishSources: [] }, expected: true },
  { name: 'нет списка значит любые источники', video: { canPublish: true }, expected: true },
  { name: 'publish по умолчанию разрешён', video: { canPublishSources: ['microphone'] }, expected: true },
  { name: 'верхний регистр MICROPHONE', video: { canPublishSources: ['MICROPHONE'] }, expected: true },
  { name: 'смешанный регистр среди камеры', video: { canPublishSources: ['camera', 'MiCrOpHoNe'] }, expected: true },
  { name: 'нестроковые соседи не скрывают микрофон', video: { canPublishSources: [null, 7, {}, 'microphone'] }, expected: true },
  { name: 'нестроковой список без микрофона не разрешает публикацию', video: { canPublishSources: [null, 7, {}] }, expected: false },
];
for (const c of cases) it(`R309 права голоса: ${c.name}`, () => {
  assert.equal(grants.canSpeakFromGrants(c.video), c.expected);
  // Тот же контракт через целый JWT: обёртка не должна терять video или менять tri-state.
  assert.equal(grants.canSpeakFromToken(token({ video: c.video })), c.expected);
});
it('R309 отсутствующий или скалярный video остаётся неизвестным, пустой объект прав разрешает по умолчанию', () => {
  for (const value of [undefined, null, false, true, 'microphone', 0, [], [{}]]) {
    assert.equal(grants.canSpeakFromGrants(value), null);
    assert.equal(grants.canSpeakFromToken(token({ video: value })), null);
  }
  assert.equal(grants.canSpeakFromToken(token({ sub: 'music-user' })), null);
  assert.equal(grants.canSpeakFromGrants({}), true);
  assert.equal(grants.canSpeakFromToken(token({ video: {} })), true);
});

const source = readFileSync(new URL('./grants.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function load(raw = source): typeof grants {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Buffer, require(id: string) { throw new Error(`R309 grants: неописанный импорт ${id}`); } });
  return module.exports as typeof grants;
}
const mutants: { name: string; from: string; to: string; check(g: typeof grants): boolean | null; expected: boolean | null; actual: boolean }[] = [
  { name: 'снят приоритет canPublish false', from: '  if (v.canPublish === false) return false;', to: '',
    check: g => g.canSpeakFromGrants({ canPublish: false, canPublishSources: ['microphone'] }), expected: false, actual: true },
  { name: 'every вместо some', from: 'sources.some(', to: 'sources.every(',
    check: g => g.canSpeakFromGrants({ canPublishSources: ['camera', 'microphone'] }), expected: true, actual: false },
  { name: 'пустой список ошибочно запрещает', from: 'Array.isArray(sources) && sources.length > 0', to: 'Array.isArray(sources)',
    check: g => g.canSpeakFromGrants({ canPublishSources: [] }), expected: true, actual: false },
  { name: 'потеря нормализации регистра', from: 's.toLowerCase()', to: 's',
    check: g => g.canSpeakFromGrants({ canPublishSources: ['MICROPHONE'] }), expected: true, actual: false },
  { name: 'неразборчивый токен стал запретом', from: 'return payload ? canSpeakFromGrants(payload.video) : null;', to: 'return payload ? canSpeakFromGrants(payload.video) : false;',
    check: g => g.canSpeakFromToken('header.payload'), expected: null, actual: false },
];
for (const m of mutants) it(`R309 контрфакт прав: ${m.name}`, () => {
  const marker = `R309_GRANTS: ${m.name}`;
  const check = (g: typeof grants) => assert.equal(m.check(g), m.expected, marker);
  check(grants); check(load());
  assert.equal(source.split(m.from).length - 1, 1, 'уникальный якорь мутанта');
  assert.throws(() => check(load(source.replace(m.from, m.to))), e => e instanceof assert.AssertionError
    && e.code === 'ERR_ASSERTION' && e.operator === 'strictEqual' && e.message.startsWith(marker)
    && e.actual === m.actual && e.expected === m.expected);
});
