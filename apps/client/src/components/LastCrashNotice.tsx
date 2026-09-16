import { useState } from 'react';
import { clearCrash, copySavedCrash, readCrash, type CrashReport } from '../crashReport';
import { relativeTime } from '../relativeTime';
import { toast } from '../toast';
import { Icon } from './Icon';

/**
 * Полоска «прошлый сеанс завершился аварией» с кнопкой скопировать отчёт.
 *
 * 🔴 Заведено 06.09 по разбору Codex, и это НЕ украшение. Граница ошибок сохраняла отчёт в
 * хранилище, а `readCrash` не вызывался нигде, кроме собственного теста: запись лежала мёртвым
 * грузом. При этом в заметках к v0.6.54 людям было обещано, что отчёт «переживает перезагрузку,
 * так что его можно прислать и позже». Обещание было, механизма — нет; тест на читателя при этом
 * зеленел и создавал полную иллюзию работы.
 *
 * ⚠️ Показываем ПОСЛЕ перезагрузки, а не вместо экрана аварии: тот живёт в `ErrorBoundary` и виден
 * сразу. Этот — про «вы уже перезагрузились, отчёт ещё у нас».
 */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function LastCrashNotice() {
  // Читаем ОДИН раз при монтировании: отчёт пишется только при аварии, а после неё дерево всё
  // равно пересобирается перезагрузкой.
  const [crash, setCrash] = useState<CrashReport | null>(() => readCrash(safeStorage()));
  if (!crash) return null;

  const dismiss = () => {
    clearCrash(safeStorage());
    setCrash(null);
  };

  const copy = () => {
    // Решение «копировать и забыть» — в `copySavedCrash` под тестами: там же правило, что отказ
    // буфера обмена НЕ стирает отчёт. Потерять единственную улику из-за отказа копирования нельзя.
    void copySavedCrash(crash, {
      writeText: (t) => navigator.clipboard.writeText(t),
      clear: () => clearCrash(safeStorage()),
    }).then((ok) => {
      if (!ok) return toast('error', 'Не удалось скопировать отчёт');
      setCrash(null);
      toast('success', 'Отчёт скопирован', 'Пришлите его — по нему видно, что именно сломалось.');
    });
  };


  // Расчёт времени — общий с журналом действий: две копии одного правила разъехались бы.
  const when = crash.at ? relativeTime(crash.at, Date.now()) : '';
  return (
    <div className="gv-crash-bar" role="status">
      <Icon name="bolt" size={16} />
      <span className="gv-crash-bar-text">
        Прошлый раз приложение аварийно закрылось{when ? ` (${when})` : ''}. Отчёт сохранён.
      </span>
      <button type="button" className="gv-crash-btn primary" onClick={copy}>
        Скопировать отчёт
      </button>
      <button type="button" className="gv-crash-btn" onClick={dismiss} title="Забыть отчёт">
        Скрыть
      </button>
    </div>
  );
}
