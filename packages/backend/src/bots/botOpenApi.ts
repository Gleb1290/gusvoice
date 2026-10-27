/**
 * OpenAPI 3.1 для Bot API v1 (этап 5, #233) — ЧИСТАЯ детерминированная функция над реестром `botSpec.ts`: без ввода-вывода,
 * без дат и версий сборки, ключи в порядке реестра. Её результат отдаёт инстанс (`botOpenApiRoute.ts`) и пишет в репозиторий
 * `scripts/gen-bot-api.mts` (`docs/bot-api/openapi.json`, страж `--check` в CI).
 *
 * Схемы — `z.toJSONSchema` (zod 4) из тех же схем, которыми сервер разбирает параметры: параметры — режим `input` (флаги и
 * числа из формы/строки запроса — `boolean`/`integer`), ответы — `output`. Схемы с `.meta({ id })` уходят в
 * `components.schemas`, ссылки `#/$defs/X` переписываются в `#/components/schemas/X`. Шум zod вычищается: `$schema`, границы
 * ±`Number.MAX_SAFE_INTEGER` у целых, `additionalProperties: false` у ответов (v1 растёт добавлением полей — клиент не должен
 * считать новое поле ошибкой; сервер и в запросе лишние поля молча срезает, zod во входном режиме их не запрещает).
 *
 * `botOpenApiBreaks(old, new)` — проверка совместимости (правило 11 CLAUDE.md): что из старого документа потеряно в новом.
 */
import { z } from 'zod';
import { GET_UPDATES_TIMEOUT_MAX, BOT_API_FEATURES, BOT_API_VERSION, BOT_UPDATE_TYPES } from './botRules.js';
import { BOT_EVENT_SPECS, BOT_METHOD_SPECS, BOT_METHOD_TAGS, type BotMethodSpec } from './botSpec.js';
import { wireError, wireUpdate } from './botWire.js';
import { WEBHOOK_FILE_MAX_BYTES, WEBHOOK_FILES_MAX } from '../webhookRules.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type OpenApiDoc = JsonObject & { openapi: '3.1.0'; paths: JsonObject; components: JsonObject };

const SCHEMAS = '#/components/schemas/';
const SAFE = Number.MAX_SAFE_INTEGER;
/** Ответы-ошибки в `components.responses` (имя → код, описание). 409/415 — только у методов, которые их отдают. */
const ERRORS: readonly [code: string, name: string, description: string][] = [
  ['400', 'BadRequest', 'Bad Request: invalid parameters or the action is not allowed in this chat.'],
  ['401', 'Unauthorized', 'Unauthorized: the token is missing, malformed, revoked, or the bot is disabled.'],
  ['403', 'Forbidden', 'Forbidden: the bot has no access to this chat or the user blocked it.'],
  ['404', 'NotFound', 'Not Found: unknown method, chat, or message.'],
  ['409', 'Conflict', 'Conflict: a webhook is set or another consumer (getUpdates / WebSocket) took over the update queue.'],
  ['415', 'UnsupportedMediaType', 'This file type is not allowed (SVG/HTML).'],
  ['429', 'TooManyRequests', 'Too Many Requests: wait `retry_after` seconds (also in the `Retry-After` header) and repeat.'],
];

type Io = 'input' | 'output';

/** Собирает `components.schemas`: одно имя — одна схема; вход и выход обязаны совпасть после чистки, иначе это ошибка генератора. */
class Components {
  readonly schemas = new Map<string, Json>();
  add(name: string, schema: Json): void {
    const prev = this.schemas.get(name);
    if (prev === undefined) this.schemas.set(name, schema);
    else if (JSON.stringify(prev) !== JSON.stringify(schema)) throw new Error(`botOpenApi: схема ${name} во входном и выходном режиме различается`);
  }
}

/** Рекурсивная чистка: ссылки на `components`, без безопасных границ zod, у ответов — без `additionalProperties: false`. */
function tidy(node: unknown, io: Io): Json {
  if (Array.isArray(node)) return node.map((x) => tidy(x, io));
  if (node === null || typeof node !== 'object') return node as Json;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')) {
      out[k] = SCHEMAS + v.slice('#/$defs/'.length);
      continue;
    }
    if ((k === 'minimum' && v === -SAFE) || (k === 'maximum' && v === SAFE)) continue;
    if (k === 'additionalProperties' && v === false && io === 'output') continue;
    out[k] = tidy(v, io);
  }
  return out;
}

