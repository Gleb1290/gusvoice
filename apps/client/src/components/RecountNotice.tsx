import { useEffect } from 'react';
import { api } from '../api';
import coinDefaultIcon from '../assets/guscoin.svg';
import { Goose } from './Goose';
import { Icon } from './Icon';

/**
 * Одноразовая карточка «мы пересчитали твой сезон» (28.10).
 *
 * Правило затухания GusCoins сменилось: время одному больше не тратит затухание (`coinRules.ts`,
 * миграция 0158). Старое правило урезало заработок тех, кто днём ждал компанию один, — бэкенд один раз
 * доначислил разницу за текущий сезон (`aloneRecount.ts`) и оставил строку карточки; снимок экономики
 * отдаёт её как `recount`. 🔴 Язык бытовой, без кухни (как приветствие `EconomyWelcome.tsx`): ни
 * процентов, ни минут — что случилось, что мы сделали, сколько пришло.
 *
 * ⚠️ Показ решает `MainLayout` (авто-показ на сервере с `recount`, не поверх другого окна, гусь бонуса не
 * выглядывает поверх). Закрытие ЛЮБЫМ способом (кнопка, крестик, Esc, мимо окна) = «видел»: при `markSeenOn`
 * карточка ставит отметку на сервере сама (молча — провал не мешает закрыть, худшее — покажется ещё раз).
 * Повторный показ из кошелька (строка журнала «Перерасчёт сезона») идёт без `markSeenOn` — только показ.
 */
export function RecountNotice({
  amount,
  currencyName,
  iconUrl,
  seasonName,
  markSeenOn,
  onClose,
}: {
  amount: number;
  currencyName: string;
  iconUrl: string | null;
  /** Подпись сезона, если он совпадает с текущим (иначе без неё). */
  seasonName?: string;
  /** Сервер, на котором закрытие ставит отметку «видел» (авто-показ). Нет — только показ. */
  markSeenOn?: string;
  onClose: () => void;
}) {
  function close() {
    onClose();
    if (markSeenOn) api.markRecountSeen(markSeenOn).catch(() => {});
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, markSeenOn]);

  return (
    <div className="modal-overlay recount-overlay" onClick={close}>
      <section
        className="modal eco-welcome recount-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rn-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ew-head">
          <span className="ew-eyebrow">
            <img src={iconUrl || coinDefaultIcon} alt="" className="ew-eyebrow-coin" />
            {seasonName ? `${currencyName} · ${seasonName}` : currencyName}
          </span>
          <button type="button" className="icon-close" title="Закрыть" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="ew-art rn-art">
          <Goose pose="sorry" size={104} />
          <span className="rn-amount" aria-label={`Начислено ${amount}`}>
            <span className="rn-plus">+{amount}</span>
            <img src={iconUrl || coinDefaultIcon} alt="" className="rn-coin" />
          </span>
        </div>
        <h2 id="rn-title" className="ew-title">
          Мы починили затухание
        </h2>
        <p className="ew-text">
          Раньше, пока ты ждал компанию один, к вечеру монеты капали медленнее, чем у пришедших. Теперь ожидание это
          не тратит — и мы пересчитали твой сезон по новым правилам.
        </p>

        <div className="rn-actions">
          <button type="button" className="ew-btn ew-btn-main" onClick={close} autoFocus>
            Спасибо, гусь
          </button>
        </div>
      </section>
    </div>
  );
}
