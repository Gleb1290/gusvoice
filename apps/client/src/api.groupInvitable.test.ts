import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type ApiModule = typeof import('./api');
type GroupError = Error & { status?: number; reason?: string; userIds?: string[] };
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const refused = ['shadow-a', 'shadow-b'];

function fixture(body: unknown, status = 403, raw = source) {
  const requests: { url: string; init: RequestInit }[] = [];
  const unused = () => assert.fail('неописанная IO-граница API приглашения');
  const dependencies: Record<string, unknown> = {
    './bgGateways': { mirrorToBg: unused },
    './config': {
      config: { apiUrl: 'https://api.example.test' }, activeInstance: () => null, activeInstanceId: () => null,
      instances: () => [], updateActiveInstance: unused, updateInstance: unused,
    },
    './imageSize': { measureMediaFile: unused },
  };
  const module = { exports: {} };
  // Исполняется весь api.ts и настоящий activeTransport; подменён только ответ fetch и реестр входов.
  runInNewContext(ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, URL, Response, Headers, AbortSignal, Error, TypeError,
    localStorage: { getItem: (key: string) => { assert.equal(key, 'gv_token'); return null; }, setItem: unused, removeItem: unused },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    },
    require: (id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), `явный импорт api.ts: ${id}`);
      return dependencies[id];
    },
  });
  return { api: (module.exports as ApiModule).api, requests };
}

async function failure(body: Record<string, unknown>, raw = source): Promise<GroupError> {
  const f = fixture(body, 403, raw);
  let caught: GroupError | undefined;
  await assert.rejects(f.api.convAddMembers('group-e7', refused), (error: unknown) => {
    assert.ok(error instanceof Error, 'отказ возвращает Error, а не произвольный объект');
    caught = error as GroupError;
    assert.equal(caught.message, 'group_not_invitable');
    assert.equal(caught.status, 403);
    return true;
  });
  assert.equal(f.requests.length, 1, 'ручка приглашения вызвана один раз');
  assert.equal(f.requests[0].url, 'https://api.example.test/api/conv/group-e7/members');
  assert.equal(f.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.requests[0].init.body as string), { userIds: refused });
  assert.equal(Object.hasOwn(f.requests[0].init.headers!, 'Authorization'), false, 'фикстура не использует реальный вход');
  return caught!;
}

async function filtered(raw = source) {
  const error = await failure({ error: 'group_not_invitable', reason: 'group_not_invitable', userIds: ['shadow-a', 5, null, {}, ['nested'], false, 'shadow-b'] }, raw);
  assert.equal(error.reason, 'group_not_invitable', 'машинная причина сохраняется вместе со списком');
  // VM создаёт массив в другом realm: форма JSON отделяет данные от прототипа.
  assert.deepEqual(error.userIds === undefined ? undefined : JSON.parse(JSON.stringify(error.userIds)), refused,
    'ошибка сохраняет только строковые userIds');
}

// Нестрочный id из ответа сервера не должен подмешать произвольный объект в выбор инстансов для тоста.
it('R206 API приглашения сохраняет только строковые userIds, статус и причину отказа', async () => { await filtered(); });

// Отсутствующий/неверный список означает общий отказ, а не выдуманный список пользователей.
it('R206 API без массива userIds не создаёт это поле на ошибке', async () => {
  for (const extra of [{}, { userIds: null }, { userIds: 'shadow-a' }, { userIds: 5 }, { userIds: { id: 'shadow-a' } }]) {
    const error = await failure({ error: 'group_not_invitable', ...extra });
    assert.equal(Object.hasOwn(error, 'userIds'), false, 'нет массива — нет собственного поля userIds');
  }
});

// Пустой массив — допустимый общий отказ: его нельзя превратить в отсутствие ошибки или потерять форму ответа.
it('R206 API сохраняет пустой и очищенный от мусора массив userIds', async () => {
  for (const userIds of [[], [null, 5, {}, false]]) {
    const error = await failure({ error: 'group_not_invitable', userIds });
    assert.equal(Object.hasOwn(error, 'userIds'), true);
    assert.deepEqual(JSON.parse(JSON.stringify(error.userIds)), []);
  }
});

// Парное принятие гарантирует, что фильтрация ошибок не превращает успешный pending-ответ в отказ или новый DTO.
it('R206 API успешного приглашения отдаёт pending-ответ как есть', async () => {
  const body = { ok: true, pending: true, userIds: ['shadow-a', 5] };
  const f = fixture(body, 200);
  assert.deepEqual(await f.api.convAddMembers('group-e7', refused), body);
  assert.equal(f.requests.length, 1);
});

// Оригинал проходит ту же наблюдаемую проверку; loader/тип/таймаут не считаются обнаружением регрессии.
for (const [name, replacement] of [
  ['потерян список отказанных', 'if (Array.isArray(userIds)) void userIds;'],
  ['отключена фильтрация нестрочных id', 'if (Array.isArray(userIds)) (err as Error & { userIds?: string[] }).userIds = userIds as string[];'],
] as const) it(`R206 API контрфакт: ${name}`, async () => {
  await filtered();
  const anchor = "if (Array.isArray(userIds)) (err as Error & { userIds?: string[] }).userIds = userIds.filter((x): x is string => typeof x === 'string');";
  assert.equal(source.split(anchor).length - 1, 1, 'единственный якорь присваивания userIds');
  await assert.rejects(filtered(source.replace(anchor, replacement)),
    (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith('ошибка сохраняет только строковые userIds')
      && error.expected === refused);
});
