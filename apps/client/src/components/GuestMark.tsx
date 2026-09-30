import type { User } from '@gusvoice/shared';
import { useMemo } from 'react';
import { useStore } from '../store';
import { guestHomeResolver } from '../rosterResolvers';
import { Icon } from './Icon';

type Home = NonNullable<User['homeInstance']>;

/**
 * Значок «человек с другого инстанса» (#139, F4, план §5.7).
 *
 * 🔴 Гость обязан быть отличим ВЕЗДЕ, где виден человек. Отличие не косметическое: его профиль, ник
 * и аватар живут на другом инстансе, личка с ним пока не работает (§5.8), и однажды он может
 * исчезнуть вместе со связкой. Человек, который этого не знает, пишет «чего не отвечаешь в личку» в
 * пустоту.
 *
 * 🔴 Источник ОДИН — общий ростер участников (`store.members`), как и у анимированного аватара.
 * Развесь мы поле по местам, где собираются данные для меню и плиток, где-нибудь его забыли бы
 * передать — и один и тот же человек был бы гостем в списке участников и «своим» в чате.
 *
 * ⚠️ Подпись — название инстанса от держателя, иначе домен, иначе просто значок: инстанс, чью
 * связку только что завели (или уже удалили), названия не имеет, а гостем человек быть не перестал.
 */
export function useGuestHome(): (userId: string | undefined) => Home | null {
  const members = useStore((s) => s.members);
  // Стабильная функция и поиск по словарю — ради `memo`-строк ленты (фаза 0.4 ЛС, 30.09), как `useAnimatedAvatarUrl`.
  return useMemo(() => {
    return guestHomeResolver(members);
  }, [members]);
}

export function guestHomeLabel(home: Home): string {
  return home.name?.trim() || home.domain || 'другой инстанс';
}

/**
 * Значок рядом с ником.
 *
 * ⚠️ `size` подбирается под соседний текст, а не задаётся «на глаз»: значок стоит в строке с ником,
 * и слишком крупный превращает список людей в список значков.
 */
export function GuestMark({ home, size = 12 }: { home: Home | null | undefined; size?: number }) {
  if (!home) return null;
  return (
    <span className="guest-mark" title={`С инстанса «${guestHomeLabel(home)}»`} aria-label={`гость с «${guestHomeLabel(home)}»`}>
      <Icon name="globe" size={size} />
    </span>
  );
}

/** Развёрнутая подпись — для карточки профиля и шторки, где место есть и объяснение уместно. */
export function GuestLine({ home }: { home: Home | null | undefined }) {
  if (!home) return null;
  return (
    <div className="guest-line">
      <Icon name="globe" size={12} /> с инстанса «{guestHomeLabel(home)}»
      {home.domain && home.domain !== guestHomeLabel(home) && <span className="muted"> · {home.domain}</span>}
    </div>
  );
}
