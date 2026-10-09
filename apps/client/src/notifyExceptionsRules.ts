import { groupOfMuteTarget, type DmChannel } from '@gusvoice/shared';
import { dmMuteOf, muteActive, muteLeftLabel, muteSoundOff } from './dmListRules';

/**
 * «Исключения» в настройках уведомлений (08.10, #211, G38, `push3`) — как у Telegram («Уведомления → Личные чаты → Исключения»:
 * беседы с собственной настройкой; tdesktop `settings_notifications.cpp`: `lng_notification_exceptions`, список с кнопкой
 * сброса; Android `NotificationsCustomSettingsActivity`). Своей сущности нет: исключение — действующая заглушка беседы
 * (`push_mutes`: «Выключить уведомления» полностью или «Выключить звук», со сроком или навсегда), список строится из тех же
 * сведений, что строка беседы (`dmMuteOf`).
 */
export interface NotifyException {
  /** id беседы — по нему открываем её. */
  convId: string;
  /** Цель заглушки (`push_mutes.target_id`): id собеседника или `group:<беседа>` — по ней снимаем. */
  muteTarget: string;
  name: string;
  avatarUrl: string | null;
  group: boolean;
  /** Выключен только звук (`conv13`); иначе — уведомления выключены совсем. */
  soundOnly: boolean;
  /** Остаток срока («45 мин», «3 ч», «2 д»); пусто — навсегда. */
  left: string;
  /**
   * «Уведомления включены» (решение владельца 38, `push4`, `push_always`): беседа уведомляет при выключенных «Личных» / группах.
   * Нет поля — строка заглушки, как было.
   */
  enabled?: true;
}

/** Беседы с действующей заглушкой — в порядке списка бесед (свежие выше). Истёкшая заглушка исключением не считается. */
export function notifyExceptions(
  dms: readonly DmChannel[],
  mutedUsers: readonly string[],
  until: Readonly<Record<string, string>>,
  now: number,
  /** Подпись из моих контактов (`peerName.ts`, решение владельца 08.10 п.27); без него — имя из беседы. */
  nameOf: (userId: string, fallback: string) => string = (_id, n) => n,
  /** Цели исключений «Уведомления включены» (`push4`, `store.pushAlwaysTargets`); без него — только заглушки, как было. */
  always: readonly string[] = [],
): NotifyException[] {
  const out: NotifyException[] = [];
  for (const d of dms) {
    const mute = dmMuteOf(d, mutedUsers, until);
    const full = muteActive(mute, now);
    const sound = muteSoundOff(mute, now);
    const row = {
      convId: d.id,
      muteTarget: d.otherUser.id,
      name: nameOf(d.otherUser.id, d.otherUser.displayName),
      avatarUrl: d.otherUser.avatarUrl ?? null,
      group: !!d.group || groupOfMuteTarget(d.otherUser.id) !== null,
      soundOnly: sound,
    };
    // «Уведомления включены» (`push4`). Полная заглушка главнее (сервер снимает одно, ставя другое; пока событие не дошло —
    // показываем заглушку).
    if (!full && always.includes(d.otherUser.id)) {
      out.push({ ...row, left: sound ? muteLeftLabel(mute, now) : '', enabled: true });
      continue;
    }
    if (!full && !sound) continue;
    out.push({ ...row, left: muteLeftLabel(mute, now) });
  }
  return out;
}

/** Подпись под именем: «Уведомления выключены · навсегда», «Звук выключен · ещё 3 ч». */
export function notifyExceptionLabel(e: Pick<NotifyException, 'soundOnly' | 'left' | 'enabled'>): string {
  // «Уведомления включены» (`push4`), как Telegram «Включены» в списке исключений; со «Выключить звук» — «без звука».
  if (e.enabled) return e.soundOnly ? 'Уведомления включены · без звука' : 'Уведомления включены';
  const what = e.soundOnly ? 'Звук выключен' : 'Уведомления выключены';
  return `${what} · ${e.left ? `ещё ${e.left}` : 'навсегда'}`;
}

/**
 * Пункт меню беседы при выключенном общем выключателе её вида (решение владельца 38, `push4`; Telegram: при выключенных
 * «Личные чаты» в чате — «Включить уведомления», ставит `notify2_<did>` = 0): `enable` — «Включить уведомления» (исключение),
 * `disable` — «Выключить уведомления» (снять исключение); `null` — выключатель включён или сервер без `push4`: меню как было.
 * `target` — цель заглушки: id собеседника или `group:<id беседы>` (тогда смотрим «Уведомления из групп»).
 */
export function notifyAlwaysAction(
  target: string,
  o: { push4: boolean; notifyDm?: boolean; notifyGroups?: boolean; always: readonly string[] },
): 'enable' | 'disable' | null {
  if (!o.push4) return null;
  const off = groupOfMuteTarget(target) !== null ? o.notifyGroups === false : o.notifyDm === false;
  if (!off) return null;
  return o.always.includes(target) ? 'disable' : 'enable';
}

/** Заголовок списка: «Исключения» и число, когда есть. */
export function notifyExceptionsTitle(count: number): string {
  return count > 0 ? `Исключения · ${count}` : 'Исключения';
}
