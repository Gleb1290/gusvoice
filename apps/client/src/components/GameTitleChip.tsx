import { GAME_TITLE_ABOUT, type GameTitleKey } from '@gusvoice/shared';
import { titleMonogram } from '../gameBoardRules';

/**
 * Значок звания месяца (ГусКоины 2, этап 6) — у строки таблицы игр, в кошельке и в карточке человека.
 *
 * Иконка — `assets/titles/<ключ>.png|svg|webp` (рисует Codex, по одной на ключ звания): файл подхватывается сам, без правки
 * кода. Пока файла нет — монограмма названия на акцентном кружке. Название приходит с сервера (владелец мог
 * переименовать), описание — по поводу и верно при любом названии.
 */
const ICONS: Record<string, string> = import.meta.glob<string>('../assets/titles/*.{png,svg,webp}', {
  eager: true,
  import: 'default',
  query: '?url',
});

/** URL иконки звания или `null` — тогда монограмма. */
export function titleIconUrl(key: GameTitleKey): string | null {
  for (const ext of ['png', 'svg', 'webp']) {
    const url = ICONS[`../assets/titles/${key}.${ext}`];
    if (url) return url;
  }
  return null;
}

/** Кружок-значок без подписи (`size` — px). */
export function GameTitleMark({ titleKey, name, size = 18 }: { titleKey: GameTitleKey; name: string; size?: number }) {
  const url = titleIconUrl(titleKey);
  return (
    <span className={`gt-mark${url ? ' gt-mark-art' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {url ? <img src={url} alt="" /> : titleMonogram(name)}
    </span>
  );
}

/** Чип: значок + название (`compact` — только значок, название во всплывающей подсказке). */
export function GameTitleChip({ titleKey, name, compact = false }: { titleKey: GameTitleKey; name: string; compact?: boolean }) {
  return (
    <span className={`gt-chip${compact ? ' gt-chip-compact' : ''}`} title={`${name} — ${GAME_TITLE_ABOUT[titleKey]}`}>
      <GameTitleMark titleKey={titleKey} name={name} size={compact ? 20 : 18} />
      {!compact && <span className="gt-chip-name">{name}</span>}
    </span>
  );
}