type ZodInternals = { _zod: { def: { type: string; in?: ZodInternals; out?: ZodInternals } } };
const BOUNDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'enum'];

/**
 * `int.pipe(z.number().min(1).max(100))` (`limit`, `bitrate`): во входном режиме zod берёт левую часть трубы (`int` — целое
 * без границ) и теряет границы правой. Возвращаем их: тип остаётся `integer`, границы — из правой части.
 */
function inputPipeBounds(ctx: { zodSchema: unknown; jsonSchema: Record<string, unknown> }): void {
  const def = (ctx.zodSchema as ZodInternals)._zod.def;
  if (def.type !== 'pipe' || !def.in || !def.out) return;
  const inner = def.in._zod.def;
  if (inner.type !== 'pipe' || inner.in?._zod.def.type !== 'transform') return;
  const right = z.toJSONSchema(def.out as unknown as z.ZodType, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  for (const k of BOUNDS) if (k in right) ctx.jsonSchema[k] = right[k];
}

function convert(schema: z.ZodType, io: Io, comps: Components): Json {
  const raw = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    ...(io === 'input' ? { override: inputPipeBounds } : {}),
  }) as Record<string, unknown>;
  const { $defs, ...rest } = raw;
  for (const [name, def] of Object.entries(($defs ?? {}) as Record<string, unknown>)) comps.add(name, tidy(def, io));
  return tidy(rest, io);
}

const ref = (name: string): JsonObject => ({ $ref: SCHEMAS + name });
const errorRef = (name: string): JsonObject => ({ $ref: `#/components/responses/${name}` });

const PARAMS_NOTE =
  'Parameters may be sent as JSON, as `application/x-www-form-urlencoded`, or as a query string with `GET` ' +
  '(method names are case-insensitive). In a form or a query string booleans and integers are accepted as strings ' +
  '(`"true"`/`"1"`, `"5"`), arrays and objects (`reply_markup`, `embeds`, `commands`, …) — as JSON strings.';

function operation(spec: BotMethodSpec, comps: Components): JsonObject {
  const op: JsonObject = {
    operationId: spec.name,
    tags: [spec.tag],
    'x-since-api': spec.since,
    ...(spec.longPoll ? { description: `Long polling: the request is held up to \`timeout\` seconds (at most ${GET_UPDATES_TIMEOUT_MAX}).` } : {}),
    security: [{ botToken: [] }],
  };
  if (spec.params) {
    const params = convert(spec.params, 'input', comps) as JsonObject;
    const required = Array.isArray(params.required) && params.required.length > 0;
    const content: JsonObject = { 'application/json': { schema: params } };
    if (spec.multipart) {
      const props = (params.properties ?? {}) as JsonObject;
      content['multipart/form-data'] = {
        schema: {
          ...params,
          properties: {
            ...props,
            'files[0]': {
              type: 'string',
              contentMediaType: 'application/octet-stream',
              description:
                `Files: fields \`files[0]\` … (or \`file\`, \`file1\` …), at most ${WEBHOOK_FILES_MAX} files, each up to ${WEBHOOK_FILE_MAX_BYTES} bytes. ` +
                'Other fields are strings; `embeds` and `reply_markup` — JSON strings. An embed image may point to an uploaded file as `attachment://<file name>`.',
            },
          },
        },
      };
    }
    op.requestBody = { required, content };
  }
  const responses: JsonObject = {
    '200': {
      description: 'OK',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean', const: true }, result: convert(spec.result, 'output', comps) },
            required: ['ok', 'result'],
          },
        },
      },
    },
  };
  for (const [code, name] of ERRORS) {
    if (code === '409' && !spec.longPoll) continue;
    if (code === '415' && !spec.multipart) continue;
    responses[code] = errorRef(name);
  }
  op.responses = responses;
  return op;
}

