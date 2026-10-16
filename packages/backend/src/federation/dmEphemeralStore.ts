/**
 * ЛС между инстансами, Э4 (#141): хранилище «последнее, что сказал дом о своём человеке» (`EphemeralStore` в `dmEphemeral.ts`).
 * Redis, а не таблица базы: запись мгновенная и сама стареет (срок 30 суток), миграции не нужны, Redis уже в стеке и
 * сбрасывается на диск (`--save 60 1`, том `redisdata`), так что переживает перезапуск бэкенда и контейнера.
 * Ключ на человека (`gv:fedpres:<id теневой строки>`), а не один хеш: срок у каждой записи свой. Ошибка Redis — молча (память всё равно есть).
 */
import { redisPub as redis } from '../realtime.js';
import type { EphemeralStore } from './dmEphemeral.js';

const PREFIX = 'gv:fedpres:';
/** Срок записи: человек соседа, не заходивший месяц, из «был(а)» уходит сам (дальше всё равно «давно»). */
export const PRESENCE_TTL_S = 30 * 24 * 3600;
const SCAN_COUNT = 500;

export const redisEphemeralStore: EphemeralStore = {
  save(shadowId, json) {
    void redis.set(PREFIX + shadowId, json, 'EX', PRESENCE_TTL_S).catch(() => {});
  },
  async loadAll() {
    const out: [string, string][] = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', SCAN_COUNT);
      cursor = next;
      if (keys.length === 0) continue;
      const vals = await redis.mget(...keys);
      keys.forEach((k, i) => {
        const v = vals[i];
        if (v) out.push([k.slice(PREFIX.length), v]);
      });
    } while (cursor !== '0');
    return out;
  },
};
