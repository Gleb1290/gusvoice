import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as shared from '@gusvoice/shared';
import { z, ZodError } from 'zod';
import ts from 'typescript';
import * as attachmentRules from './attachmentRules.js';
import * as convRules from './convRules.js';
import * as gifRules from './gifRules.js';
import * as scheduleRules from './scheduleRules.js';

type File = 'att' | 'conv' | 'gifs' | 'uploads';
type Result = { success: true; data: unknown } | { success: false; error: ZodError };
type Handler = (req: unknown, reply: unknown) => Promise<unknown>;
type RouteModule = Record<string, unknown>;
type Site = {
  name: string; file: File; guidIndex: number; field: string;
  route?: string; exportName?: string; input: (value: unknown) => unknown;
  location?: 'body' | 'params';
};

const sources = Object.fromEntries((['att', 'conv', 'gifs', 'uploads'] as const).map(file => [
  file, readFileSync(new URL(`./routes/${file}.ts`, import.meta.url), 'utf8'),
])) as Record<File, string>;

const sites: readonly Site[] = [
  { name: 'convAttachmentRefsSchema.id', file: 'att', guidIndex: 0, field: 'id', input: id => [{ id }] },
  { name: 'POST /conv/:id/messages clientId', file: 'conv', guidIndex: 0, field: 'clientId',
    route: 'post /conv/:id/messages', exportName: 'convRoutes', location: 'body', input: clientId => ({ clientId, content: 'текст' }) },
  { name: 'POST /conv/:id/forward clientId', file: 'conv', guidIndex: 1, field: 'clientId',
    route: 'post /conv/:id/forward', exportName: 'convRoutes', location: 'body',
    input: clientId => ({ clientId, fromConversationId: 'source', messageIds: ['message'] }) },
  { name: 'POST /conv/:id/scheduled clientId', file: 'conv', guidIndex: 2, field: 'clientId',
    route: 'post /conv/:id/scheduled', exportName: 'convRoutes', location: 'body',
    input: clientId => ({ clientId, content: 'текст', whenOnline: true }) },
  { name: 'DELETE /gifs/:id idParam.id', file: 'gifs', guidIndex: 0, field: 'id',
    route: 'delete /gifs/:id', exportName: 'gifRoutes', location: 'params', input: id => ({ id }) },
  { name: 'POST /gifs attachmentId', file: 'gifs', guidIndex: 1, field: 'attachmentId',
    route: 'post /gifs', exportName: 'gifRoutes', location: 'body', input: attachmentId => ({ attachmentId }) },
  { name: 'GET /conv/:id/uploads/:uploadId uploadParams.uploadId', file: 'uploads', guidIndex: 0, field: 'uploadId',
    route: 'get /conv/:id/uploads/:uploadId', exportName: 'uploadRoutes', location: 'params', input: uploadId => ({ id: 'conv', uploadId }) },
];

// Синтетические значения, не id пользователей: старые клиенты принимали форму, а не RFC version/variant.
const legacy = [
  '12345678-1234-0234-1234-123456789abc',
  '12345678-1234-1234-1234-123456789abc',
  '12345678-1234-0234-9234-123456789abc',
];
const uuid4 = '12345678-abcd-4234-9234-123456789abc';
const accepted = [...legacy, uuid4, ...[...legacy, uuid4].map(id => id.toUpperCase())];
const rejected: readonly unknown[] = [
  '', ' ', ` ${uuid4}`, `${uuid4} `, `${uuid4}\n`, uuid4.replaceAll('-', ''),
  '12345678-1234-1234-1234-123456789ab', '12345678-1234-1234-1234-123456789abcd',
  '12345678-1234-1234-1234-123456789abg', '1234567-12345-1234-1234-123456789abc',
  123, null, undefined, true, {}, [],
];

class Parsed extends Error {
  constructor(readonly input: unknown, readonly result: Result) { super('остановка после настоящей схемы'); }
}

