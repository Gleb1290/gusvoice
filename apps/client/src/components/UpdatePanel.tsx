import { useEffect, useState } from 'react';
import { useUpdate } from '../updateStore';
import { applyPendingUpdate, PANEL_DOWNLOAD_MIN_MS, relaunchApp, runDesktopUpdateCheck, snoozeUpdate } from '../updater';
import { shownDownloadFraction } from '../splashFlow';
import { Goose } from './Goose';

/**
 * Discord-style desktop auto-update card (round-7 design): a floating bottom-right card that tracks
 * the update through download → install → restart, with a "what's new" modal on click. Driven by the
 * update store + Tauri updater. Renders nothing on web / when idle.
 */
function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Значок карточки — голова маскота (16.10: был свой рисованный гусь старого образца, владелец: «старые все лого»). */
const GooseIcon = () => <Goose pose="head" size={32} />;
const CheckIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 13 L10 18 L19 7" />
  </svg>
);
const ErrorIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 L22 20 H2 Z" />
    <path d="M12 10 V14 M12 17 v.01" />
  </svg>
);
const RestartIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12 a8 8 0 1 0 2.3 -5.7 M4 4 v3 h3" />
  </svg>
);
const CloseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6 L18 18 M18 6 L6 18" />
  </svg>
);

/** Процент на полосе скачивания (15.10): не больше настоящего и не быстрее `PANEL_DOWNLOAD_MIN_MS` от
 *  начала — файл приходил за доли секунды, и полосу никто не успевал увидеть. Правило — `splashFlow`. */
function usePacedPct(active: boolean, startedAt: number, downloaded: number, total: number, done: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(id);
  }, [active]);
  const real = total > 0 ? downloaded / total : null;
  return Math.round(shownDownloadFraction(real, now - startedAt, PANEL_DOWNLOAD_MIN_MS, done) * 100);
}

export function UpdatePanel() {
  const { phase, version, notes, downloaded, total, startedAt, dlDone, viaSplash, error, set } = useUpdate();
  const [showNotes, setShowNotes] = useState(false);
  const pct = usePacedPct(phase === 'downloading', startedAt, downloaded, total, dlDone);
  if (phase === 'idle' || phase === 'checking') return null;

  const v = version ?? '';
  const isAvailable = phase === 'available';
  const isDownloading = phase === 'downloading';
  const isInstalling = phase === 'installing';
  const isReady = phase === 'ready';
  const isError = phase === 'error';

  const title = isAvailable
    ? `Доступно обновление ${v}`.trim()
    : isDownloading
      ? `Загрузка обновления ${v}`.trim()
      : isInstalling
        ? 'Устанавливаю…'
        : isReady
          ? `Обновление ${v} установлено`.trim()
          : 'Не удалось обновиться';
  const subtitle = isAvailable
    ? viaSplash
      ? 'поставится при перезапуске'
      : 'обновить можно, когда удобно'
    : isDownloading
      ? 'загрузка · GusVoice'
      : isInstalling
        ? 'приложение перезапустится само'
        : isReady
          ? 'нужен перезапуск'
          : error ?? 'проверьте соединение';
  const dismiss = () => set({ phase: 'idle', error: null });

  return (
    <>
      <div
        className={`update-panel update-${phase}`}
        role="status"
        aria-live="polite"
        onClick={() => setShowNotes(true)}
        style={{ cursor: 'pointer' }}
      >
        <div className="update-head">
          <div className="update-icon">{isReady ? <CheckIcon /> : isError ? <ErrorIcon /> : <GooseIcon />}</div>
          <div className="update-titles">
            <div className="update-title">{title}</div>
            <div className="update-sub">{subtitle}</div>
          </div>
          {(isAvailable || isDownloading || isError) && (
            <button
              className="update-close"
              aria-label="Скрыть"
              onClick={(e) => {
                e.stopPropagation();
                if (isAvailable) snoozeUpdate();
                else dismiss();
              }}
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {isDownloading && (
          <div className="update-dl">
            <div className="update-progress">
              <div className="update-progress-bar" style={{ width: `${pct}%` }}>
                <span className="update-shimmer" />
              </div>
            </div>
            <div className="update-dl-meta">
              <span className="update-pct">{pct}%</span>
              <span>
                {fmtMB(downloaded)} / {total > 0 ? fmtMB(total) : '…'}
              </span>
            </div>
          </div>
        )}

        {isInstalling && (
          <div className="update-progress">
            <div className="update-progress-bar indeterminate" />
          </div>
        )}

        {isAvailable && (
          <div className="update-actions">
            <button className="update-btn-primary" onClick={(e) => { e.stopPropagation(); void applyPendingUpdate(); }}>
              {viaSplash ? <><RestartIcon /> Перезапустить и обновить</> : 'Обновить'}
            </button>
            <button className="update-btn-ghost" onClick={(e) => { e.stopPropagation(); snoozeUpdate(); }}>
              Позже
            </button>
          </div>
        )}

        {isReady && (
          <div className="update-actions">
            <button className="update-btn-primary" onClick={(e) => { e.stopPropagation(); void relaunchApp(); }}>
              <RestartIcon /> Перезапустить
            </button>
            <button className="update-btn-ghost" onClick={(e) => { e.stopPropagation(); set({ phase: 'idle' }); }}>
              Позже
            </button>
          </div>
        )}

        {isError && (
          <div className="update-actions">
            <button className="update-btn-soft" onClick={(e) => { e.stopPropagation(); void runDesktopUpdateCheck(); }}>
              <RestartIcon /> Повторить
            </button>
            <button className="update-btn-ghost" onClick={(e) => { e.stopPropagation(); dismiss(); }}>
              Скрыть
            </button>
          </div>
        )}
      </div>

      {showNotes && (
        <div className="update-notes-scrim" onClick={() => setShowNotes(false)}>
          <div className="update-notes" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="update-notes-head">
              <div className="update-notes-goose">
                <GooseIcon />
              </div>
              <div className="update-notes-htext">
                <div className="update-notes-title">Что нового</div>
                <div className="update-notes-ver">{v || 'обновление'}</div>
              </div>
              <button className="update-close" aria-label="Закрыть" onClick={() => setShowNotes(false)}>
                <CloseIcon />
              </button>
            </div>
            <div className="update-notes-body">
              {notes && notes.trim() ? notes : 'Описание этой версии появится в заметках к релизу.'}
            </div>
            <div className="update-notes-foot">
              <button className="update-btn-ghost" onClick={() => setShowNotes(false)}>
                {isReady || isAvailable ? 'Позже' : 'Закрыть'}
              </button>
              {isReady && (
                <button className="update-btn-primary" onClick={() => void relaunchApp()}>
                  <RestartIcon /> Перезапустить
                </button>
              )}
              {isAvailable && (
                <button className="update-btn-primary" onClick={() => { setShowNotes(false); void applyPendingUpdate(); }}>
                  {viaSplash ? <><RestartIcon /> Перезапустить и обновить</> : 'Обновить'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
