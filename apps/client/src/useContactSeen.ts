import { useEffect, useMemo, useState } from 'react';
import type { UserLastSeen } from '@gusvoice/shared';
import { api } from './api';
import { contactStatusText, serverLastSeen } from './lastSeenText';
import { useStore } from './store';

/**
 * Подписи «в сети» / «был(а) …» под именами в списке «Новое сообщение» на телефоне (Telegram `ContactsActivity`). Один пакетный
 * запрос `POST /users/last-seen` (до 200 человек — столько отдаёт сервер, `LAST_SEEN_BATCH_MAX`), без ответа или без `lastseen1` —
 * пустая карта, вызывающий остаётся на @нике. «В сети» берётся из переданного набора (`useVisibleOnline`), а не из ответа.
 */
const BATCH = 200;

export function useContactSeen(ids: readonly string[], online: ReadonlySet<string>, enabled: boolean): Map<string, string> {
  const on = useStore((s) => serverLastSeen(s.serverFeatures)) && enabled;
  const key = useMemo(() => [...new Set(ids)].sort().join(','), [ids]);
  const [seen, setSeen] = useState<Map<string, UserLastSeen>>(new Map());

  useEffect(() => {
    if (!on || !key) return;
    let alive = true;
    const list = key.split(',');
    void (async () => {
      for (let i = 0; i < list.length; i += BATCH) {
        try {
          const items = (await api.usersLastSeen(list.slice(i, i + BATCH))).items;
          if (!alive) return;
          setSeen((prev) => {
            const next = new Map(prev);
            for (const it of items) next.set(it.userId, it);
            return next;
          });
        } catch {
          /* 429 / сеть: остаётся @ник */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [on, key]);

  return useMemo(() => {
    const out = new Map<string, string>();
    if (!on) return out;
    const now = new Date();
    for (const id of key ? key.split(',') : []) {
      const t = contactStatusText(online.has(id), seen.get(id), now);
      if (t) out.set(id, t);
    }
    return out;
  }, [on, key, online, seen]);
}
