import { useEffect, useRef, useState } from 'react';
import type { UserLastSeen } from '@gusvoice/shared';
import { api } from './api';
import { dmPresent, serverPresence4 } from './dmOnline';
import { lastSeenNextChangeMs, serverLastSeen } from './lastSeenText';
import { useStore } from './store';

/**
 * «Был(а) в сети» человека моими глазами (С1, #211, `lastseen1`): запрос при показе, при смене его «в сети» (точка шлюза —
 * `onlineUsers`) и перерисовка по границе минуты / часа / полуночи, как у Telegram Desktop (`OnlineChangeTimeout`).
 * Без признака сервера или без человека — `null` (вызывающий показывает прежнее «в сети» / пусто).
 *
 * Согласованность с точкой (B5, эмулятор 08.10): ответ «был(а) давно» приходит от сервера секундой позже, чем точка зажглась от
 * шлюза, и профиль показывал бы «был(а) давно» при горящей точке. Как у Telegram, серверный статус не перекрывает живой: пока шлюз
 * держит человека в сети (`onlineUsers`, при `presence4`), хук отдаёт «в сети» — устаревший ответ не показывается, а свежий
 * запрашивается по смене «в сети» (зависимость `online`). Невидимый (`dmOnlineUsers`) сюда не входит: его «в сети» — только ЛС.
 *
 * ⚠️ Выход из сети: отметку времени шлюз пишет в базу рядом с рассылкой `online.update` — запрос ждёт 1,5 с, чтобы не
 * получить время ВХОДА вместо времени выхода.
 */
export function useLastSeen(userId: string | null | undefined, scope: 'dm' | 'server' = 'dm'): UserLastSeen | null {
  const on = useStore((s) => serverLastSeen(s.serverFeatures));
  // `presence4`: «Невидимый» в сети для ЛС (`dmOnlineUsers`) — его вход и выход тоже повод спросить заново.
  /* `scope` (08.10, D4, решения владельца 42 и 48): в ЛС (`dm`) «не здесь» (`dmAwayUsers`) — не в сети: спросить «был(а)» заново
     и не перекрывать его «в сети». Карточка, открытая из сервера (`server`), — целиком по серверным правилам: «в сети», пока
     открыт сокет (`onlineUsers`), без «был(а)» от скрытия или простоя; «Невидимый» (`dmOnlineUsers`) там не в сети. */
  const online = useStore((s) => (userId ? (scope === 'server' ? s.onlineUsers.includes(userId) : dmPresent(s, userId)) : false));
  const gatewayOnline = useStore((s) =>
    userId
      ? s.onlineUsers.includes(userId) && serverPresence4(s.serverFeatures) && (scope === 'server' || !s.dmAwayUsers?.includes(userId))
      : false,
  );
  // Моя настройка «Время захода» меняет и то, что я вижу у других (взаимность) — спросить заново.
  /* Э7 ч.3 (D): возврат во вкладку и возвращение шлюза (`lastSeenRefresh.ts`) — «был(а)» мог устареть (видели «13 минут» при трёх). */
  const epoch = useStore((s) => s.lastSeenEpoch);
  const myPrivacy = useStore((s) => `${s.user?.lastSeenPrivacy ?? ''}|${s.user?.status === 'invisible' ? 'inv' : ''}`);
  /* `got` — когда пришёл ответ: O5 (S20+, 08.10) — по нему видно, что ответ получен ДО выхода человека из сети. */
  const [view, setView] = useState<{ v: UserLastSeen; got: number } | null>(null);
  const [, setTick] = useState(0);
  const wasOnline = useRef(online);
  /* O5 (приёмка S20+, 08.10): человек вышел из сети — точка шлюза гаснет сразу, а свежий ответ «был(а)» приходит через 1,5 с
     (задержка ниже) и ещё запрос; всё это время старый ответ «в сети» давал пустую строку шапки (`DmChatView`: «в сети»
     уже нет, `seenText` ещё нет). Как у Telegram (`UserStatus` меняется на «был(а) только что» по самому событию выхода):
     момент выхода запоминается ПРИ ОТРИСОВКЕ (не в эффекте — иначе один кадр пустоты), и до свежего ответа отдаётся
     «был(а) только что» (время видно) или прежнее примерное («был(а) недавно»). */
  const [prevOnline, setPrevOnline] = useState(online);
  const [goneAt, setGoneAt] = useState<number | null>(null);
  if (prevOnline !== online) {
    setPrevOnline(online);
    setGoneAt(online ? null : Date.now());
  }

  useEffect(() => {
    if (!on || !userId) {
      setView(null);
      return;
    }
    let alive = true;
    const delay = wasOnline.current && !online ? 1500 : 0;
    wasOnline.current = online;
    const t = setTimeout(() => {
      api.userLastSeen(userId).then(
        (v) => {
          if (alive) setView({ v, got: Date.now() });
        },
        () => {
          if (alive) setView(null);
        },
      );
    }, delay);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [on, userId, online, myPrivacy, epoch]);

  const shown = view && goneAt != null && view.got < goneAt ? leftJustNow(view.v, goneAt) : view?.v;
  useEffect(() => {
    if (!shown) return;
    const ms = lastSeenNextChangeMs(shown, new Date());
    if (ms === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  });

  if (!shown || shown.userId !== userId) return null;
  return gatewayOnline && !shown.online ? { ...shown, online: true, at: null, approx: null } : shown;
}

/**
 * Ответ сервера, полученный до выхода человека из сети (O5), — как «вышел в `at`»: время видно (`exact`) — «был(а) только
 * что» от момента выхода, скрыто — прежнее примерное (`approx`; у бывшего «в сети» его нет — «недавно», как ответит сервер).
 */
export function leftJustNow(v: UserLastSeen, at: number): UserLastSeen {
  if (v.exact) return { ...v, online: false, at: new Date(at).toISOString(), approx: null };
  return { ...v, online: false, at: null, approx: v.approx ?? 'recently' };
}
