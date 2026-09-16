/**
 * Две половины «тыка» (TeamSpeak-style):
 *  • `PokeModal` — то, что видит ПОЛУЧАТЕЛЬ: окно поверх всего, звук и мигание окном звучат отдельно
 *    (`sockets.ts`), сюда приезжает уже только текст.
 *  • `PokeComposer` — то, что видит ОТПРАВИТЕЛЬ: короткое поле и «Ткнуть».
 *
 * ⚠️ Модалка получателя закрывается ТОЛЬКО кнопкой или Esc — намеренно без закрытия по клику мимо.
 * Тык существует ради того, чтобы его заметили; случайный клик по фону в разгар игры погасил бы его
 * до того, как человек успел прочитать, и весь смысл пропал бы.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Icon } from './Icon';

/** Столько же, сколько принимает бэкенд (`POKE_MAX_LEN`) — чтобы обрезание не удивляло постфактум. */
const MAX_LEN = 100;

export function PokeModal() {
  const poke = useStore((s) => s.incomingPoke);
  const dismiss = useStore((s) => s.dismissPoke);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!poke) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [poke, dismiss]);

  if (!poke) return null;

  return (
    <div className="modal-overlay poke-overlay">
      <div className="modal poke-modal" role="alertdialog" aria-labelledby="poke-title">
        <div className="poke-icon" aria-hidden>
          <Icon name="bell" size={28} />
        </div>
        <h2 id="poke-title">
          <b>{poke.fromName}</b> тыкает тебя
        </h2>
        {poke.message && <p className="poke-text">{poke.message}</p>}
        <div className="modal-actions">
          <button type="button" className="primary" ref={okRef} onClick={dismiss}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}

export function PokeComposer({
  channelId,
  userId,
  name,
  price,
  onClose,
}: {
  channelId: string;
  userId: string;
  name: string;
  /**
   * Цена МЕГА пока в монетах. `undefined` — обычный бесплатный тык.
   *
   * 🔴 Один и тот же составитель на оба жеста намеренно: МЕГА пок — это громкая версия тыка, и
   * сообщение к нему пишут так же. Отдельная форма разъехалась бы с этой на первой же правке.
   */
  price?: number;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const mega = price !== undefined;
  // ⚠️ Имя валюты — из настроек сервера, а не вшитое «монет» (аудит текстов 03.09).
  const currencyName = useStore((s) => (s.bootstrap ? s.economy[s.bootstrap.server.id]?.currencyName : null)) ?? 'монет';

  async function send(e: React.FormEvent) {
    e.preventDefault();
    // 🔴 Дорогая трата необратима, поэтому спрашиваем ПРЯМО с ценой. Промах по строке меню не
    // должен стоить монет.
    if (
      mega &&
      !confirm(
        `Ущипнуть ${name} за ${price} ${currencyName}?\n\nОн получит перья, тряску и звук. ⚠️ Если он сидит в игре на весь экран, до него дойдёт только звук — монеты спишутся всё равно.`,
      )
    )
      return;
    setBusy(true);
    try {
      if (mega) await api.buyForUser(channelId, userId, 'mega-poke', text.trim());
      else await api.voicePoke(channelId, userId, text.trim());
      onClose();
    } catch (err) {
      // Отказы тут содержательные («слишком часто», «не беспокоить», «не хватает монет») — их текст
      // и показываем: он написан для человека и объясняет ПОЧЕМУ.
      toastError(err, mega ? 'Не удалось ущипнуть' : 'Не удалось ткнуть');
      setBusy(false);
    }
  }

  return (
    <form className="poke-composer" onSubmit={send}>
      <label className="field">
        {mega ? 'Ущипнуть' : 'Ткнуть'} {name}
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
          autoFocus
          placeholder="Зайди в канал"
          maxLength={MAX_LEN}
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="link" onClick={onClose}>
          Отмена
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {mega ? `Отправить за ${price}` : 'Ткнуть'}
        </button>
      </div>
    </form>
  );
}
