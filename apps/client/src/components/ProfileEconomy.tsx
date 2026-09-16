import { useEffect, useState } from 'react';
import { api } from '../api';
import { isMockEconomy, mockUserCard } from '../benchMock';
import coinDefaultIcon from '../assets/guscoin.svg';
import type { UserEconomyCard } from '../economy';
import { ensureEconomy } from '../economyClient';
import { useStore } from '../store';
import { toast, toastError } from '../toast';

/**
 * Экономический блок в карточке ЧУЖОГО профиля: уровень, баланс и кнопка «типнуть».
 *
 * 🔴 **Одним компонентом на обе поверхности** — меню на десктопе и нижняя шторка на мобиле. Ровно
 * та же причина, что у короны: две копии разойдутся, и где-то останется кнопка без проверки или
 * баланс без уровня.
 *
 * ⚠️ Ничего не показывает, если карточки нет. `null` приходит И когда экономика выключена, И когда
 * человек в ней не участвует — намеренно неразличимо, чтобы его выключатель не стал поводом для
 * подколок (та же логика, что у безликих текстов отказа в переводе).
 */
export function ProfileEconomy({
  userId,
  name,
  onDone,
}: {
  userId: string;
  name: string;
  /** Дать хозяину карточки закрыться после удачного жеста; необязательно. */
  onDone?: () => void;
}) {
  const serverId = useStore((s) => s.bootstrap?.server.id);
  const economy = useStore((s) => (serverId ? s.economy[serverId] : undefined));
  const myChannel = useStore((s) => s.voice?.channelId);
  /**
   * Сидит ли собеседник в ТОМ ЖЕ голосовом канале, что и я.
   *
   * ⚠️ Считается из общей карты presence, а не приходит пропом: шторка на мобиле открывается из
   * списка участников, который про голос ничего не знает, и проп пришлось бы протаскивать через
   * два экрана — а разойтись он мог бы в любом из них.
   */
  const together = useStore(
    (s) => !!myChannel && !!s.presence[myChannel]?.some((p) => p.userId === userId),
  );
  const [card, setCard] = useState<UserEconomyCard | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!serverId || !economy?.enabled) return;
    let alive = true;
    api
      .userEconomy(serverId, userId)
      .then((r) => alive && setCard(r.card))
      // Молчим: карточка профиля не должна ругаться из-за украшения. Нет данных — нет блока.
      // ⚠️ На стенде подставляем макет: настоящий запрос при выключенной экономике честно вернёт
      // «нечего показывать», и блок было бы не проверить.
      .catch(() => alive && setCard(isMockEconomy() ? mockUserCard() : null));
    return () => {
      alive = false;
    };
  }, [serverId, userId, economy?.enabled]);

  async function tip() {
    if (!serverId || !myChannel) return;
    setBusy(true);
    try {
      const r = await api.tip(myChannel, userId);
      toast('success', 'Тип отправлен', `${name}: +${r.credited} ${economy?.currencyName ?? ''}`);
      // Свой баланс приедет пушем; перезапрос — страховка, его провал не должен превращать
      // состоявшийся жест в ложную ошибку.
      ensureEconomy(serverId, true);
      onDone?.();
    } catch (e) {
      // ⚠️ Текст отказа приходит с сервера уже человеческим (`tipRules.ts`) — не подменять догадкой.
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!economy?.enabled || !card) return null;

  return (
    <div className="pe">
      <div className="pe-row">
        <span className="pe-level" title={`Уровень ${card.level.level}`}>
          <span className="pe-level-num">{card.level.level}</span>
          {card.level.title}
        </span>
        <span className="pe-balance">
          {/* Иконка валюты сервера, с откатом на нашу монетку — как в чипе шапки. */}
          <img className="pe-coin" src={economy.iconUrl || coinDefaultIcon} alt="" />
          {card.balance}
        </span>
      </div>
      {/*
        🔴 Кнопка не прячется, когда типнуть нельзя, — становится серой с причиной. Исчезнувшая
        кнопка читается как поломка, а серая объясняет правило: тип живёт в голосовом канале, это и
        есть жест «за хорошую шутку», а не перевод денег через весь сервер.
      */}
      <button
        type="button"
        className="pe-tip"
        disabled={!together || busy}
        title={together ? `Типнуть · ${name}` : 'Типнуть можно тому, кто сидит с тобой в голосовом канале'}
        onClick={() => void tip()}
      >
        <img className="pe-coin" src={economy.iconUrl || coinDefaultIcon} alt="" />
        Типнуть
      </button>
    </div>
  );
}
