import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as zlib from 'node:zlib';
import * as util from 'node:util';
import Fastify from 'fastify';
import * as pmtiles from 'pmtiles';
import * as glyphs from 'smp-noto-glyphs';
import ts from 'typescript';
import * as rules from '../src/mapTilesRules.js';
import * as schema from '../src/db/schema.js';
import { createTestDb, type TestDb } from './harness.js';

const raw = readFileSync(new URL('../src/routes/mapsTiles.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tileBytes = Buffer.from([0x1a, 11, 0x0a, 7, ...Buffer.from('fixture'), 0x78, 2]);
let testDb: TestDb;
const path = '/synthetic-r224/map.pmtiles';
const missingPath = '/synthetic-r224/missing.pmtiles';
// Настоящий PMTiles v3: заголовок, каталог одной плитки z0, JSON и gzip MVT. Никакого 73-МБ стендового файла.
function archiveBytes() {
  const compressed = zlib.gzipSync(tileBytes), root = Buffer.from([1, 0, 1, compressed.length, 1]);
  const header = Buffer.alloc(127), metadata = Buffer.from('{}'), dataAt = 127 + root.length + metadata.length;
  header.write('PMTiles'); header[7] = 3;
  for (const [at, value] of [[8, 127], [16, root.length], [24, 127 + root.length], [32, metadata.length], [40, dataAt], [48, 0],
    [56, dataAt], [64, compressed.length], [72, 1], [80, 1], [88, 1]]) header.writeBigUInt64LE(BigInt(value), at);
  header[96] = 1; header[97] = 1; header[98] = 2; header[99] = 1; header[100] = 0; header[101] = 1;
  for (const [at, value] of [[102, -180], [106, -85], [110, 180], [114, 85], [119, 37], [123, 55]]) header.writeInt32LE(value * 1e7, at);
  header[118] = 0;
  return Buffer.concat([header, root, metadata, compressed]);
}
before(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(schema.users).values({ id: 'r224-map-user', username: 'r224_map', displayName: 'Карта', passwordHash: 'fixture-only' });
});
after(async () => { try { await testDb?.close(); } finally { await (await import('../src/db/index.js')).pool.end(); } });
function load<T>(source: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, Buffer, console, require(id: string) { assert.equal(Object.hasOwn(deps, id), true, `целый mapsTiles: ${id}`); return deps[id]; } });
  return module.exports as T;
}
async function fixture(work: (app: ReturnType<typeof Fastify>, headers: Record<string, string>) => Promise<void>, source = raw, archivePath?: string) {
  const auth = await import('../src/auth.js'), bytes = archiveBytes(), unexpectedIo: string[] = [];
  function checkPath(name: string, syscall: 'open' | 'stat') {
    if (name === path) return;
    if (name !== missingPath || archivePath !== missingPath) unexpectedIo.push(`${syscall}: неожиданное имя ${name}`);
    // Ожидаемый отсутствующий файл — ошибка физического IO, а не assertion, который маршрут может проглотить.
    throw Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${name}'`), { code: 'ENOENT', syscall, path: name });
  }
  // Физическая fs-граница в памяти: путь/offset/length/read проверяются, а LocalFileSource и pmtiles настоящие.
  // Дисковые дескрипторы не проверяются: sandbox не разрешает писать в заданный TEMP стенда.
  const fileIo = {
    async stat(name: string) { checkPath(name, 'stat'); return { size: bytes.length, mtimeMs: 123456 }; },
    async open(name: string, mode: string) {
      checkPath(name, 'open');
      if (mode !== 'r') { unexpectedIo.push(`open: неожиданный режим ${mode}`); throw new Error('fixture: unexpected open mode'); }
      return { async read(target: Buffer, offset: number, length: number, position: number) {
        const count = Math.max(0, Math.min(length, bytes.length - position)); bytes.copy(target, offset, position, position + count); return { bytesRead: count, buffer: target };
      } };
    },
  };
  const archive = load<typeof import('../src/mapTiles.js')>(readFileSync(new URL('../src/mapTiles.ts', import.meta.url), 'utf8'), {
    'node:fs/promises': fileIo,
    pmtiles, './mapTilesRules.js': rules,
  });
  const routes = load<typeof import('../src/routes/mapsTiles.js')>(source, { 'node:zlib': zlib, 'node:util': util, 'smp-noto-glyphs': glyphs,
    '../auth.js': auth, '../env.js': { env: { mapPmtilesPath: archivePath ?? path } }, '../mapTiles.js': archive, '../mapTilesRules.js': rules });
  const app = Fastify();
  try { await app.register(routes.mapsTilesRoutes, { prefix: '/api' }); await app.ready(); await work(app, { authorization: `Bearer ${auth.signToken({ sub: 'r224-map-user', username: 'r224_map', gen: 0 })}` }); }
  finally {
    try { await app.close(); }
    finally { assert.deepEqual(unexpectedIo, [], 'неожиданный IO не скрывается за штатным 503 маршрута'); }
  }
}
it('R224 info читает настоящий заголовок PMTiles и выдаёт приватный etag без внутреннего пути', async () => fixture(async (app, headers) => {
  const res = await app.inject({ url: '/api/maps/info', headers }); assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { minzoom: 0, maxzoom: 1, bounds: [-180, -85, 180, 85], center: [37, 55] });
  assert.equal(res.headers.etag, rules.mapEtag(archiveBytes().length, 123456)); assert.equal(res.headers['cache-control'], 'private, max-age=3600'); assert.equal(res.body.includes(path), false);
}));
async function compressedTile(source = raw) { await fixture(async (app, headers) => {
  const res = await app.inject({ url: '/api/maps/tiles/0/0/0.mvt', headers: { ...headers, 'accept-encoding': 'gzip' } });
  assert.equal(res.statusCode, 200); assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.rawPayload[0] === 0x1f && res.rawPayload[1] === 0x8b, true, 'R224-gzip-body: заголовок gzip соответствует сжатым байтам');
  assert.deepEqual(zlib.gunzipSync(res.rawPayload), tileBytes); assert.equal(res.headers.vary, 'Accept-Encoding');
  assert.equal(res.headers['content-type'], 'application/vnd.mapbox-vector-tile'); assert.equal(res.headers['cache-control'], rules.MAP_TILES_CACHE_CONTROL);
}, source); }
it('R224 gzip плитки действительно разжимается в MVT из локального архива', () => compressedTile());
it('R224 без Accept-Encoding возвращаются распакованные исходные байты, etag даёт пустой 304', async () => fixture(async (app, headers) => {
  const res = await app.inject({ url: '/api/maps/tiles/0/0/0.mvt', headers }); assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-encoding'], undefined); assert.deepEqual(res.rawPayload, tileBytes); assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const cached = await app.inject({ url: '/api/maps/tiles/0/0/0.mvt', headers: { ...headers, 'if-none-match': String(res.headers.etag) } });
  assert.equal(cached.statusCode, 304); assert.equal(cached.rawPayload.length, 0);
}));
it('R224 все три ручки требуют настоящий токен с проверкой пользователя в PGlite', async () => fixture(async (app, headers) => {
  for (const url of ['/api/maps/info', '/api/maps/tiles/0/0/0.mvt', '/api/maps/glyphs/Noto%20Sans/1024-1279.pbf']) {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: 'Bearer broken' } })).statusCode, 401);
    assert.equal((await app.inject({ url, headers })).statusCode, 200);
  }
}));
it('R224 отсутствующая плитка даёт 204, неканоничные z/x/y и диапазон глифов дают 400', async () => fixture(async (app, headers) => {
  for (const url of ['/api/maps/tiles/1/1/1.mvt', '/api/maps/tiles/2/1/1.mvt']) { const res = await app.inject({ url, headers }); assert.equal(res.statusCode, 204); assert.equal(res.rawPayload.length, 0); }
  for (const url of ['/api/maps/tiles/23/0/0.mvt', '/api/maps/tiles/01/0/0.mvt', '/api/maps/tiles/1/2/0.mvt', '/api/maps/tiles/0/0/0', '/api/maps/glyphs/Noto/300-255.pbf']) assert.equal((await app.inject({ url, headers })).statusCode, 400);
}));
it('R224 глифы кириллицы непустые, фактически gzip и кешируются приватно', async () => fixture(async (app, headers) => {
  const res = await app.inject({ url: '/api/maps/glyphs/Noto%20Sans/1024-1279.pbf', headers }); assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-encoding'], 'gzip'); assert.ok(zlib.gunzipSync(res.rawPayload).length > 100);
  assert.equal(res.headers['content-type'], 'application/x-protobuf'); assert.equal(res.headers['cache-control'], rules.MAP_GLYPHS_CACHE_CONTROL);
}));
it('R224 отключённый путь даёт 404, недоступный архив — 503 без утечки пути', async () => {
  await fixture(async (app, headers) => { for (const url of ['/api/maps/info', '/api/maps/tiles/0/0/0.mvt', '/api/maps/glyphs/Noto/0-255.pbf']) assert.equal((await app.inject({ url, headers })).statusCode, 404); }, raw, '   ');
  await fixture(async (app, headers) => { const res = await app.inject({ url: '/api/maps/info', headers }); assert.equal(res.statusCode, 503); assert.deepEqual(res.json(), { error: 'map unavailable' }); }, raw, missingPath);
});
it('R224 контрфакт заголовок gzip без настоящего сжатия убивается проверкой тела', async () => {
  await compressedTile(raw); const from = 'await gzipAsync(tile.data, { level: 6 })'; assert.equal(raw.split(from).length - 1, 1);
  await assert.rejects(() => compressedTile(raw.replace(from, 'tile.data')), e => e instanceof assert.AssertionError && e.message.startsWith('R224-gzip-body:')
    && e.operator === 'strictEqual' && e.actual === false && e.expected === true);
});