/** Документ целиком. Вызов дважды даёт байт-в-байт одинаковый `JSON.stringify`. */
export function buildBotOpenApi(): OpenApiDoc {
  const comps = new Components();
  const paths: JsonObject = {};
  for (const spec of BOT_METHOD_SPECS) paths[`/bot/v1/${spec.name}`] = { post: operation(spec, comps) };

  const update = convert(wireUpdate, 'output', comps);
  const error = convert(wireError, 'output', comps);
  const events: Json[] = BOT_EVENT_SPECS.map((e) => ({ type: e.type, since: e.since, schema: convert(e.schema, 'output', comps) }));
  if (BOT_EVENT_SPECS.map((e) => e.type).join() !== BOT_UPDATE_TYPES.join()) throw new Error('botOpenApi: BOT_EVENT_SPECS ≠ BOT_UPDATE_TYPES');

  const responses: JsonObject = {};
  for (const [code, name, description] of ERRORS) {
    responses[name] = {
      description,
      ...(code === '429'
        ? { headers: { 'Retry-After': { description: 'Seconds to wait before repeating the request.', schema: { type: 'integer', minimum: 0 } } } }
        : {}),
      content: { 'application/json': { schema: error } },
    };
  }

  const usedTags = new Set(BOT_METHOD_SPECS.map((s) => s.tag));
  const schemas: JsonObject = {};
  for (const name of [...comps.schemas.keys()].sort()) schemas[name] = comps.schemas.get(name)!;

  return {
    openapi: '3.1.0',
    info: {
      title: 'GusVoice Bot API',
      version: `1.${BOT_API_VERSION}.0`,
      description:
        'HTTP API for GusVoice bots (Telegram-style). Every method is `POST /api/bot/v1/<method>` with the header ' +
        '`Authorization: Bot <token>`; the answer is `{ "ok": true, "result": … }` or `{ "ok": false, "error_code", "description", "retry_after"? }`. ' +
        'v1 changes only by additions: new fields, methods and events may appear — ignore what you do not know. ' +
        'Check `getMe.api_version` and `getMe.features` for what this server supports. ' +
        PARAMS_NOTE,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    'x-api-version': BOT_API_VERSION,
    'x-features': [...BOT_API_FEATURES],
    servers: [{ url: '/api', description: 'Relative to the instance that served this document; for a saved copy use the `apiUrl` of your instance (from `/config.json`) + `/api`.' }],
    tags: BOT_METHOD_TAGS.filter((t) => usedTags.has(t)).map((name) => ({ name })),
    paths,
    webhooks: {
      update: {
        post: {
          summary: 'Delivery of updates to the bot address (setWebhook)',
          description:
            'The server POSTs updates to the address from `setWebhook`. Verify the signature header before trusting the body: ' +
            '`v1 = HEX(HMAC-SHA256(key = secret_token, data = t + "." + raw request body))`, and `|now − t| ≤ 300` seconds. ' +
            'With `batch` the body is an array of updates. Any 2xx acknowledges the delivery.',
          parameters: [
            { name: 'X-GusVoice-Signature', in: 'header', required: true, schema: { type: 'string', pattern: '^t=\\d+,v1=[0-9a-f]{64}$' }, description: '`t=<unix time>,v1=<hex>`' },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { oneOf: [update, { type: 'array', items: update, minItems: 1 }] } } },
          },
          responses: { '200': { description: 'Delivered (any 2xx).' } },
        },
      },
    },
    'x-events': events,
    components: {
      securitySchemes: {
        botToken: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Value `Bot gvb_…` — the bot token after the word `Bot`.' },
      },
      responses,
      schemas,
    },
  };
}

// ─── Совместимость ───────────────────────────────────────────────────────────────────────────────────────────────────

type Ctx = 'req' | 'res';
const NARROW_UP = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'];
const NARROW_DOWN = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'];

function obj(x: Json | undefined): JsonObject | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x : null;
}
function resolve(doc: JsonObject, node: JsonObject): [JsonObject | null, string | null] {
  const r = node.$ref;
  if (typeof r !== 'string' || !r.startsWith(SCHEMAS)) return [node, null];
  const name = r.slice(SCHEMAS.length);
  return [obj(obj(obj(doc.components)?.schemas)?.[name]), name];
}

/**
 * Что новый документ ЛОМАЕТ относительно старого (пусто — совместим). Ломает: пропал путь или операция; у объекта пропало
 * свойство; пропало значение `enum`; сменился `type`/`const`; в запросе — новое обязательное поле или сужен предел; в ответе —
 * обязательное поле стало необязательным; пропало событие или пункт `x-features`. Добавления — не поломка.
 */
