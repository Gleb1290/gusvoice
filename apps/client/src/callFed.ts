/**
 * ЛС между инстансами, Э6 (#141, `fedcall1`): входящий звонок живёт на ДРУГОМ инстансе — у звонящего (`DmCall.host`). Комната LiveKit,
 * ответ, отклонение, знак жизни и «положить» — туда (`<apiBase>/api/calls/:id/*`) по гостевой сессии, которую выдаёт НАШ дом:
 * `GET /conv/:id/fallback?for=call` (сессия выдаётся и соседу без `dm4`, нужен только `dmcall1`). Транспорт — `apiVia` (Э5).
 * Исходящий звонок идёт как прежде через свой дом. Контракт — `docs/codemap/server.md` «ЛС между инстансами, этап Э6».
 */
import type { DmCall } from '@gusvoice/shared';
import { api, apiVia, type Api } from './api';
import { activeInstanceId } from './config';
import { credsUsable, parseCreds, type ViaCreds } from './fedViaRules';

/** Берём сессию заново, когда до конца меньше минуты. */
const SESSION_MIN_LEFT_MS = 60_000;

const sessions = new Map<string, ViaCreds>();
const pending = new Map<string, Promise<ViaCreds>>();

const keyOf = (call: DmCall): string => `${activeInstanceId() ?? ''}|${call.conversationId}|${call.host?.instanceId ?? ''}`;

/**
 * Сессия на инстансе звонящего для этого звонка. Кеш в памяти (звонок короткий, на диск токен не пишем); одновременные
 * запросы сливаются в один. Сессия другого инстанса, чем `call.host.instanceId`, не годится — токен чужому не отдаём.
 */
export async function hostSession(call: DmCall): Promise<ViaCreds> {
  const host = call.host;
  if (!host) throw new Error('not a hosted call');
  const key = keyOf(call);
  const have = sessions.get(key);
  if (have && credsUsable(have, Date.now() + SESSION_MIN_LEFT_MS)) return have;
  let p = pending.get(key);
  if (!p) {
    p = api
      .convFallback(call.conversationId, 'call')
      .then((raw) => {
        const c = parseCreds(raw);
        if (!c || c.instanceId !== host.instanceId) throw new Error('federation.unsupported');
        sessions.set(key, c);
        return c;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** Клиент API для звонка: у входящего с другого инстанса — по сессии на инстансе звонящего, иначе обычный (свой дом). */
export async function callApiFor(call: DmCall): Promise<Api> {
  return call.host ? apiVia(await hostSession(call)) : api;
}
