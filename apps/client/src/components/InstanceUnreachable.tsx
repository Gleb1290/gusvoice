import type { EntryTarget } from '../entryRules';
import { Goose } from './Goose';

export type EntryProblem = 'checking' | 'unreachable' | 'refused' | 'guest';

export function EntryChoices({
  targets,
  onSelect,
}: {
  targets: readonly EntryTarget[];
  onSelect: (id: string) => void;
}) {
  return targets.map(({ id, host }) => (
    <button key={id} type="button" className="ghost" onClick={() => onSelect(id)}>
      Перейти в «{host}»
    </button>
  ));
}

/** Нейтральная навигация доступна с первого кадра, пока проверяется текущий инстанс. */
export function InstanceUnreachable({
  problem,
  host,
  savedSession,
  notice,
  targets,
  onSelect,
  onRetry,
  onReturnToVoice,
  onLeaveVoice,
}: {
  problem: EntryProblem;
  host: string;
  savedSession: boolean;
  notice: string | null;
  targets: readonly EntryTarget[];
  onSelect: (id: string) => void;
  onRetry?: () => void;
  onReturnToVoice?: () => void;
  onLeaveVoice?: () => void;
}) {
  const checking = problem === 'checking';
  const title = checking
    ? `Подключаемся к «${host}»…`
    : problem === 'unreachable'
      ? `«${host}» сейчас не отвечает`
      : problem === 'refused'
        ? `Не удалось проверить вход на «${host}»`
        : `Гостевой вход на «${host}» недоступен`;

  return (
    <div className="center muted unreachable">
      {!checking && <Goose pose="look" size={104} />}
      <h2 aria-live="polite">{title}</h2>
      {notice && <p>{notice}</p>}
      {problem === 'unreachable' && savedSession && <p>Вход сохранён. Попробуйте подключиться снова.</p>}
      {problem === 'refused' && <p>Инстанс ответил, но проверка не прошла.</p>}
      <div className="unreachable-actions">
        {onRetry && <button type="button" onClick={onRetry}>Попробовать снова</button>}
        {onReturnToVoice && (
          <button type="button" onClick={onReturnToVoice}>Вернуться к инстансу голосового канала</button>
        )}
        <EntryChoices targets={targets} onSelect={onSelect} />
        {onLeaveVoice && (
          <button type="button" className="ghost" onClick={onLeaveVoice}>Выйти из голосового канала</button>
        )}
      </div>
    </div>
  );
}
