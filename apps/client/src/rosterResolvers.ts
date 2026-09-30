import type { User } from '@gusvoice/shared';

/**
 * Поиск по ростеру участников для ленты сообщений — чистые фабрики без React и стора (просьба Codex 30.09).
 *
 * Хуки `useAnimatedAvatarUrl` (`avatarAnimation.ts`) и `useGuestHome` (`components/GuestMark.tsx`) зовут их внутри
 * `useMemo`: лента держит строки `memo`, поэтому функция поиска обязана быть одной и той же, пока ростер не сменился
 * (фаза 0.4 ЛС). Здесь — только сам поиск: словарь строится один раз, а не `find` по ростеру на каждое сообщение.
 */
type RosterUser = Pick<User, 'id' | 'animatedAvatarUrl' | 'homeInstance'>;
type Home = NonNullable<User['homeInstance']>;

export function animatedAvatarResolver(members: ReadonlyArray<{ user: RosterUser }>): (userId: string | undefined) => string | undefined {
  const byId = new Map(members.map((m) => [m.user.id, m.user.animatedAvatarUrl]));
  return (userId) => (userId ? byId.get(userId) : null) ?? undefined;
}

export function guestHomeResolver(members: ReadonlyArray<{ user: RosterUser }>): (userId: string | undefined) => Home | null {
  const byId = new Map(members.map((m) => [m.user.id, m.user.homeInstance ?? null]));
  return (userId) => (userId ? (byId.get(userId) ?? null) : null);
}
