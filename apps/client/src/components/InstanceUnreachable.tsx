import { activeInstanceId, instances } from '../config';
import { switchInstance } from '../instanceSwitch';
import { serverHost } from '../configRules';
import { Goose } from './Goose';

/**
 * «Ваш инстанс сейчас не отвечает» — вместо формы входа (#139, §5.6).
 *
 * 🔴 **Повод — сценарий 7 на стенде 18.09.** Погасили бэкенд дома, гость нажал «перейти домой» — и
 * увидел ОБЫЧНЫЙ экран входа: «С возвращением», поле пароля. Сессия при этом цела, токен на месте,
 * человек никуда не выходил. Он вводит пароль, тот уходит в мёртвый инстанс, и всё это выглядит как
 * «меня разлогинило и не пускает». Ровно так утром 18.09 выглядела и настоящая авария — путать эти
 * две вещи нельзя, потому что лечатся они противоположным: там надо было вводить другой пароль, а
 * здесь не надо вводить ничего, надо подождать.
 *
 * ⚠️ Поэтому здесь НЕТ полей ввода вообще. Только правда о том, что случилось, и два выхода:
 * попробовать снова и уйти в другой свой инстанс — рейла-то на этом экране нет, и без второй кнопки
 * человек с двумя инстансами заперт в лежащем.
 */
export function InstanceUnreachable({ onRetry }: { onRetry: () => void }) {
  const registry = instances();
  const activeId = activeInstanceId();
  const active = registry.find((i) => i.id === activeId) ?? null;
  const here = active?.name?.trim() || active?.domain || (active ? serverHost(active.apiUrl) : 'инстанс');
  // Записи БЕЗ токена сюда не берём: переход в них кончится экраном входа, то есть тем самым, от
  // чего этот экран и уводит.
  const others = registry.filter((i) => i.id !== activeId && !!i.token);

  return (
    <div className="center muted unreachable">
      <Goose pose="look" size={104} />
      <h2>«{here}» сейчас не отвечает</h2>
      <p>
        Вы не вышли из аккаунта — пароль вводить не нужно. Инстанс выключен, перезагружается или до
        него не доходит сеть. Попробуйте ещё раз через минуту.
      </p>
      <div className="unreachable-actions">
        <button type="button" onClick={onRetry}>
          Попробовать снова
        </button>
        {others.map((i) => (
          <button
            key={i.id}
            type="button"
            className="ghost"
            onClick={() => void switchInstance(i.id)}
          >
            Перейти в «{i.name?.trim() || i.domain || serverHost(i.apiUrl)}»
          </button>
        ))}
      </div>
    </div>
  );
}
