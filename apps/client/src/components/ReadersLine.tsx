import { useEffect, useState } from 'react';
import type { ConvReader } from '@gusvoice/shared';
import { api } from '../api';
import { readersLabel } from '../lastSeenText';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/** Как показать прочитавшего: имя и аватар (как `MessagePane.ReactorLook`). */
export type ReaderLook = { name: string; avatarUrl: string | null };

/** Имя и аватар прочитавшего: сперва то, что знает лента (`reactorOf` — имена контактов и т.п.), иначе — из ответа сервера. */
export function readerLook(r: ConvReader, lookup?: (userId: string) => ReaderLook | null): ReaderLook {
  const known = lookup?.(r.userId) ?? null;
  return { name: known?.name ?? r.displayName ?? r.username, avatarUrl: known?.avatarUrl ?? r.avatarUrl };
}

/** Сколько аватарок в строке (Telegram Desktop `WhoReadParticipant::kMaxSmallUserpics` = 3, Web A `AvatarList` micro). */
const FACES_MAX = 3;

/**
 * Строка «N прочитали» в меню СВОЕГО прочитанного сообщения в группе ЛС (15.10, `readers1`; Telegram Desktop
 * `who_reacted_context_action.cpp`, Web A `MessageContextMenu` — пункт с иконкой, текстом и стопкой аватарок справа).
 * Один прочитавший — его имя; никого (все скрыли время прочтения) — «Никто не прочитал», пункт неактивен. Запрос — при
 * открытии меню; пока ответа нет — «Загрузка…» (строка занимает место сразу, меню не прыгает); ошибка или старше 7 суток —
 * строки нет. Нажатие — список прочитавших (`onOpen`).
 */
export function ReadersLine({
  convId,
  messageId,
  lookup,
  onOpen,
}: {
  convId: string;
  messageId: string;
  lookup?: (userId: string) => ReaderLook | null;
  onOpen: (list: ConvReader[]) => void;
}) {
  const [list, setList] = useState<ConvReader[] | null | 'none'>(null);
  useEffect(() => {
    let alive = true;
    setList(null);
    api.convReaders(convId, messageId).then(
      (v) => {
        if (alive) setList(v.expired ? 'none' : v.items);
      },
      () => {
        if (alive) setList('none');
      },
    );
    return () => {
      alive = false;
    };
  }, [convId, messageId]);
  if (list === 'none') return null;
  const loading = list === null;
  const items = loading ? [] : list;
  const looks = items.map((r) => readerLook(r, lookup));
  const label = loading ? 'Загрузка…' : readersLabel(looks.map((l) => l.name));
  return (
    <button
      type="button"
      role="menuitem"
      className="ctx-item ctx-seen"
      disabled={loading || looks.length === 0}
      onClick={() => {
        if (items.length > 0) onOpen(items);
      }}
    >
      <span className="ctx-ico">
        <Icon name="checks" size={16} />
      </span>
      <span className="ctx-label">
        <span className="ctx-label-main">{label}</span>
      </span>
      {looks.length > 0 ? (
        <span className="ctx-seen-faces" aria-hidden="true">
          {looks.slice(0, FACES_MAX).map((l, i) => (
            <Avatar key={items[i].userId} url={l.avatarUrl} name={l.name} size={20} />
          ))}
        </span>
      ) : null}
    </button>
  );
}
