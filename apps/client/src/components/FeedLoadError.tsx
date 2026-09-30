/**
 * Лента не загрузилась, а показать нечего (#212, Б5).
 *
 * 🔴 Раньше сбой загрузки выглядел как вечные скелетоны: человек ждал, не понимая, что ждать нечего,
 * и лечил повторным кликом наугад. Плейбук UI требует различать «грузится», «пусто» и «не загрузилось»
 * (`docs/design/ui-playbook/02-states.md`) — это третье. Без гуся и шуток: человек ищет переписку,
 * а не дружелюбие.
 */
export function FeedLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="empty-goose feed-load-error" role="alert">
      <div className="eg-title">Не удалось загрузить переписку</div>
      <div className="eg-sub">Нет связи с сервером или он не ответил. Проверьте сеть и попробуйте ещё раз.</div>
      <button type="button" onClick={onRetry}>
        Повторить
      </button>
    </div>
  );
}
