import { counterfact } from '../../shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';
import type { Client, ClientOptions, ICopyDestinationOptions } from 'minio';

const requireHere = createRequire(import.meta.url);
const minioManifestPath = requireHere.resolve('minio/package.json');
const minioRoot = dirname(minioManifestPath);
const requireMinio = createRequire(minioManifestPath);
const mainPath = join(minioRoot, 'dist/main/minio.js');
const clientPath = join(minioRoot, 'dist/main/internal/client.js');
const helpersPath = join(minioRoot, 'dist/main/helpers.js');
const STEP_LIMIT = 200;
const VM_TIMEOUT_MS = 500;

// Снимки старого MinIO из sig-old.txt, а не заново вычисленный «эталон» новым serializer.
// AKIDEXAMPLE и EXAMPLEKEY — общеизвестный фиктивный пример AWS, не настроенные ключи инстанса.
const GET_EXPECTED = 'http://s3.example.test:9000/gusvoice/avatars/u%201.png?response-content-disposition=attachment%3B%20filename%3D%22%D1%84%D0%B0%D0%B9%D0%BB%20%281%29%21%2A%27.png%22&versionId=v%2B1%2F2&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261030%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261030T120000Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=08fcef719bf7d0cbe71fea4553d965c738e145bff9bdc4b88e78bed5d7106eb6';
const LIST_EXPECTED = 'http://s3.example.test:9000/gusvoice/%D1%81%D1%82%D0%B8%D0%BA%D0%B5%D1%80%D1%8B/a%20b?continuation-token=x%2Fy%3D&list-type=2&max-keys=1000&prefix=a%2F&start-after=q%281%29%2A%21%27&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261030%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261030T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=e3d4411522e78a7a2943aecf4f48b96fca47485fdab6a263a629e459bbe142dc';
const PART_EXPECTED = 'http://s3.example.test:9000/gusvoice/mp/obj?partNumber=3&uploadId=VXBsb2FkIElE%3D%3D&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261030%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261030T120000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=e6a61c975bce9d2dfffd0118a0cdba7ae25a690d5c1f973407dd54ad4805ba5a';
const TAGS_EXPECTED = 'a%20b=%21%27%28%29%2A~&e=&%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82=%D0%93%D1%83%D1%81Voice%20%D1%82%D0%B5%D1%81%D1%82';
const requestDate = () => new Date(Date.UTC(2026, 9, 30, 12, 0, 0));
const tags = (): ICopyDestinationOptions => ({
  Bucket: 'b', Object: 'o',
  UserTags: { 'Проект': 'ГусVoice тест', 'a b': "!'()*~", e: '' },
  MetadataDirective: 'REPLACE', Headers: {},
});

type MinioApi = Pick<typeof import('minio'), 'Client' | 'CopyDestinationOptions'>;
type Case = { title: string; expected: string; sign(client: Client): Promise<string> };
const cases: Case[] = [
  {
    title: 'GET: versionId с +/ и кириллица с !*\'() в Content-Disposition',
    expected: GET_EXPECTED,
    sign: (client) => client.presignedGetObject('gusvoice', 'avatars/u 1.png', 600, {
      'response-content-disposition': 'attachment; filename="файл (1)!*\'.png"', versionId: 'v+1/2',
    }, requestDate()),
  },
  {
    title: 'GET списка: continuation-token, prefix, start-after и сортировка всех ключей',
    expected: LIST_EXPECTED,
    sign: (client) => client.presignedUrl('GET', 'gusvoice', 'стикеры/a b', 3600, {
      'list-type': '2', prefix: 'a/', 'max-keys': '1000', 'continuation-token': 'x/y=', 'start-after': "q(1)*!'",
    }, requestDate()),
  },
  {
    title: 'PUT части: числовой partNumber и uploadId с ==',
    expected: PART_EXPECTED,
    // Типы SDK уже фактического входа: сохраняем ЧИСЛО 3 из minio-sig, assertion типа его не преобразует.
    sign: (client) => client.presignedUrl('PUT', 'gusvoice', 'mp/obj', 60,
      { partNumber: 3, uploadId: 'VXBsb2FkIElE==' } as unknown as Record<string, string>, requestDate()),
  },
];

