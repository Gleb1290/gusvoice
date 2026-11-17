import { useEffect, useState } from 'react';
import { api } from '../api';
import { ensureEconomy } from '../economyClient';
import { onGooseOffer } from '../sockets';
import { useStore } from '../store';
import { GooseBonus, type GooseBonusOpportunity } from './GooseBonus';

/**
 * Боевой источник предложений для `GooseBonus` (план, модель G) — заменил отладочную заглушку.
 *
 * 🔴 **Расписания здесь НЕТ и быть не должно.** Когда гусю выглядывать и сколько он даёт, решает
 * сервер: вкладка не может ни выдумать награду, ни придержать предложение, чтобы показать его
 * позже. Отсюда наверх идёт ровно то, что приехало сокетом, и обратно — только идентификатор.
 *
 * ⚠️ Предложение относится к КОНКРЕТНОМУ серверу. Пришло, пока открыт другой, — молча роняем:
 * показать гуся не на том сервере значит предложить монеты не того кошелька.
 */
export function GooseBonusHost({ presentationAllowed }: { presentationAllowed: boolean }) {
  const serverId = useStore((s) => s.bootstrap?.server.id);
  const [opportunity, setOpportunity] = useState<GooseBonusOpportunity | null>(null);
  const snapshotOffer = useStore((s) => (serverId ? (s.economy[serverId]?.goose?.offerId ?? null) : null));

  useEffect(() => {
    return onGooseOffer((offer) => {
      if (!serverId || offer.serverId !== serverId) return;
      setOpportunity({ id: offer.offerId });
    });
  }, [serverId]);

  // Ушёл с сервера — предложение больше не наше.
  useEffect(() => setOpportunity(null), [serverId]);

  /**
   * 🔴 Восстановление из снимка экономики. Предложение приходит ОДНИМ пушем: обновил вкладку — и
   * живой гусь становился невидимым до следующего, хотя жетон на сервере цел. Ровно поэтому бонус
   * нельзя было протестить вовсе (03.09).
   * ⚠️ Уже показанное пушем не трогаем: снимок мог приехать позже и оказаться старее.
   */
  useEffect(() => {
    if (!snapshotOffer) return;
    setOpportunity((cur) => (cur && cur.id === snapshotOffer ? cur : { id: snapshotOffer }));
  }, [snapshotOffer]);

  return (
    <GooseBonus
      opportunity={opportunity}
      presentationAllowed={presentationAllowed}
      onClaim={async (id) => {
        if (!serverId) return { ok: false };
        const clearClaimedOffer = () => setOpportunity((current) => (current?.id === id ? null : current));
        try {
          const res = await api.claimGoose(serverId, id);
          /**
           * 🔴 Полёта монеты НЕТ (решение 02.09: «никаких полётов монеток»). Надбавку
           * показывает та же всплывающая подсказка, что и у типов, — её рисует сам `GooseBonus`
           * по возвращённой сумме. Один способ рассказать про монеты вместо двух.
           *
           * ⚠️ Сумму отдаём наверх только ПОСЛЕ ответа сервера: до него мы не знаем ни того, что
           * надбавка состоялась, ни её размера. Показать раньше — однажды показать число, которого
           * не начислили.
           */
          // Баланс приедет пушем; перезапрос — страховка, и его провал не должен превращать
          // состоявшуюся надбавку в ложную ошибку.
          clearClaimedOffer();
          ensureEconomy(serverId, true);
          return { ok: true, bonus: res.bonus };
        } catch (e) {
          const { reason, status } = (e as { reason?: string; status?: number } | null) ?? {};
          if (reason === 'expired' || reason === 'claimed' || reason === 'unavailable' || status === 403 || status === 404 || status === 409) {
            clearClaimedOffer();
            return { ok: false };
          }
          // Ответ мог потеряться до или после поимки. Повтор идёт с тем же одноразовым жетоном.
          return { ok: false, retry: true };
        }
      }}
    />
  );
}
