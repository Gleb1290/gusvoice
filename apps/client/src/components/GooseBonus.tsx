import { useEffect, useState } from 'react';
import { fullscreenNow } from '../effectsDom';
import { Goose } from './Goose';

/**
 * Сколько висит надбавка «+N» после клика по гусю.
 *
 * ⚠️ Своё число, а не `TIP_HINT_MS`: раньше отсюда занимали константу подсказок типа, и это было
 * ложной связью — у надбавки СВОЯ анимация `goose-hint-rise` (2200 мс). Стоило растянуть подсказки
 * типа до пяти секунд, как узел надбавки продолжал бы висеть невидимым почти три секунды после
 * конца собственной анимации. Число обязано совпадать с длительностью `goose-hint-rise`.
 */
const GOOSE_REWARD_MS = 2200;

export type GooseBonusOpportunity = {
  /** Server-issued one-time opportunity; the client never derives an id or a reward. */
  id: string;
};

/**
 * Ответ на пойманного гуся.
 *
 * ⚠️ `bonus` — сколько монет РЕАЛЬНО начислил сервер. Компонент его не выдумывает и не показывает
 * до ответа: обещать награду вперёд сервера значит однажды показать число, которого не начислили.
 */
export type GooseBonusClaim = { ok: boolean; bonus?: number; reason?: 'expired' | 'claimed' | 'unavailable' };

/**
 * A small, non-modal presentation for an opportunity supplied by the economy client.
 *
 * Scheduling, eligibility, TTL and claiming are deliberately outside this component: a client tab
 * must not invent a reward or keep a hidden prompt to show later. `presentationAllowed` is the
 * layout's answer for its own blocking UI; the component additionally watches tab visibility.
 */
