import { useEffect, useState } from 'react';
import { lastSeenAt, markChannelSeen } from './channelPrefs';
import { isMobile } from './hotkeys';
import { windowFocused } from './notifications';
import { useStore } from './store';

/**
 * Раскладка телефона — список и лента РАЗНЫЕ экраны: приложение на телефоне (`isMobile()`) или окно не шире 760 px (граница
 * `PHONE_LAYOUT_QUERY`, `phoneLayout.ts`): вкладка браузера телефона, узкое окно ПК. 🔴 29.10: здесь был только `isMobile()`,
 * и вкладка Chrome на телефоне считала ленту видимой, когда человек уже ушёл в список, — отмечала прочитанным и прятала число.
 */
function phonePanes(): boolean {
  return isMobile() || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches);
}

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
  const instanceEpoch = useStore((s) => s.instanceEpoch);
  const readChannelNow = useStore((s) => s.readChannelNow);
  const readDmNow = useStore((s) => s.readDmNow);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const viewing = pageVisible && (!phonePanes() || mobilePane === 'content');
  const [newSince, setNewSince] = useState<number | null>(null);
  const [readKey, setReadKey] = useState<number | null>(null);
  const [visit, setVisit] = useState(0);
  /** Беседа: сводка была известна в начале визита — снимок `readKey` настоящий (G09/G26). Канал — всегда. */
  const [known, setKnown] = useState(kind !== 'dm');

  useEffect(() => {
    if (!viewing) return;
    setNewSince(lastSeenAt(id));
    let left = false;
    let touched = false;
    let offSummary: (() => void) | undefined;
    const entry = useStore.getState();
    const initialRead = kind === 'dm' ? entry.conv.summaries[id]?.lastReadKey ?? null : null;
    const waiting = kind === 'dm' && entry.convActive && entry.conv.phase !== 'live';
    setReadKey(initialRead);
    setKnown(kind !== 'dm' || (!!entry.conv.summaries[id] && !waiting));
    setVisit((n) => n + 1);
    const sameInstance = () => {
      const current = useStore.getState();
      return current.instanceEpoch === entry.instanceEpoch && current.convCacheKey === entry.convCacheKey;
    };
    const entryPosition = entry.conv.positionRev?.[id] ?? 0;
    const touch = (event: Event) => {
      if (touched || !sameInstance() || !(event.target as Element | null)?.closest?.('.messages')) return;
      touched = true;
      entry.convKeepPosition(id);
    };
    // Снимок после догонки можно переставить только до первого действия человека; события прочитанного во время
    // дальнейшего чтения истории вообще не переснимают визит. Смена инстанса/беседы отменяет ожидающий снимок.
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    if (waiting) for (const event of inputs) document.addEventListener(event, touch, true);
    const take = (s: ReturnType<typeof useStore.getState>, renew: boolean) => {
      if (left || !sameInstance()) return false;
      if ((s.conv.positionRev?.[id] ?? 0) !== entryPosition) touched = true;
      const summary = kind === 'dm' ? s.conv.summaries[id] : undefined;
      if (kind === 'dm' && !summary) return false;
      if (!touched || initialRead === null) setReadKey(summary?.lastReadKey ?? null);
      setKnown(true);
      if (renew && !touched) setVisit((n) => n + 1);
      return true;
    };
    const settle = () => {
      if (left || !sameInstance()) return;
      if (!take(useStore.getState(), true))
        offSummary = useStore.subscribe((s) => { if (take(s, true)) offSummary?.(); });
    };
    if (waiting) void entry.convEnsureList().then(settle, settle);
    else if (!take(entry, false))
      offSummary = useStore.subscribe((s) => { if (take(s, true)) offSummary?.(); });
    if (kind === 'dm' && !waiting && windowFocused()) readDmNow(id);
    /* 🔴 Перезагрузка, закрытие окна и выгрузка свёрнутого приложения уборку эффекта НЕ зовут: метка оставалась от
       прошлого визита, и следующий запуск ставил ленту к черте «Новые» над уже прочитанным (стенд 2г, 01.10). Черту
       ЭТОГО визита метка не двигает — она снята выше, при его начале. */
    const onLeave = () => { if (sameInstance()) markChannelSeen(id); };
    const onHidden = () => {
      if (sameInstance() && document.visibilityState === 'hidden') markChannelSeen(id);
    };
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      left = true;
      offSummary?.();
      for (const event of inputs) document.removeEventListener(event, touch, true);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onHidden);
      if (!sameInstance()) return;
      markChannelSeen(id);
      // Ушёл из ленты — значит прочитал: гасим счётчик, который до сих пор прятался за «текущим».
      if (kind === 'dm') readDmNow(id);
      else readChannelNow(id);
    };
  }, [id, viewing, kind, instanceEpoch, readChannelNow, readDmNow]);

  /**
   * Вернулся в окно — дочитал то, что пришло, пока оно было свёрнуто (#212).
   * Личное сообщение в открытую беседу при окне не в фокусе теперь горит непрочитанным, а не
   * отмечается тихо (`dmListRules.dmIncomingDecision`); гасит его возврат взгляда, как у Telegram.
   * У каналов такие сообщения пока отмечаются сразу — вызов для них ничего не меняет.
   */
  useEffect(() => {
    if (!viewing) return;
    const cacheKey = useStore.getState().convCacheKey;
    const onBack = () => {
      const current = useStore.getState();
      if (current.instanceEpoch !== instanceEpoch || current.convCacheKey !== cacheKey || !windowFocused()) return;
      if (kind === 'dm') readDmNow(id);
      else readChannelNow(id);
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [id, viewing, kind, instanceEpoch, readChannelNow, readDmNow]);

  /* `started` — визит начался (эффект выше отработал) и у беседы был ключ прочитанного: до этого `readKey` — не снимок, и лента не вправе
     сообщать увиденное (G09, `MessagePane.onSeen`) — она стоит внизу до прыжка к черте и «прочла» бы всё. */
  return { newSince, readKey, visitKey: `${id}#${visit}`, started: visit > 0 && known };
}
