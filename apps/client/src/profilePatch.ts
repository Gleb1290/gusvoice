import type { DmChannel, Message, ServerMemberInfo, User } from '@gusvoice/shared';

/** Что изменилось в профиле человека — ровно то, что несёт событие `user.update`. */
export interface ProfilePatch {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  animatedAvatarUrl: string | null;
}

/** Пять срезов стора, где живут копии профиля. Больше их быть не должно — см. предупреждение ниже. */
export interface ProfileSlices {
  members: ServerMemberInfo[];
  messagesByChannel: Record<string, Message[]>;
  dmMessages: Record<string, Message[]>;
  dms: DmChannel[];
  user: User | null;
}

/**
 * Разнести смену профиля по всем местам, где приложение держит копию человека.
 *
 * 🔴 Вынесено из стора 06.09 по разбору Codex, и повод серьёзный: **копий профиля пять, и баг #129
 * родился ровно на том, что одна из них осталась в стороне.** Пока это жило внутри `set(...)`,
 * проверить полноту было нечем.
 *
 * ⚠️ **Анимированный аватар попадает НЕ везде, и это осознанно, а не забывчивость.** В ростер и в
 * свой профиль — да, потому что все поверхности читают анимацию оттуда. А у автора сообщения и у
 * собеседника в личных такого поля нет в самом типе: там форма данных другая, и дописывать его
 * туда значило бы врать про DTO.
 *
 * ⚠️ Нетронутые коллекции возвращаются ТЕМИ ЖЕ ссылками: на них завязана перерисовка, и подмена
 * объекта на равный ему заставила бы перерисоваться всю переписку на каждую чужую смену аватара.
 */
export function applyUserProfilePatch(s: ProfileSlices, p: ProfilePatch): ProfileSlices {
  const { userId, displayName, avatarUrl, animatedAvatarUrl } = p;

  const patchAuthors = (byChannel: Record<string, Message[]>): Record<string, Message[]> => {
    let touched = false;
    const next: Record<string, Message[]> = {};
    for (const [id, list] of Object.entries(byChannel)) {
      if (!list.some((m) => m.author.id === userId)) {
        next[id] = list; // тот же массив — канал без его сообщений перерисовывать незачем
        continue;
      }
      touched = true;
      next[id] = list.map((m) =>
        m.author.id === userId ? { ...m, author: { ...m.author, displayName, avatarUrl } } : m,
      );
    }
    return touched ? next : byChannel;
  };

  const members = s.members.some((m) => m.user.id === userId)
    ? s.members.map((m) =>
        m.user.id === userId ? { ...m, user: { ...m.user, displayName, avatarUrl, animatedAvatarUrl } } : m,
      )
    : s.members;

  const dms = s.dms.some((d) => d.otherUser.id === userId)
    ? s.dms.map((d) =>
        d.otherUser.id === userId ? { ...d, otherUser: { ...d.otherUser, displayName, avatarUrl } } : d,
      )
    : s.dms;

  return {
    members,
    messagesByChannel: patchAuthors(s.messagesByChannel),
    dmMessages: patchAuthors(s.dmMessages),
    dms,
    user: s.user && s.user.id === userId ? { ...s.user, displayName, avatarUrl, animatedAvatarUrl } : s.user,
  };
}
