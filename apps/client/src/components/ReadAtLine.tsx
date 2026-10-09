import { useEffect, useState } from 'react';
import { api } from '../api';
import { readAtLabel } from '../lastSeenText';

/**
 * Строка «Прочитано в 12:34» в подвале меню СВОЕГО прочитанного сообщения в беседе 1:1 (С1, #211, `lastseen1`; Telegram
 * Desktop — строка с ✓✓ в меню, `api_who_reacted.cpp` `WhoReadExists` / `FormatReadDate`). Запрос — при открытии меню;
 * пока ответа нет или он с ошибкой — строки нет (✓✓ первой строки и так говорит «прочитано»).
 */
export function ReadAtLine({ convId, messageId }: { convId: string; messageId: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.convReadAt(convId, messageId).then(
      (v) => {
        if (alive) setText(readAtLabel(v, new Date()));
      },
      () => {
        /* строки нет */
      },
    );
    return () => {
      alive = false;
    };
  }, [convId, messageId]);
  if (!text) return null;
  return <span className="ctx-foot-line ctx-foot-read">{text}</span>;
}
