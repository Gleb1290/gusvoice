/**
 * Справка Bot API для нейронки (#229, план `docs/bots-plan.md` §6): `GET /api/bot/v1/llms.txt` без токена отдаёт
 * `docs/bots-llm.md` ТОЙ версии, что стоит на инстансе (человек вставляет её в чат с ИИ и просит написать бота).
 *
 * Источник правды один — `docs/bots-llm.md` в корне репозитория (его же читают люди и выгрузка на GitHub). Под tsx файл
 * берётся оттуда по пути от этого модуля; в образе исходников нет — `packages/backend/Dockerfile` копирует ровно этот файл
 * (`.dockerignore` пропускает его исключением из `docs`) и ставит `BOT_LLM_DOC`, как `MIGRATIONS_DIR` у миграций.
 *
 * Читается один раз при первом запросе и держится в памяти (файл вшит в образ и до перезапуска не меняется); ответ кешируемый
 * (`Cache-Control` + `ETag`). Файла нет (необычная сборка) — 404, а не 500.
 * Отдельным модулем (регистрирует `index.ts`), а не в `routes/botApi.ts`/`routes/bots.ts`: их тесты держат закрытые перечни
 * импортов, а чтение файла — новый выход наружу. Статический путь берёт верх над `/api/bot/v1/:method` в общем маршрутизаторе
 * Fastify, где бы ни был зарегистрирован.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

export const botLlmDocPath = process.env.BOT_LLM_DOC ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'bots-llm.md');

let cached: Promise<{ body: string; etag: string } | null> | null = null;

function loadDoc(): Promise<{ body: string; etag: string } | null> {
  cached ??= readFile(botLlmDocPath, 'utf8').then(
    (body) => ({ body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` }),
    (err) => {
      console.warn(`[bots] справка для нейронки не найдена (${botLlmDocPath}):`, err instanceof Error ? err.message : err);
      cached = null; // повторить при следующем запросе
      return null;
    },
  );
  return cached;
}

export async function botDocsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bot/v1/llms.txt', async (req, reply) => {
    const doc = await loadDoc();
    if (!doc) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found: llms.txt is not bundled with this instance');
    reply.header('Cache-Control', 'public, max-age=3600').header('ETag', doc.etag);
    if (req.headers['if-none-match'] === doc.etag) return reply.code(304).send();
    return reply.type('text/markdown; charset=utf-8').send(doc.body);
  });
}
