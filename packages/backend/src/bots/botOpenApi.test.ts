import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import { BOT_VOICE_BITRATE, CALLBACK_DATA_MAX_BYTES } from '@gusvoice/shared';
import * as api from './botOpenApi.js';
import * as spec from './botSpec.js';
import * as wire from './botWire.js';
import { BOT_API_FEATURES, BOT_API_VERSION, BOT_UPDATE_TYPES, GET_UPDATES_LIMIT_MAX } from './botRules.js';
import { MESSAGE_TEXT_MAX } from '../convRules.js';
import { WEBHOOK_FILES_MAX, WEBHOOK_FILE_MAX_BYTES } from '../webhookRules.js';
import { assertion, loadOpenApi, loadSpec, loadWire, plain, type Edit } from './botOpenApi.harness.js';

type J = api.JsonObject;
function object(value: unknown): J { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as J; }
function at(value: unknown, ...path: string[]): J { for (const key of path) value = object(value)[key]; return object(value); }
function deref(doc: J, node: J): J {
  if (typeof node.$ref !== 'string') return node;
  assert.ok(node.$ref.startsWith('#/'));
  return at(doc, ...node.$ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')));
}
function request(doc: J, name: string): J { return at(doc, 'paths', `/bot/v1/${name}`, 'post', 'requestBody', 'content', 'application/json', 'schema'); }
function visit(node: unknown, check: (value: J) => void) {
  if (node && typeof node === 'object') {
    if (!Array.isArray(node)) check(node as J);
    for (const child of Object.values(node)) visit(child, check);
  }
}
function refs(mod = api) {
  const doc = mod.buildBotOpenApi(); let found = 0;
  visit(doc, node => {
    assert.equal(Object.hasOwn(node, '$defs'), false); assert.equal(Object.hasOwn(node, '$schema'), false);
    if (typeof node.$ref === 'string') {
      found++; assert.equal(node.$ref.startsWith('#/components/'), true, 'R307 ссылки направлены в components');
      deref(doc, node);
    }
    assert.notEqual(node.minimum, -Number.MAX_SAFE_INTEGER); assert.notEqual(node.maximum, Number.MAX_SAFE_INTEGER);
  });
  assert.ok(found > 0, 'проверка ссылок не пустая');
}
it('R307 генератор дважды даёт одинаковые байты, VM-оригинал совпадает; версия, MIT и относительный сервер сохранены', () => {
  const a = api.buildBotOpenApi(), b = api.buildBotOpenApi();
  assert.equal(JSON.stringify(a), JSON.stringify(b)); assert.equal(JSON.stringify(loadOpenApi().buildBotOpenApi()), JSON.stringify(a));
  assert.equal(a.openapi, '3.1.0'); assert.equal(at(a, 'info').version, `1.${BOT_API_VERSION}.0`);
  assert.equal(at(a, 'info', 'license').identifier, 'MIT'); assert.equal(a['x-api-version'], 4);
  assert.deepEqual(a['x-features'], [...BOT_API_FEATURES]); assert.equal(object((a.servers as api.Json[])[0]).url, '/api');
  const names = Object.keys(at(a, 'components', 'schemas')); assert.deepEqual(names, [...names].sort());
});
it('R307 все ссылки разрешаются, служебных defs/schema и безопасных псевдограниц Zod нет', () => refs());
it('R307 каждый метод имеет уникальный operationId, Bot-token security и обязательный конверт результата', () => {
  const doc = api.buildBotOpenApi(), paths = at(doc, 'paths'), ids: string[] = [];
  assert.deepEqual(Object.keys(paths), spec.BOT_METHOD_SPECS.map(m => `/bot/v1/${m.name}`));
  for (const [path, value] of Object.entries(paths)) {
    const op = at(value, 'post'); ids.push(String(op.operationId));
    assert.equal(op.operationId, path.slice(path.lastIndexOf('/') + 1), 'R307 operationId сохраняет имя метода из пути и реестра');
    assert.deepEqual(op.security, [{ botToken: [] }], path);
    for (const code of ['200', '401', '429']) assert.ok(Object.hasOwn(at(op, 'responses'), code), `${path}: ${code}`);
    const envelope = at(op, 'responses', '200', 'content', 'application/json', 'schema');
    assert.deepEqual(envelope.required, ['ok', 'result']); assert.equal(at(envelope, 'properties', 'ok').const, true);
    assert.ok(Object.hasOwn(at(envelope, 'properties'), 'result'));
    assert.equal(Object.hasOwn(envelope, 'additionalProperties'), false);
  }
  assert.equal(new Set(ids).size, ids.length);
  const token = at(doc, 'components', 'securitySchemes', 'botToken');
  assert.equal(token.type, 'apiKey'); assert.equal(token.in, 'header'); assert.equal(token.name, 'Authorization');
});
function required(mod = api) {
  const doc = mod.buildBotOpenApi();
  const fields = request(doc, 'sendMessage').required;
  assert.equal(Array.isArray(fields) && fields.includes('chat_id'), true, 'R307 chat_id обязателен');
  assert.equal(at(doc, 'paths', '/bot/v1/sendMessage', 'post', 'requestBody').required, true);
  assert.equal(at(doc, 'paths', '/bot/v1/getUpdates', 'post', 'requestBody').required, false);
  assert.equal(Object.hasOwn(at(doc, 'paths', '/bot/v1/getMe', 'post'), 'requestBody'), false);
}
it('R307 sendMessage требует chat_id, но getUpdates допускает пустое тело, а getMe вообще без параметров', () => required());
it('R307 sendMessage описывает JSON и multipart, файлы и пределы совпадают с действующим кодом', () => {
  const doc = api.buildBotOpenApi(), content = at(doc, 'paths', '/bot/v1/sendMessage', 'post', 'requestBody', 'content');
  assert.deepEqual(Object.keys(content), ['application/json', 'multipart/form-data']);
  const json = at(content, 'application/json', 'schema'), form = at(content, 'multipart/form-data', 'schema');
  for (const [name, value] of Object.entries(at(json, 'properties'))) assert.deepEqual(at(form, 'properties')[name], value);
  assert.deepEqual(form.required, json.required);
  const file = at(form, 'properties', 'files[0]'); assert.equal(file.type, 'string'); assert.equal(file.contentMediaType, 'application/octet-stream');
  assert.ok(String(file.description).includes(String(WEBHOOK_FILES_MAX))); assert.ok(String(file.description).includes(String(WEBHOOK_FILE_MAX_BYTES)));
  assert.equal(at(json, 'properties', 'text').maxLength, MESSAGE_TEXT_MAX); assert.equal(MESSAGE_TEXT_MAX, 4096);
  assert.ok(String(at(doc, 'components', 'schemas', 'InlineKeyboardButton').description).includes(`${CALLBACK_DATA_MAX_BYTES} BYTES`));
});
function bounds(mod = api) {
  const doc = mod.buildBotOpenApi();
  for (const [method, field, minimum, maximum] of [['getUpdates', 'limit', 1, GET_UPDATES_LIMIT_MAX], ['joinVoice', 'bitrate', BOT_VOICE_BITRATE.min, BOT_VOICE_BITRATE.max]] as const) {
    const value = at(request(doc, method), 'properties', field);
    assert.equal(value.minimum, minimum, 'R307 pipe сохраняет нижнюю границу');
    assert.equal(value.maximum, maximum, 'R307 pipe сохраняет верхнюю границу'); assert.equal(value.type, 'integer');
  }
  assert.equal(at(request(doc, 'setWebhook'), 'properties', 'batch').type, 'boolean');
}
it('R307 inputPipeBounds сохраняет integer и обе границы limit/bitrate, форма batch остаётся boolean', () => bounds());
for (const [name, schema, params, field, min, max] of [
  ['getUpdates.limit', wire.getUpdatesParams, {}, 'limit', 1, GET_UPDATES_LIMIT_MAX],
  ['joinVoice.bitrate', wire.joinVoiceParams, { chat_id: 'voice' }, 'bitrate', BOT_VOICE_BITRATE.min, BOT_VOICE_BITRATE.max],
] as const) it(`R307 ${name}: обе границы и строки принимаются, соседние числа и дробь отклоняются`, () => {
  for (const value of [min, max, String(min), String(max)]) assert.equal(schema.safeParse({ ...params, [field]: value }).success, true);
  for (const value of [min - 1, max + 1, min + 0.5, String(min - 1), String(max + 1)]) assert.equal(schema.safeParse({ ...params, [field]: value }).success, false);
});
it('R307 восемь событий доступны в Update и webhook, подпись обязательна, ошибки имеют прежний конверт', () => {
  const doc = api.buildBotOpenApi(), update = at(doc, 'components', 'schemas', 'Update');
  assert.deepEqual(Object.keys(at(update, 'properties')).filter(k => k !== 'update_id'), [...BOT_UPDATE_TYPES]);
  assert.deepEqual((doc['x-events'] as api.Json[]).map(e => object(e).type), [...BOT_UPDATE_TYPES]);
  const hook = at(doc, 'webhooks', 'update', 'post'), header = object((hook.parameters as api.Json[])[0]);
  assert.equal(header.name, 'X-GusVoice-Signature'); assert.equal(header.in, 'header'); assert.equal(header.required, true);
  const alternatives = at(hook, 'requestBody', 'content', 'application/json', 'schema').oneOf as api.Json[];
  assert.deepEqual(deref(doc, object(alternatives[0])), update);
  assert.equal(object(alternatives[1]).type, 'array'); assert.deepEqual(deref(doc, at(alternatives[1], 'items')), update);
  const error = deref(doc, at(doc, 'components', 'responses', 'Unauthorized', 'content', 'application/json', 'schema'));
  assert.equal(at(error, 'properties', 'ok').const, false); assert.ok((error.required as api.Json[]).includes('error_code'));
  assert.ok((error.required as api.Json[]).includes('description')); assert.equal(at(error, 'properties', 'retry_after').type, 'number');
  assert.ok(Object.hasOwn(at(doc, 'components', 'responses', 'TooManyRequests', 'headers'), 'Retry-After'));
});

// Маленький документ из того же стандарта: каждый дефект вносится отдельно, чтобы не прикрыться другим отказом.
function fixture() {
  const req: J = { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['id'] };
  const res: J = { type: 'object', properties: { id: { type: 'string' }, state: { type: 'string', enum: ['a', 'b'] }, ok: { type: 'boolean', const: true } }, required: ['id'] };
  const doc: J = { paths: { '/method': { post: { requestBody: { content: { 'application/json': { schema: req } } }, responses: { '200': { content: { 'application/json': { schema: res } } } } } } }, components: { schemas: {} }, 'x-events': [{ type: 'message' }], 'x-features': ['voice'] };
  return { doc, req, res };
}
type Change = (f: ReturnType<typeof fixture>) => void;
const breaking: { name: string; change: Change; reason: string }[] = [
  { name: 'путь удалён', change: f => { delete at(f.doc, 'paths')['/method']; }, reason: 'POST /method: пропал' },
  { name: 'операция удалена', change: f => { delete at(f.doc, 'paths', '/method').post; }, reason: 'POST /method: пропал' },
  { name: 'свойство ответа удалено', change: f => { delete at(f.res, 'properties').state; }, reason: '/method ответ.state: свойство пропало' },
  { name: 'enum ответа сужен', change: f => { at(f.res, 'properties', 'state').enum = ['a']; }, reason: '/method ответ.state: пропало значение enum "b"' },
  { name: 'enum запроса сужен', change: f => { at(f.req, 'properties', 'mode').enum = ['a']; }, reason: '/method запрос.mode: пропало значение enum "b"' },
  { name: 'тип ответа изменён', change: f => { at(f.res, 'properties', 'id').type = 'number'; }, reason: '/method ответ.id: type "string" → "number"' },
  { name: 'литерал ответа изменён', change: f => { at(f.res, 'properties', 'ok').const = false; }, reason: '/method ответ.ok: const сменился' },
  { name: 'новый обязательный параметр', change: f => { f.req.required = ['id', 'limit']; }, reason: '/method запрос: новое обязательное поле limit' },
  { name: 'минимум запроса вырос', change: f => { at(f.req, 'properties', 'limit').minimum = 2; }, reason: '/method запрос.limit: сужен minimum' },
  { name: 'максимум запроса упал', change: f => { at(f.req, 'properties', 'limit').maximum = 99; }, reason: '/method запрос.limit: сужен maximum' },
  { name: 'обязательное поле ответа стало необязательным', change: f => { f.res.required = []; }, reason: '/method ответ: поле id перестало быть обязательным' },
  { name: 'событие удалено', change: f => { f.doc['x-events'] = []; }, reason: 'событие message пропало' },
  { name: 'feature удалён', change: f => { f.doc['x-features'] = []; }, reason: 'x-features: пропало voice' },
];
function compatCase(c: typeof breaking[number], mod = api) {
  const old = fixture(), next = fixture();
  assert.deepEqual(plain(mod.botOpenApiBreaks(old.doc, next.doc)), []);
  c.change(next); assert.equal(mod.botOpenApiBreaks(old.doc, next.doc).includes(c.reason), true, `R307 совместимость: ${c.name}`);
}
for (const c of breaking) it(`R307 совместимость запрещает: ${c.name}`, () => compatCase(c));
const additions: { name: string; change: Change }[] = [
  { name: 'метод', change: f => { at(f.doc, 'paths')['/new'] = at(f.doc, 'paths', '/method'); } },
  { name: 'поле ответа', change: f => { at(f.res, 'properties').extra = { type: 'string' }; } },
  { name: 'необязательный параметр', change: f => { at(f.req, 'properties').extra = { type: 'string' }; } },
  { name: 'расширенный enum и лимит', change: f => { at(f.req, 'properties', 'mode').enum = ['a', 'b', 'c']; at(f.req, 'properties', 'limit').minimum = 0; at(f.req, 'properties', 'limit').maximum = 101; } },
  { name: 'снятие обязательности параметра', change: f => { f.req.required = []; } },
  { name: 'событие и feature', change: f => { (f.doc['x-events'] as api.Json[]).push({ type: 'voice_state' }); (f.doc['x-features'] as api.Json[]).push('openapi'); } },
];
for (const c of additions) it(`R307 совместимость разрешает: ${c.name}`, () => {
  const old = fixture(), next = fixture(); c.change(next); assert.deepEqual(api.botOpenApiBreaks(old.doc, next.doc), []);
});
it('R307 совместимость обходит ссылки в массивах и недостижимые из методов схемы событий', () => {
  const old = fixture(), next = fixture();
  for (const f of [old, next]) {
    at(f.doc, 'components', 'schemas').Event = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
    at(f.res, 'properties').items = { type: 'array', items: { $ref: '#/components/schemas/Event' } };
    at(f.doc, 'components', 'schemas').Unreachable = { type: 'object', properties: { text: { type: 'string' } } };
  }
  assert.deepEqual(api.botOpenApiBreaks(old.doc, next.doc), []);
  delete at(next.doc, 'components', 'schemas', 'Event', 'properties').id;
  delete at(next.doc, 'components', 'schemas', 'Unreachable', 'properties').text;
  assert.ok(api.botOpenApiBreaks(old.doc, next.doc).includes('/method ответ.items[].id: свойство пропало'));
  assert.ok(api.botOpenApiBreaks(old.doc, next.doc).includes('схема Unreachable.text: свойство пропало'));
});
it('R307 одинаковое имя компонента принимается при одинаковой форме и отвергается при разном input/output', () => {
  for (const different of [false, true]) {
    const component = z.object({ value: different ? z.string().default('default') : z.string() }).meta({ id: 'R307Collision' });
    const schema = z.object({ child: component });
    const registry = { ...spec, BOT_METHOD_SPECS: [...spec.BOT_METHOD_SPECS, { name: 'collisionProbe', since: 4 as const, tag: 'bot' as const, params: schema, result: schema }] };
    const mod = loadOpenApi(undefined, registry);
    if (!different) assert.ok(mod.buildBotOpenApi());
    else assert.throws(() => mod.buildBotOpenApi(), e => e instanceof Error && e.message === 'botOpenApi: схема R307Collision во входном и выходном режиме различается');
  }
});

const mutants: { name: string; edit: Edit; check(mod: typeof api): void; marker: string }[] = [
  { name: 'pipeBounds выключен', edit: { from: "...(io === 'input' ? { override: inputPipeBounds } : {}),", to: '' }, check: bounds, marker: 'R307 pipe сохраняет нижнюю границу' },
  { name: 'ссылки defs не переписаны', edit: { from: "out[k] = SCHEMAS + v.slice('#/$defs/'.length);", to: 'out[k] = v;' }, check: refs, marker: 'R307 ссылки направлены в components' },
  { name: 'проверка исчезнувшего свойства отключена', edit: { from: 'if (!(k in bp)) out.push(`${at}.${k}: свойство пропало`);', to: 'if (!(k in bp)) { /* lost property ignored */ }' }, check: mod => compatCase(breaking[2], mod), marker: 'R307 совместимость: свойство ответа удалено' },
  { name: 'расширение required запроса игнорируется', edit: { from: 'for (const k of br) if (!ar.has(k)) out.push(`${at}: новое обязательное поле ${String(k)}`);', to: '/* required ignored */' }, check: mod => compatCase(breaking[7], mod), marker: 'R307 совместимость: новый обязательный параметр' },
];
for (const m of mutants) it(`R307 контрфакт генератора: ${m.name}`, () => {
  m.check(api); m.check(loadOpenApi()); assert.throws(() => m.check(loadOpenApi(m.edit)), assertion(m.marker));
});
it('R307 контрфакт: обязательный chat_id исчез из генерируемого запроса', () => {
  required(); required(loadOpenApi());
  const w = loadWire({ from: '  chat_id: id,\n  text: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).optional(),', to: '  chat_id: id.optional(),\n  text: z.string().max(MESSAGE_TEXT_MAX, TEXT_TOO_LONG).optional(),' });
  assert.throws(() => required(loadOpenApi(undefined, loadSpec(undefined, w), w)), assertion('R307 chat_id обязателен'));
});