class HarnessBudgetError extends Error {}
class NetworkForbiddenError extends Error {}
function budget() {
  let steps = 0;
  let exceeded = false;
  return {
    step() {
      if (++steps > STEP_LIMIT) {
        exceeded = true;
        throw new HarnessBudgetError('R365: превышен бюджет 200 вызовов/шагов');
      }
    },
    check() {
      if (exceeded) throw new HarnessBudgetError('R365: превышен бюджет 200 вызовов/шагов');
    },
  };
}
function clientOptions(step: () => void) {
  let requests = 0;
  const options: ClientOptions = {
    endPoint: 's3.example.test', port: 9000, useSSL: false,
    accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    // Presigning с заданным region не должен ходить за расположением bucket. Даже при регрессии
    // запрос физически невозможен: transport не делегирует в http/https, повторы отключены.
    transport: { request() { step(); requests++; throw new NetworkForbiddenError('R365: сеть запрещена'); } },
    retryOptions: { disableRetry: true },
  };
  return { options, requests: () => requests };
}
async function installedApi(kind: 'ESM' | 'CJS'): Promise<MinioApi> {
  return kind === 'ESM'
    ? await import(pathToFileURL(join(minioRoot, 'dist/esm/minio.mjs')).href) as MinioApi
    : requireMinio(mainPath) as MinioApi;
}

