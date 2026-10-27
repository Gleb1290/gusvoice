/**
 * `GET /api/bot/v1/openapi.json` (этап 5, #233) — машиночитаемая схема Bot API без токена, как `llms.txt` (`botDocs.ts`).
 *
 * Документ СТРОИТСЯ из реестра при регистрации маршрута (`buildBotOpenApi()`), а не читается из файла: в образ ничего не
 * копируется, а отдаётся ровно та версия, что стоит на коробке. Адрес в `servers` относительный — от `Host`/прокси ничего
 * не берём (нечего подделывать). Ответ кешируемый (`Cache-Control` + `ETag` по sha256 тела, 304 на `If-None-Match`); `HEAD`
 * Fastify отвечает сам тем же обработчиком без тела. Токен и лимит `botip:` не нужны: это статика из памяти.
 * Отдельным модулем (регистрирует `index.ts` рядом с `botDocsRoutes`): у `routes/botApi.ts` закрытый перечень импортов в тестах;
 * статический путь берёт верх над `/api/bot/v1/:method` в маршрутизаторе Fastify, где бы тот ни был зарегистрирован.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildBotOpenApi } from './botOpenApi.js';

/** Тело и `ETag` — один раз на процесс (документ зависит только от кода). */
export function botOpenApiBody(): { body: string; etag: string } {
  const body = `${JSON.stringify(buildBotOpenApi(), null, 2)}\n`;
  return { body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` };
}

export async function botOpenApiRoutes(app: FastifyInstance): Promise<void> {
  const doc = botOpenApiBody();
  app.get('/bot/v1/openapi.json', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600').header('ETag', doc.etag);
    if (req.headers['if-none-match'] === doc.etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(doc.body);
  });
}