export function GooseBonus({
  opportunity,
  presentationAllowed,
  onClaim,
}: {
  opportunity: GooseBonusOpportunity | null;
  presentationAllowed: boolean;
  onClaim: (id: string) => Promise<GooseBonusClaim>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [hiddenId, setHiddenId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  /**
   * Пойманная надбавка — ТА ЖЕ всплывающая подсказка, что и у типов (решение 02.09: «никаких
   * полётов монеток»).
   *
   * 🔴 Живёт ОТДЕЛЬНО от предложения и переживает его: гусь по нажатию улетает сразу, а сказать про
   * монеты надо после ответа сервера — то есть когда самой кнопки на экране уже нет.
   */
  const [reward, setReward] = useState<{ id: string; amount: number } | null>(null);
  const [tabVisible, setTabVisible] = useState(() => !document.hidden);
  /**
   * ⚠️ Через `fullscreenNow`, а не через `document.fullscreenElement`: показ на весь экран у нас
   * бывает и CSS-оверлеем `.pseudo-fs`, при котором `fullscreenElement` пуст (#29). Проверка только
   * по нему выпускала гуся поверх чужого показа — ровно там, где мешать больнее всего.
   */
  const [fullscreen, setFullscreen] = useState(() => fullscreenNow());

  useEffect(() => {
    const syncVisibility = () => setTabVisible(!document.hidden);
    const syncFullscreen = () => setFullscreen(fullscreenNow());
    document.addEventListener('visibilitychange', syncVisibility);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      document.removeEventListener('fullscreenchange', syncFullscreen);
    };
  }, []);

  useEffect(() => {
    if (!opportunity) return;
    setHiddenId((id) => (id === opportunity.id ? id : null));
    setClaiming(false);
  }, [opportunity?.id]);

  /**
   * 🔴 **Гусь, которого не показали из-за игры или модалки, НЕ хоронится** — он ждёт и появляется,
   * когда поверхность освободится (решение 02.09).
   *
   * Раньше здесь стояло обратное: не показали — считаем отжившим, «чтобы не всплыло отложенной
   * помехой». Для пятнадцатисекундного события это было верно. Но когда гусь стал давать больше
   * половины вечернего дохода, правило начало отбирать заработок ровно у играющих: свернулся через
   * три минуты, а гуся уже похоронил свой же клиент. Отдельный эффект не нужен вовсе — условие
   * показа ниже и так скрывает его живьём, пока поверхность занята.
   */

  useEffect(() => {
    if (!opportunity || hiddenId === opportunity.id) return;
    // ⚠️ Здесь же пересматриваем полноэкранный показ: у `.pseudo-fs` нет события, на которое можно
    // подписаться, а гусь теперь ждёт до следующего — за это время показ развернут и свернут не раз.
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setFullscreen(fullscreenNow());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [hiddenId, opportunity]);

  /**
   * ⚠️ Слой остаётся в дереве, пока висит подсказка, даже когда самого гуся уже нет: он улетает по
   * нажатию, а сказать про монеты надо ПОСЛЕ ответа сервера. Раньше здесь стоял ранний выход по
   * отсутствию предложения — с ним подсказку показывать было бы негде.
   */
  const showGoose =
    !!opportunity &&
    hiddenId !== opportunity.id &&
    presentationAllowed &&
    tabVisible &&
    !fullscreen;
  // 🔴 По ЧАСАМ гуся больше не прячем (решение: «живут вечно, как в твиче»). Он уходит только
  // от нажатия или когда его сменит следующий — и то и другое решает сервер. Сравнение с абсолютным
  // сроком заодно зависело от часов КЛИЕНТА: разойдись они на минуту — кнопки не было бы вовсе.
  void now;
  if (!showGoose && !reward) return null;

  // Keep the narrowed value for the asynchronous click handler; a React re-render may replace the
  // prop while this particular button's handler is still in flight.
  const currentOpportunity = opportunity;

  async function claim() {
    if (claiming || !currentOpportunity) return;
    /**
     * 🔴 Сверки со сроком здесь БОЛЬШЕ НЕТ, и это починка живого бага (07.09). Показ по часам
     * убрали ещё 03.09, а здесь проверка осталась — при том что восстановленному из снимка гусю
     * хост подставлял `expiresAtMs: 0`. Итог: после перезагрузки вкладки гусь был ВИДЕН, но клик
     * по нему уходил в `setHiddenId` — кнопка гасла молча, без монет и без ошибки.
     * ⚠️ Урок класса: срок убрали в ОДНОМ месте из двух. Уходит правило — грепать всё поле, а не
     * то место, откуда о нём вспомнили.
     */
    setClaiming(true);
    try {
      const res = await onClaim(currentOpportunity.id);
      // ⚠️ Показываем ТОЛЬКО то, что подтвердил сервер: ни отказ, ни нулевую надбавку не рисуем.
      if (res.ok && (res.bonus ?? 0) > 0) {
        const shown = { id: currentOpportunity.id, amount: res.bonus! };
        setReward(shown);
        window.setTimeout(() => setReward((r) => (r?.id === shown.id ? null : r)), GOOSE_REWARD_MS);
      }
    } finally {
      // A prompt must never wait behind a modal or return after a failed request. The server remains
      // authoritative; the next issued opportunity will have a different id and can be displayed.
      setHiddenId(currentOpportunity.id);
      setClaiming(false);
    }
  }

  return (
    <aside className="goose-bonus-layer" aria-live="polite">
      {/* 🔴 Та же подсказка, что у типов: всплывает чуть вверх и гаснет прозрачностью. Полёта
          монеты нет — один способ рассказать про монеты вместо двух (решение 02.09). */}
      {reward && <span className="goose-hint">+{reward.amount}</span>}
      {showGoose && (
      <button
        type="button"
        className={`goose-bonus${claiming ? ' is-leaving' : ''}`}
        onClick={() => void claim()}
        disabled={claiming}
        aria-label={claiming ? 'Гусь улетает' : 'Гусь принёс сюрприз'}
      >
        <span className="goose-bonus-copy" aria-hidden="true">
          {/* ⚠️ Обратного отсчёта больше нет: гусь ждёт до следующего, и «осталось 1180 с» было бы
              шумом. У Twitch сундук тоже висит молча. */}
          <strong>{claiming ? 'Гусь улетает…' : 'Поймай гуся!'}</strong>
        </span>
        <span className="goose-bonus-bird" aria-hidden="true">
          <Goose pose="peek" size={92} />
        </span>
      </button>
      )}
    </aside>
  );
}
