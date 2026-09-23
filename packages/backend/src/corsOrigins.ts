/**
 * Кому разрешён CORS (аудит федерации 19.09, F-21; план §5.1, чеклист §11 п. 31).
 *
 * До этого `origin: true` отражал ЛЮБОЙ источник: кук у нас нет, токен в `localStorage`, поэтому
 * чужая страница сама по себе токен не получала — но и второго рубежа не было: любая будущая XSS
 * или утёкший токен работали с любого сайта в интернете.
 *
 * Разрешены ровно те источники, откуда наш API зовут по замыслу:
 *  - собственный веб-клиент (`CLIENT_ORIGIN`);
 *  - оболочки Tauri v2 — десктоп и Android: у них свой источник, не наш домен;
 *  - `client_origin` связок: гость с соседнего инстанса ходит к нам из СВОЕГО
 *    веб-клиента — это и есть тот «список из связок», который план обещал с самого начала;
 *  - `CORS_EXTRA_ORIGINS` из `.env` — для нестандартных развёртываний, через запятую.
 *
 * ⚠️ Запрос БЕЗ `Origin` (curl, сосед по федерации, свои сервисы) проходит: CORS — правило браузера,
 * а не проверка подлинности. Подлинность — токен и подпись, они здесь ни при чём.
 *
 * Источники связок кешируются на минуту и перечитываются в фоне: проверка идёт на КАЖДЫЙ запрос, и
 * поход в базу на каждый был бы дороже самого запроса. При старте кеш заполняется до первого запроса
 * (`refreshPeerOrigins` в `index.ts`), иначе первый гость после перезапуска получал бы отказ.
 *
 * Здесь только проводка: база, `env`, часы. Решает всё `corsOriginsCore.ts` (вынос для тестов 22.09).
 */

import { db } from './db/index.js';
import { federationLinks } from './db/schema.js';
import { env } from './env.js';
import { createCorsOrigins, staticOriginsFor } from './corsOriginsCore.js';

const cors = createCorsOrigins({
  // Связок единицы-десятки — читаем все, отбор по состоянию в `peerOriginOf` (один источник правды).
  readOrigins: () => db.select({ origin: federationLinks.clientOrigin, state: federationLinks.state }).from(federationLinks),
  now: () => Date.now(),
  staticOrigins: staticOriginsFor({ clientOrigin: env.clientOrigin, extraOrigins: env.corsExtraOrigins }),
});

// Объявления функций, а не `const { … } = cors`: `links.ts` берёт `refreshPeerOrigins` — пусть и кольцо
// импортов, если когда-нибудь появится, не упрётся в TDZ.
export function refreshPeerOrigins(opts: { force?: boolean } = {}): Promise<void> {
  return cors.refreshPeerOrigins(opts);
}

export function originAllowed(origin: string): boolean {
  return cors.originAllowed(origin);
}

export function corsOriginCheck(origin: string | undefined, cb: (err: Error | null, allow: boolean) => void): void {
  cors.corsOriginCheck(origin, cb);
}
