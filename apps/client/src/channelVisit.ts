import { useEffect, useState } from 'react';
import { lastSeenAt, markChannelSeen } from './channelPrefs';
import { isMobile } from './hotkeys';
import { windowFocused } from './notifications';
import { useStore } from './store';

/**
 * «Визит в ленту» — когда человек ВИДИТ канал, а не когда компонент смонтирован.
 *
 * 🔴 Почему понадобилось (20.09, поймано на живом телефоне). На компьютере лента и список стоят
 * рядом, поэтому «зашёл в канал» = «смонтировался `ChatView`». На телефоне панели переключаются, а
 * компонент ленты остаётся смонтированным: человек уходит в список каналов, ему приходит сотня
 * сообщений, он возвращается — и метка визита у него та же, что была при первом заходе, а права
 * встать у черты никто не давал. Замерено: 60 непрочитанных, черта нашлась в 2749 px ВЫШЕ экрана,
 * лента стояла внизу. То есть починка «открывать канал у черты» на телефоне не работала вовсе.
 *
 * Отсюда правило: считать визитом показ ленты, а не монтирование. Уход в список — это выход:
 * метка двигается вперёд (человек всё видел), возврат — новый визит со своей меткой и своим правом
 * встать у границы непрочитанного.
 *
 * `visitKey` отдаётся в `MessagePane` как `scrollKey`: там он и есть «другая лента» — эффект
 * прокрутки взводит право на прыжок именно по его смене.
 */
export function useChannelVisit(
  id: string,
  kind: 'channel' | 'dm' = 'channel',
): { newSince: number | null; readKey: number | null; visitKey: string; started: boolean } {
  const mobilePane = useStore((s) => s.mobilePane);
  const readChannelNow = useStore((s) => s.readChannelNow);
  const readDmNow = useStore((s) => s.readDmNow);
  const viewing = !isMobile() || mobilePane === 'content';
  const [newSince, setNewSince] = useState<number | null>(null);
  const [readKey, setReadKey] = useState<number | null>(null);
  const [visit, setVisit] = useState(0);
  /** Беседа: сводка была известна в начале визита — снимок `readKey` настоящий (G09/G26). Канал — всегда. */
  const [known, setKnown] = useState(kind !== 'dm');

  useEffect(() => {
    if (!viewing) return;
    setNewSince(lastSeenAt(id));
    /* Ключ прочитанного беседы (ЛС, шаг 2г) — до «прочитано» ниже: ответ на него меняет ключ, и снимок позже показал
       бы черту «Новые» уже после прочитанного (на локальном стенде ответ успевает раньше перерисовки). */
    const summary = kind === 'dm' ? useStore.getState().conv.summaries[id] : undefined;
    if (kind === 'dm') setReadKey(summary?.lastReadKey ?? null);
    setKnown(kind !== 'dm' || !!summary);
    setVisit((n) => n + 1);
    /* Беседа снова на глазах — дочитана (#212). После починки Б2 письма в ПОСЛЕДНЮЮ беседу, пока
       человек в сервере, горят непрочитанным; а вернуться к ней можно не через `selectDm`, а кнопкой
       «Личные сообщения» в рейле (`setView`), которая ничего не гасит. Без этого значок висел бы,
       пока человек читает. Каналы гасятся своим `openChannel`. */
    if (kind === 'dm' && windowFocused()) readDmNow(id);
    /* 🔴 Перезагрузка, закрытие окна и выгрузка свёрнутого приложения уборку эффекта НЕ зовут: метка оставалась от
       прошлого визита, и следующий запуск ставил ленту к черте «Новые» над уже прочитанным (стенд 2г, 01.10). Черту
       ЭТОГО визита метка не двигает — она снята выше, при его начале. */
    const onLeave = () => markChannelSeen(id);
    const onHidden = () => {
      if (document.visibilityState === 'hidden') markChannelSeen(id);
    };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onHidden);
      markChannelSeen(id);
      // Ушёл из ленты — значит прочитал: гасим счётчик, который до сих пор прятался за «текущим».
      if (kind === 'dm') readDmNow(id);
      else readChannelNow(id);
    };
  }, [id, viewing, kind, readChannelNow, readDmNow]);

  /**
   * Беседа открылась раньше, чем пришёл список бесед (запуск сразу в последнюю беседу): ключа прочитанного ещё нет — ни
   * черты «Новые», ни права читать по видимому (лента стоит внизу и «прочла» бы всё). Сводка пришла — это новый визит со
   * своим снимком: лента встанет к черте (G26) и только потом начнёт отмечать увиденное (G09).
   */
  useEffect(() => {
    if (kind !== 'dm' || !viewing || known) return;
    const take = (s: ReturnType<typeof useStore.getState>) => {
      const summary = s.conv.summaries[id];
      if (!summary) return false;
      setReadKey(summary.lastReadKey);
      setKnown(true);
      setVisit((n) => n + 1);
      return true;
    };
    if (take(useStore.getState())) return;
    const off = useStore.subscribe((s) => {
      if (take(s)) off();
    });
    return off;
  }, [id, viewing, kind, known]);

  /**
   * Вернулся в окно — дочитал то, что пришло, пока оно было свёрнуто (#212).
   * Личное сообщение в открытую беседу при окне не в фокусе теперь горит непрочитанным, а не
   * отмечается тихо (`dmListRules.dmIncomingDecision`); гасит его возврат взгляда, как у Telegram.
   * У каналов такие сообщения пока отмечаются сразу — вызов для них ничего не меняет.
   */
  useEffect(() => {
    if (!viewing) return;
    const onBack = () => {
      if (!windowFocused()) return;
      if (kind === 'dm') readDmNow(id);
      else readChannelNow(id);
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [id, viewing, kind, readChannelNow, readDmNow]);

  /* `started` — визит начался (эффект выше отработал) и у беседы был ключ прочитанного: до этого `readKey` — не снимок, и лента не вправе
     сообщать увиденное (G09, `MessagePane.onSeen`) — она стоит внизу до прыжка к черте и «прочла» бы всё. */
  return { newSince, readKey, visitKey: `${id}#${visit}`, started: visit > 0 && known };
}
