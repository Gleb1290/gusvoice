import type { FastifyInstance } from 'fastify';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { notoGlyphFallback } from 'smp-noto-glyphs';
import { requireAuth } from '../auth.js';
import { env } from '../env.js';
import { openMapArchive, type MapArchive } from '../mapTiles.js';
import { MAP_GLYPHS_CACHE_CONTROL, MAP_TILES_CACHE_CONTROL, mapTilesEnabled, parseGlyphRange, parseMapTileParams } from '../mapTilesRules.js';

const gzipAsync = promisify(gzip);

/**
 * Своя карта OpenStreetMap (14.10, признак `osmmap1`), `MAP_PMTILES_PATH` — один файл PMTiles protomaps на нашем сервере:
 *   GET /api/maps/info                      — масштабы, границы и центр файла (клиент строит стиль);
 *   GET /api/maps/tiles/:z/:x/:y.mvt        — векторная плитка (gzip, если клиент принимает); нет плитки — 204;
 *   GET /api/maps/glyphs/:stack/:range.pbf  — глифы подписей (Noto Sans из пакета, латиница/кириллица и др.), без запросов наружу.
 *
 * Почему ручка плиток, а не раздача самого файла с Range: не зависит от того, пропускает ли Range и кеширует ли 206 прокси/NPM
 * перед сервером; файл на десятки ГБ наружу целиком не торчит; каждая плитка — обычный кешируемый ответ.
 * Вход обязателен (как у `/maps/static`): карту грузит только вошедший, чужому трафику своё не отдаём; клиент шлёт заголовок входа
 * через `transformRequest` MapLibre. Ответы `private` — кеш только в браузере человека.
 * Регистрируется в `index.ts` только при заданном пути (иначе честный 404, как `diag`/`economy`).
 */
export async function mapsTilesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  let archive: MapArchive | null = null;
  const arch = (): MapArchive | null => {
    if (!mapTilesEnabled(env.mapPmtilesPath)) return null;
    archive ??= openMapArchive(env.mapPmtilesPath);
    return archive;
  };

  app.get('/maps/info', async (_req, reply) => {
    const a = arch();
    if (!a) return reply.code(404).send({ error: 'disabled' });
    try {
      const { etag, ...info } = await a.info();
      return reply.header('Cache-Control', 'private, max-age=3600').header('ETag', etag).send(info);
    } catch {
      return reply.code(503).send({ error: 'map unavailable' });
    }
  });

  app.get<{ Params: { z: string; x: string; yFile: string } }>('/maps/tiles/:z/:x/:yFile', async (req, reply) => {
    const a = arch();
    if (!a) return reply.code(404).send({ error: 'disabled' });
    const t = parseMapTileParams(req.params.z, req.params.x, req.params.yFile);
    if (!t) return reply.code(400).send({ error: 'bad tile' });
    try {
      const info = await a.info();
      reply.header('Cache-Control', MAP_TILES_CACHE_CONTROL).header('ETag', info.etag);
      if (req.headers['if-none-match'] === info.etag) return reply.code(304).send();
      const tile = await a.tile(t.z, t.x, t.y);
      reply.header('X-Content-Type-Options', 'nosniff');
      if (!tile) return reply.code(204).send();
      reply.header('Content-Type', 'application/vnd.mapbox-vector-tile').header('Vary', 'Accept-Encoding');
      // Плитка в файле сжата, но библиотека отдаёт её распакованной; прокси перед нами сжимает не везде — сжимаем сами (браузер кеширует ответ).
      if (/gzip/i.test(String(req.headers['accept-encoding'] ?? ''))) {
        reply.header('Content-Encoding', 'gzip');
        return reply.send(await gzipAsync(tile.data, { level: 6 }));
      }
      return reply.send(tile.data);
    } catch {
      return reply.code(503).send({ error: 'map unavailable' });
    }
  });

  app.get<{ Params: { stack: string; file: string } }>('/maps/glyphs/:stack/:file', async (req, reply) => {
    if (!mapTilesEnabled(env.mapPmtilesPath)) return reply.code(404).send({ error: 'disabled' });
    const range = parseGlyphRange(req.params.file);
    if (!range) return reply.code(400).send({ error: 'bad range' });
    // Одна гарнитура на все начертания: пакет даёт Noto Sans (GoNotoKurrent) Regular; диапазона нет — пустой ответ (пробелы вместо 404).
    const res = notoGlyphFallback(req.params.stack.slice(0, 120), range);
    const body = Buffer.from(await res.arrayBuffer());
    return reply
      .header('Content-Type', 'application/x-protobuf')
      .header('Content-Encoding', 'gzip')
      .header('Cache-Control', MAP_GLYPHS_CACHE_CONTROL)
      .header('X-Content-Type-Options', 'nosniff')
      .send(body);
  });
}
