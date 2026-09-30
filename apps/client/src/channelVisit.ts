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
): { newSince: number | null; visitKey: string } {
  const mobilePane = useStore((s) => s.mobilePane);
  const readChannelNow = useStore((s) => s.readChannelNow);
  const readDmNow = useStore((s) => s.readDmNow);
  const viewing = !isMobile() || mobilePane === 'content';
  const [newSince, setNewSince] = useState<number | null>(null);
  const [visit, setVisit] = useState(0);

  useEffect(() => {
    if (!viewing) return;
    setNewSince(lastSeenAt(id));
    setVisit((n) => n + 1);
    /* Беседа снова на глазах — дочитана (#212). После починки Б2 письма в ПОСЛЕДНЮЮ беседу, пока
       человек в сервере, горят непрочитанным; а вернуться к ней можно не через `selectDm`, а кнопкой
       «Личные сообщения» в рейле (`setView`), которая ничего не гасит. Без этого значок висел бы,
       пока человек читает. Каналы гасятся своим `openChannel`. */
    if (kind === 'dm' && windowFocused()) readDmNow(id);
    return () => {
      markChannelSeen(id);
      // Ушёл из ленты — значит прочитал: гасим счётчик, который до сих пор прятался за «текущим».
      if (kind === 'dm') readDmNow(id);
      else readChannelNow(id);
    };
  }, [id, viewing, kind, readChannelNow, readDmNow]);

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

  return { newSince, visitKey: `${id}#${visit}` };
}
