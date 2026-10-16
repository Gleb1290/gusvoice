import { parseMapInfo, type MapInfoDto } from '@gusvoice/shared';
import { api, getToken } from './api';
import { config } from './config';

/**
 * Свой источник живой карты (14.10, `osmmap1`): описание файла карты у сервера и заголовок входа для плиток и глифов.
 * Все адреса карты — только наш сервер (`/api/maps/*`); к чужим не ходим. Ответ `/api/maps/info` помним не дольше `MAP_INFO_TTL_MS`.
 *
 * 🔴 Приёмка 14.10 (S20): после смены файла карты на сервере (Москва → Россия) клиент держал старые `bounds` до перезапуска —
 * источник MapLibre не запрашивал плитки вне них, и вне Москвы карта была пустым фоном. Теперь описание живёт 10 минут, а запрос
 * обходит кеш браузера (`api.mapInfo` — метка десятиминутки в адресе: сервер отдаёт `/info` с `max-age=3600`).
 */

export const MAP_INFO_TTL_MS = 10 * 60_000;

let infoJob: { base: string; job: Promise<MapInfoDto>; at: number } | null = null;

/** Адрес API (без хвоста), на котором лежит карта: тот же, что у остальных запросов клиента. */
export function mapApiBase(): string {
  return config.apiUrl;
}

/** Описание карты сервера; сбой не запоминаем — следующая карточка спросит снова. Ответ неверный — исключение. */
export function loadMapInfo(): Promise<MapInfoDto> {
  const base = mapApiBase();
  if (infoJob && infoJob.base === base && Date.now() - infoJob.at < MAP_INFO_TTL_MS) return infoJob.job;
  const job = api.mapInfo().then((raw) => {
    const info = parseMapInfo(raw);
    if (!info) throw new Error('bad map info');
    return info;
  });
  const mine = { base, job, at: Date.now() };
  infoJob = mine;
  job.catch(() => {
    if (infoJob === mine) infoJob = null;
  });
  return job;
}

/**
 * `transformRequest` MapLibre: к нашим адресам карты добавляет заголовок входа (плитки и глифы — запросы `fetch` самой библиотеки).
 * Токен берём в момент запроса, чтобы продление входа подхватывалось.
 */
export function mapTransformRequest(url: string): { url: string; headers?: Record<string, string> } {
  const token = getToken();
  if (token && url.startsWith(`${mapApiBase()}/api/maps/`)) return { url, headers: { Authorization: `Bearer ${token}` } };
  return { url };
}