for (const kind of ['ESM', 'CJS'] as const) {
  for (const specimen of cases) {
    it(`R365 ${kind}: ${specimen.title} побайтно сохраняет URL и X-Amz-Signature`, { timeout: 5_000 }, async () => {
      const api = await installedApi(kind);
      const guard = budget();
      const transport = clientOptions(() => guard.step());
      const client = new api.Client(transport.options);
      const actual = await specimen.sign(client);
      guard.check();
      assert.equal(actual, specimen.expected);
      assert.equal(transport.requests(), 0, 'R365: подпись вычисляется без HTTP');
    });
  }
  it(`R365 ${kind}: CopyDestinationOptions сохраняет порядок и строгое кодирование UserTags`, { timeout: 5_000 }, async () => {
    const api = await installedApi(kind);
    assert.equal(new api.CopyDestinationOptions(tags()).getHeaders()['X-Amz-Tagging'], TAGS_EXPECTED);
  });
}

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}
function resolvedManifest(name: string, from: string, guard: ReturnType<typeof budget>): string | null {
  guard.step();
  // require.resolve('string_decoder') возвращает имя встроенного модуля, не путь к пакету.
  // dirname такого имени раньше отправлял поиск manifest в рабочую папку процесса.
  if (isBuiltin(name)) return null;
  assert.match(name, /^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i, 'R367/подготовка/имя-зависимости');
  let directory = dirname(realpathSync(from));
  // Метаданные не обязаны быть JS-экспортом: xml-naming закрывает и manifest, и require-вход.
  // Ищем как Node от РЕАЛЬНОГО родителя; pnpm-сосед находится через ../node_modules/<dep>.
  // Ничего не require/import-им и не предполагаем фиксированный путь или версию в .pnpm.
  for (let depth = 0; depth < STEP_LIMIT; depth++) {
    guard.step();
    // Node не добавляет node_modules внутрь каталога, который уже так называется.
    if (directory.split(/[\\/]/).at(-1)?.toLowerCase() !== 'node_modules') {
      const candidate = join(directory, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) {
        const manifest = realpathSync(candidate);
        assert.equal(readManifest(manifest).name, name, 'R367/подготовка/имя-разрешённого-пакета');
        return manifest;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      // Тот же код отсутствия, что Node: только optional-пакет может пропустить этот исход.
      throw Object.assign(new Error(`R367/подготовка/не найден manifest установленного ${name}`), { code: 'MODULE_NOT_FOUND' });
    }
    directory = parent;
  }
  throw new HarnessBudgetError('R367: поиск manifest не завершился за 200 каталогов');
}

it('R365 MinIO разрешает собственную query-string именно в 10.0.0, не чужую копию из корня', () => {
  const guard = budget();
  const path = resolvedManifest('query-string', minioManifestPath, guard);
  assert.ok(path, 'R366/подготовка/query-string-не-встроенный-модуль');
  const manifest = readManifest(path);
  assert.equal(manifest.name, 'query-string');
  assert.equal(manifest.version, '10.0.0');
  // Парный живой пример: недостаточно исправить только query-string с открытым главным входом.
  const parser = resolvedManifest('fast-xml-parser', minioManifestPath, budget());
  assert.ok(parser, 'R367/подготовка/fast-xml-parser-не-встроенный-модуль');
  const naming = resolvedManifest('xml-naming', parser, budget());
  assert.ok(naming, 'R367/подготовка/xml-naming-не-встроенный-модуль');
  assert.equal(readManifest(naming).name, 'xml-naming', 'R367/runtime/manifest-доступен-без-exports');
});

function runtimeNames(read: (path: string) => Manifest = readManifest, resolvePackage = resolvedManifest): string[] {
  const guard = budget();
  const seen = new Set<string>();
  const pending = [realpathSync(minioManifestPath)];
  const names: string[] = [];
  while (pending.length) {
    guard.step();
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const manifest = read(path);
    names.push(manifest.name);
    const optional = manifest.optionalDependencies ?? {};
    for (const name of Object.keys({ ...manifest.dependencies, ...optional })) {
      guard.step();
      try {
        // Отдельный ограниченный подъём к manifest: сам граф ограничен 200 узлами/рёбрами,
        // а служебные directory-probe не расходуют его бюджет по нескольку раз на пакет.
        const child = resolvePackage(name, path, budget());
        if (child !== null && !seen.has(child)) pending.push(child);
      } catch (error) {
        // Неустановленная платформенная optional-dependency не часть установленного дерева.
        if (Object.hasOwn(optional, name) && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
    }
  }
  return names;
}

function checkRuntimeNames(names: string[]) {
  assert.equal(names.includes('minio'), true);
  assert.equal(names.includes('query-string'), true);
  assert.equal(names.includes('decode-uri-component'), false, 'R366/runtime/check/нет-decode-uri-component');
}

it('R365 в установленном runtime-дереве MinIO нигде нет decode-uri-component', () => {
  checkRuntimeNames(runtimeNames());
  for (const name of ['string_decoder', 'node:string_decoder', 'fs', 'node:fs']) {
    assert.equal(resolvedManifest(name, minioManifestPath, budget()), null, 'R366/runtime/встроенный-модуль-без-manifest');
  }

  // Контрфакт возвращает запрещённый пакет РЕБРОМ графа, а не прибавлением имени в готовый ответ.
  // Overlay только метаданных: никаких файлов/установок/исполнения кода зависимости.
  counterfact(() => {
const forbiddenPath = join(minioRoot, '__r366-forbidden.package.json');
  const withDecoder = (path: string): Manifest => {
    if (path === forbiddenPath) return { name: 'decode-uri-component', version: '0.4.1' };
    const manifest = readManifest(path);
    return manifest.name === 'query-string'
      ? { ...manifest, dependencies: { ...manifest.dependencies, 'decode-uri-component': '0.4.1' } }
      : manifest;
  };
  const resolveDecoder: typeof resolvedManifest = (name, from, guard) => {
    if (name === 'decode-uri-component') { guard.step(); return forbiddenPath; }
    return resolvedManifest(name, from, guard);
  };
  assert.throws(() => checkRuntimeNames(runtimeNames(withDecoder, resolveDecoder)), error => error instanceof assert.AssertionError
    && error.message.startsWith('R366/runtime/check/нет-decode-uri-component')
    && error.actual === true && error.expected === false,
  'возвращённая зависимость убита адресной проверкой, не manifest/setup/бюджетом');


});
const missingName = '@fixture/absent-dependency';
  const missing = Object.assign(new Error('R366: отсутствующая зависимость фикстуры'), { code: 'MODULE_NOT_FOUND' });
  const resolveMissing: typeof resolvedManifest = (name, from, guard) => {
    if (name === missingName) { guard.step(); throw missing; }
    return resolvedManifest(name, from, guard);
  };
  const withMissing = (optional: boolean) => (path: string): Manifest => {
    const manifest = readManifest(path);
    return manifest.name === 'minio' ? {
      ...manifest, dependencies: { ...manifest.dependencies, [missingName]: '1.0.0' },
      optionalDependencies: { ...manifest.optionalDependencies, ...(optional ? { [missingName]: '1.0.0' } : {}) },
    } : manifest;
  };
  checkRuntimeNames(runtimeNames(withMissing(true), resolveMissing));
  assert.throws(() => runtimeNames(withMissing(false), resolveMissing), error => error === missing,
    'пропуск разрешён только отсутствующей optional, обязательный пакет остаётся ошибкой');
  checkRuntimeNames(runtimeNames());
});

type QueryApi = { stringify(input: Record<string, unknown>, options?: Record<string, unknown>): string };
type QueryNamespace = { default: QueryApi };
type Mutation = 'none' | 'client-namespace' | 'helpers-namespace' | 'sort-false' | 'strict-false';
function replaceOnce(body: string, needle: string, replacement: string): string {
  if (body.split(needle).length - 1 !== 1) throw new Error(`R365/подготовка/неединственный якорь ${needle}`);
  return body.replace(needle, replacement);
}

async function vmMinio(mutation: Mutation) {
  const guard = budget();
  const queryNamespace = await import(pathToFileURL(requireMinio.resolve('query-string')).href) as QueryNamespace;
  if (typeof queryNamespace.default?.stringify !== 'function') throw new Error('R365/подготовка/нет настоящего qs.default.stringify');
  const queryReplacement = mutation === 'sort-false' || mutation === 'strict-false'
    ? { ...queryNamespace, default: { ...queryNamespace.default, stringify(input: Record<string, unknown>, options?: Record<string, unknown>) {
      guard.step();
      return queryNamespace.default.stringify(input, { ...options, [mutation === 'sort-false' ? 'sort' : 'strict']: false });
    } } }
    : queryNamespace;
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const selected = new Set([resolve(mainPath), resolve(clientPath), resolve(helpersPath)]);
  const context = createContext({
    Buffer, Date, URL, URLSearchParams,
    // Только сведения о платформе для User-Agent; настроенные переменные/учётные данные не читаются.
    process: { platform: process.platform, arch: process.arch, version: process.version },
  }, { microtaskMode: 'afterEvaluate' });

  function load(path: string): Record<string, unknown> {
    guard.step();
    const filename = resolve(path);
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(filename, module);
    let body = readFileSync(filename, 'utf8');
    if (filename === resolve(clientPath) && mutation === 'client-namespace') {
      body = replaceOnce(body, 'var qs = require("query-string").default;',
        'var qs = _interopRequireWildcard(require("query-string"), true);');
    }
    if (filename === resolve(helpersPath) && mutation === 'helpers-namespace') {
      body = replaceOnce(body, 'var querystring = require("query-string").default;',
        'var querystring = _interopRequireWildcard(require("query-string"), true);');
    }
    const requireFile = createRequire(filename);
    const localRequire = (id: string): unknown => {
      guard.step();
      if (id === 'query-string') return queryReplacement;
      const resolved = requireFile.resolve(id);
      return selected.has(resolve(resolved)) ? load(resolved) : requireFile(id);
    };
    // Три ПОЛНЫХ установленных CJS-модуля: entrypoint, TypedClient и helpers. Остальные импорты
    // настоящие; не вырезаем классы/методы и не подменяем presignSignatureV4 или URL-вычисления.
    context.__module = module; context.__require = localRequire;
    context.__filename = filename; context.__dirname = dirname(filename);
    new Script(`(function(module, exports, require, __filename, __dirname) {\n${body}\n})(__module, __module.exports, __require, __filename, __dirname);`, { filename })
      .runInContext(context, { timeout: VM_TIMEOUT_MS });
    guard.check();
    return module.exports;
  }
  // Загрузка/проверка экспортов снаружи assert.rejects: ошибка подготовки не является kill.
  const api = load(mainPath) as unknown as MinioApi;
  if (typeof api.Client !== 'function' || typeof api.CopyDestinationOptions !== 'function') {
    throw new Error('R365/подготовка/неполные экспорты установленного MinIO');
  }
  const transport = clientOptions(() => guard.step());
  context.__Api = api; context.__options = transport.options;
  new Script('__client = new __Api.Client(__options)').runInContext(context, { timeout: VM_TIMEOUT_MS });
  guard.check();

  function run(body: string) {
    guard.step();
    new Script(body).runInContext(context, { timeout: VM_TIMEOUT_MS });
    guard.check();
  }
  async function sign(specimen: Case): Promise<string> {
    context.__sign = specimen.sign;
    run('__done = false; __error = undefined; __value = undefined; Promise.resolve(__sign(__client)).then(value => { __value = value; __done = true; }, error => { __error = error; __done = true; });');
    // afterEvaluate удерживает VM-microtasks под timeout. Ограниченный pump нужен для перехода
    // host callbackify → VM Promise; здесь нет waitFor/таймеров и неограниченного async-цикла.
    for (let tick = 0; !context.__done && tick < STEP_LIMIT; tick++) {
      guard.step();
      await Promise.resolve();
      run('');
    }
    guard.check();
    if (!context.__done) throw new HarnessBudgetError('R365: подпись не завершилась за 200 шагов');
    if (context.__error !== undefined) throw context.__error;
    if (typeof context.__value !== 'string') throw new Error('R365/подготовка/presign вернул не строку');
    return context.__value as string;
  }
  return {
    sign,
    tag(): string {
      context.__tags = tags();
      run('__tag = new __Api.CopyDestinationOptions(__tags).getHeaders()["X-Amz-Tagging"]');
      if (typeof context.__tag !== 'string') throw new Error('R365/подготовка/tag вернул не строку');
      return context.__tag as string;
    },
    requests: transport.requests,
  };
}

function hrefFailure(address: string, expected: string) {
  return (error: unknown) => error instanceof assert.AssertionError
    && error.message.split('\n')[0] === address
    && error.operator === 'strictEqual'
    && error.expected === expected
    && typeof error.actual === 'string'
    && error.actual !== expected;
}
function stringifyFailure(error: unknown, name: 'qs' | 'querystring'): boolean {
  return !!error && typeof error === 'object' && 'name' in error && 'message' in error
    && error.name === 'TypeError' && error.message === `${name}.stringify is not a function`;
}

it('R365 без CJS-заплатки client namespace падает именно на qs.stringify, а patched полный модуль подписывает', { timeout: 5_000 }, async () => {
  const original = await vmMinio('none');
  assert.equal(await original.sign(cases[0]), GET_EXPECTED);
  await counterfact(async () => {
const mutant = await vmMinio('client-namespace');
  await assert.rejects(() => mutant.sign(cases[0]), (error: unknown) => stringifyFailure(error, 'qs'));
  assert.equal(mutant.requests(), 0);
});
});

it('R365 без CJS-заплатки helpers namespace падает именно на querystring.stringify, а patched UserTags работают', { timeout: 5_000 }, async () => {
  const original = await vmMinio('none');
  assert.equal(original.tag(), TAGS_EXPECTED);
  await counterfact(async () => {
const mutant = await vmMinio('helpers-namespace');
  assert.throws(() => mutant.tag(), (error: unknown) => stringifyFailure(error, 'querystring'));
  assert.equal(mutant.requests(), 0);
});
});

it('R365 sort:false убивается побайтным эталоном GET списка, не ошибкой загрузки или бюджета', { timeout: 5_000 }, async () => {
  const address = 'R365/presign/sort';
  const original = await vmMinio('none');
  assert.equal(await original.sign(cases[1]), LIST_EXPECTED);
  await counterfact(async () => {
const mutant = await vmMinio('sort-false');
  await assert.rejects(async () => assert.equal(await mutant.sign(cases[1]), LIST_EXPECTED, address), hrefFailure(address, LIST_EXPECTED));
  assert.equal(mutant.requests(), 0);
});
});

it('R365 strict:false убивается эталоном GET с !*\'() и подписью, не ошибкой подготовки', { timeout: 5_000 }, async () => {
  const address = 'R365/presign/strict';
  const original = await vmMinio('none');
  assert.equal(await original.sign(cases[0]), GET_EXPECTED);
  await counterfact(async () => {
const mutant = await vmMinio('strict-false');
  await assert.rejects(async () => assert.equal(await mutant.sign(cases[0]), GET_EXPECTED, address), hrefFailure(address, GET_EXPECTED));
  assert.equal(mutant.requests(), 0);
});
});

for (const mutation of ['sort-false', 'strict-false'] as const) {
  it(`R365 UserTags ловят ${mutation} тем же историческим эталоном заголовка`, { timeout: 5_000 }, async () => {
    const address = `R365/tags/${mutation}`;
    const original = await vmMinio('none');
    assert.equal(original.tag(), TAGS_EXPECTED);
    await counterfact(async () => {
const mutant = await vmMinio(mutation);
    assert.throws(() => assert.equal(mutant.tag(), TAGS_EXPECTED, address), hrefFailure(address, TAGS_EXPECTED));
    assert.equal(mutant.requests(), 0);

});
});
}