export function botOpenApiBreaks(oldDoc: JsonObject, newDoc: JsonObject): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (a0: JsonObject, b0: JsonObject, at: string, ctx: Ctx): void => {
    const [a, an] = resolve(oldDoc, a0);
    const [b, bn] = resolve(newDoc, b0);
    if (!a) return;
    if (!b) return void out.push(`${at}: схема ${bn ?? '?'} пропала`);
    if (an) {
      const key = `${ctx}:${an}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (JSON.stringify(a.type) !== JSON.stringify(b.type) && a.type !== undefined) out.push(`${at}: type ${JSON.stringify(a.type)} → ${JSON.stringify(b.type)}`);
    if ('const' in a && JSON.stringify(a.const) !== JSON.stringify(b.const)) out.push(`${at}: const сменился`);
    if (Array.isArray(a.enum)) {
      const nb = new Set((Array.isArray(b.enum) ? b.enum : []).map((x) => JSON.stringify(x)));
      for (const v of a.enum) if (!nb.has(JSON.stringify(v))) out.push(`${at}: пропало значение enum ${JSON.stringify(v)}`);
    }
    const ap = obj(a.properties) ?? {};
    const bp = obj(b.properties) ?? {};
    for (const k of Object.keys(ap)) {
      if (!(k in bp)) out.push(`${at}.${k}: свойство пропало`);
      else walk(obj(ap[k]) ?? {}, obj(bp[k]) ?? {}, `${at}.${k}`, ctx);
    }
    const ar = new Set(Array.isArray(a.required) ? a.required : []);
    const br = new Set(Array.isArray(b.required) ? b.required : []);
    if (ctx === 'req') {
      for (const k of br) if (!ar.has(k)) out.push(`${at}: новое обязательное поле ${String(k)}`);
      for (const k of NARROW_UP) if (typeof b[k] === 'number' && (typeof a[k] !== 'number' || (b[k] as number) > (a[k] as number))) out.push(`${at}: сужен ${k}`);
      for (const k of NARROW_DOWN) if (typeof b[k] === 'number' && (typeof a[k] !== 'number' || (b[k] as number) < (a[k] as number))) out.push(`${at}: сужен ${k}`);
    } else {
      for (const k of ar) if (!br.has(k)) out.push(`${at}: поле ${String(k)} перестало быть обязательным`);
    }
    if (obj(a.items) && obj(b.items)) walk(a.items as JsonObject, b.items as JsonObject, `${at}[]`, ctx);
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const aa = Array.isArray(a[key]) ? (a[key] as Json[]) : [];
      const bb = Array.isArray(b[key]) ? (b[key] as Json[]) : [];
      aa.forEach((x, i) => {
        if (i >= bb.length) out.push(`${at}.${key}[${i}]: вариант пропал`);
        else walk(obj(x) ?? {}, obj(bb[i]) ?? {}, `${at}.${key}[${i}]`, ctx);
      });
    }
  };

  const op = (doc: JsonObject, path: string, method: string): JsonObject | null => obj(obj(obj(doc.paths)?.[path])?.[method]);
  for (const [path, item] of Object.entries(obj(oldDoc.paths) ?? {})) {
    for (const method of Object.keys(obj(item) ?? {})) {
      const a = op(oldDoc, path, method)!;
      const b = op(newDoc, path, method);
      if (!b) {
        out.push(`${method.toUpperCase()} ${path}: пропал`);
        continue;
      }
      const aBody = obj(obj(obj(obj(a.requestBody)?.content)?.['application/json'])?.schema);
      const bBody = obj(obj(obj(obj(b.requestBody)?.content)?.['application/json'])?.schema);
      if (aBody) walk(aBody, bBody ?? {}, `${path} запрос`, 'req');
      else if (bBody && Array.isArray(bBody.required) && bBody.required.length) out.push(`${path} запрос: появились обязательные параметры`);
      const res = (d: JsonObject) => obj(obj(obj(obj(obj(d.responses)?.['200'])?.content)?.['application/json'])?.schema);
      const aRes = res(a);
      if (aRes) walk(aRes, res(b) ?? {}, `${path} ответ`, 'res');
    }
  }
  // Схемы, которые не достижимы из путей (события): сверить как ответы.
  for (const name of Object.keys(obj(obj(oldDoc.components)?.schemas) ?? {})) walk(ref(name), ref(name), `схема ${name}`, 'res');
  const list = (d: JsonObject, k: string): string[] => (Array.isArray(d[k]) ? (d[k] as Json[]).map((x) => (typeof x === 'string' ? x : String(obj(x)?.type))) : []);
  const newEvents = new Set(list(newDoc, 'x-events'));
  for (const t of list(oldDoc, 'x-events')) if (!newEvents.has(t)) out.push(`событие ${t} пропало`);
  const newFeatures = new Set(list(newDoc, 'x-features'));
  for (const f of list(oldDoc, 'x-features')) if (!newFeatures.has(f)) out.push(`x-features: пропало ${f}`);
  return out;
}