function fixture(overrides: Partial<Record<File, string>> = {}) {
  let activeInput: unknown;
  let watching = false;
  let reached = 0;
  // Это не копия схемы: object строится настоящим Zod, parse сначала разбирает вход настоящей схемой.
  // Затем останавливаем handler ДО SQL/Redis/хранилища. Вложенные object не остановят внешнюю схему:
  // Zod читает их внутренний parser, а перехват привязан к точной ссылке req.body/req.params.
  const watchedZod = new Proxy(z, { get(target, key, receiver) {
    if (key !== 'object') return Reflect.get(target, key, receiver);
    return (...args: Parameters<typeof z.object>) => {
      const schema = z.object(...args);
      const parse = schema.parse.bind(schema);
      Object.defineProperty(schema, 'parse', { value: (input: unknown) => {
        if (!watching || input !== activeInput) return parse(input);
        reached++;
        let result: Result;
        try { result = { success: true, data: parse(input) }; }
        catch (error) {
          if (!(error instanceof ZodError)) throw error;
          result = { success: false, error };
        }
        throw new Parsed(input, result);
      } });
      return schema;
    };
  } });

  // Закрытый список границ. Их модули вообще НЕ импортируются, даже env/db/schema.
  // Любой вызов заглушки — ошибка харнесса, не успешная проверка отказа Zod.
  const dormant = (id: string): RouteModule => new Proxy({}, { get: (_target, key) => () => {
    throw new Error(`неожиданный вызов границы ${id}.${String(key)}`);
  } });
  const deps: Record<string, unknown> = Object.fromEntries([
    'drizzle-orm', '../auth.js', '../guestGuard.js', '../stickerCatalog.js', '../blockRules.js', '../blocks.js',
    '../conversations.js', '../convSendFanout.js', '../dmReports.js', '../strangerRules.js', '../scheduled.js',
    '../contacts.js', '../contactRules.js', '../db/index.js', '../realtime.js', './dmFolders.js', '../db/peerQueries.js',
    '../lastSeen.js', '../db/schema.js', '../dmRules.js', '../instanceSetup.js', '../userSearchRules.js', '../push.js',
    '../superAdminRules.js', '../attachments.js', '../storage.js', '../env.js', '../gifs.js', '../bigUploads.js', '../uploadGate.js',
  ].map(id => [id, dormant(id)]));
  Object.assign(deps, {
    '@gusvoice/shared': shared, zod: { z: watchedZod }, '../attachmentRules.js': attachmentRules,
    '../convRules.js': convRules, '../gifRules.js': gifRules, '../scheduleRules.js': scheduleRules,
    // Только GIF вызывает limiter ДО схемы; он пропускает, ничего не читая из Redis.
    '../authGuard.js': { ...dormant('../authGuard.js'), rateHit: async () => 0 },
  });
  const modules = new Map<File, RouteModule>();
  const load = (file: File): RouteModule => {
    const cached = modules.get(file);
    if (cached) return cached;
    const module: { exports: RouteModule } = { exports: {} };
    modules.set(file, module.exports);
    // Транспилируется и исполняется ВЕСЬ маршрут, без eval вырезанных выражений/обработчиков.
    runInNewContext(ts.transpileModule(overrides[file] ?? sources[file], { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, { module, exports: module.exports, require: (id: string) => {
      if (id === './att.js') return load('att');
      if (id === './conv.js') return load('conv');
      assert.ok(Object.hasOwn(deps, id), `неописанный импорт маршрута ${id}`);
      return deps[id];
    } }, { filename: `routes/${file}.ts` });
    return module.exports;
  };
  const handlers = new Map<string, Handler>();
  const registered = new Set<string>();
  const app: Record<string, unknown> = {
    addHook: () => {}, addContentTypeParser: () => {},
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head']) {
    app[method] = (path: string, ...args: unknown[]) => {
      const key = `${method} ${path}`;
      assert.ok(!handlers.has(key), `двойная регистрация ${key}`);
      const handler = args.at(-1);
      assert.equal(typeof handler, 'function', key);
      handlers.set(key, handler as Handler);
    };
  }

  return async (site: Site, value: unknown): Promise<Result> => {
    const routeModule = load(site.file);
    const input = site.input(value);
    if (site.file === 'att') {
      return (routeModule.convAttachmentRefsSchema as z.ZodType).safeParse(input);
    }
    if (!registered.has(site.exportName!)) {
      await (routeModule[site.exportName!] as (app: unknown) => Promise<void>)(app);
      registered.add(site.exportName!);
    }
    const handler = handlers.get(site.route!);
    assert.ok(handler, `настоящий маршрут зарегистрирован: ${site.name}`);
    const request = { user: { sub: 'tester' }, params: { id: 'conv' }, body: {}, [site.location!]: input };
    activeInput = input; watching = true; reached = 0;
    try {
      await handler(request, {});
      assert.fail(`маршрут не достиг схемы ${site.name}`);
    } catch (error) {
      if (!(error instanceof Parsed)) throw error;
      assert.equal(error.input, input, `проверена именно входная ссылка ${site.name}`);
      assert.equal(reached, 1, `достигнута одна адресная схема ${site.name}`);
      return error.result;
    } finally { watching = false; activeInput = undefined; }
  };
}

function stricterGuid(site: Site): string {
  const source = sources[site.file];
  const tree = ts.createSourceFile(`${site.file}.ts`, source, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(tree) === 'z' && node.expression.name.text === 'guid') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(calls.length, sites.filter(item => item.file === site.file).length, 'все guid маршрута учтены');
  const call = calls[site.guidIndex];
  assert.ok(call, `найден адресный guid ${site.name}`);
  const parent = call.parent;
  assert.ok(ts.isPropertyAssignment(parent), 'guid — непосредственно схема нужного поля');
  assert.equal(parent.name.getText(tree), site.field);
  return source.slice(0, call.getStart(tree)) + 'z.string().uuid()' + source.slice(call.end);
}

async function accepts(probe: ReturnType<typeof fixture>, site: Site, value: unknown) {
  const result = await probe(site, value);
  assert.equal(result.success, true, `совместимость ${site.name}: ${String(value)}`);
  if (result.success) {
    const data = result.data as Record<string, unknown> | Record<string, unknown>[];
    assert.equal((Array.isArray(data) ? data[0] : data)[site.field], value, 'id сохраняется без нормализации');
  }
}

for (const site of sites) {
  it(`R289 ${site.name}: legacy, UUID4 и uppercase проходят, неверная форма отвергается Zod`, async () => {
    const probe = fixture();
    for (const value of accepted) await accepts(probe, site, value);
    for (const value of rejected) {
      const result = await probe(site, value);
      assert.equal(result.success, false, `${site.name} отклоняет ${String(value)}`);
      if (!result.success) {
        assert.ok(result.error instanceof ZodError, 'отказ настоящего Zod, не исключение зависимости');
        assert.deepEqual(result.error.issues.map(issue => issue.path), [site.file === 'att' ? [0, site.field] : [site.field]],
          'ошибка указывает на проверяемое поле, а не неполную фикстуру');
      }
    }
  });

  it(`R289 возврат uuid() только в ${site.name} ломает именно его legacy-совместимость`, async () => {
    const original = fixture();
    for (const other of sites) for (const value of legacy) await accepts(original, other, value);
    const probe = fixture({ [site.file]: stricterGuid(site) });
    for (const other of sites) {
      if (other !== site) {
        for (const value of legacy) await accepts(probe, other, value);
        continue;
      }
      for (const value of legacy) {
        const result = await probe(other, value);
        assert.equal(result.success, false, 'мутант даёт настоящий отказ схемы');
        if (!result.success) {
          assert.ok(result.error instanceof ZodError);
          assert.deepEqual(result.error.issues.map(issue => issue.path), [site.file === 'att' ? [0, site.field] : [site.field]]);
        }
        await assert.rejects(accepts(probe, other, value), error => error instanceof assert.AssertionError
          && error.message.startsWith(`совместимость ${site.name}: ${value}`));
      }
      // Мутант не должен изображать поломанный импорт или схему, отвергающую вообще всё.
      await accepts(probe, other, uuid4);
    }
  });
}
