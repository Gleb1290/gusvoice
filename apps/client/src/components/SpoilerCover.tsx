import { useSyncExternalStore } from 'react';
import type { Attachment } from '@gusvoice/shared';
import { revealSpoiler, spoilerHidden, subscribeSpoilers } from '../spoilerRules';

/**
 * Спойлер у фото и видео в ленте (08.10, #211, G48, `media2`): кадр размыт, поверх — зернистая «пыль» (CSS; движется под указателем,
 * при `prefers-reduced-motion` стоит), нажатие снимает спойлер локально. Пока закрыт — ни просмотра, ни «⬇», ни ▶ (CSS
 * `.spoiled` у `.att-img-wrap`); после снятия — обычное фото, просмотрщик открывается как всегда.
 */

/** Скрыто ли вложение прямо сейчас; перерисовывается, когда смотрящий нажал. */
export function useSpoilerHidden(a: Attachment): boolean {
  return useSyncExternalStore(
    subscribeSpoilers,
    () => spoilerHidden(a),
    () => false,
  );
}

/** Только «пыль» — украшение без нажатия (плитка окна отправки, плитка общих медиа). */
export function SpoilerParticles() {
  return <span className="spoiler-dust" aria-hidden="true" />;
}

/** Нажимаемая крышка поверх кадра в ленте. */
export function SpoilerCover({ a }: { a: Attachment }) {
  return (
    <button
      type="button"
      className="spoiler-cover"
      title="Нажмите, чтобы показать"
      aria-label="Скрыто под спойлером. Нажмите, чтобы показать"
      onClick={(e) => {
        e.stopPropagation();
        revealSpoiler(a);
      }}
    >
      <span className="spoiler-dust" aria-hidden="true" />
    </button>
  );
}
