import { useSyncExternalStore } from 'react';
import {
  clearDownloads,
  downloadsSnapshot,
  opensInBrowser,
  removeDownload,
  subscribeDownloads,
  type DownloadEntry,
} from '../downloadList';
import { cancelFileJob, progressRatio, progressText, sizeText } from '../fileActions';
import { isDesktop, isMobile } from '../hotkeys';
import { saveObjectUrl, startDownload } from '../pcDownloads';
import { ProgressRing } from './FileCard';
import { Icon } from './Icon';

/**
 * Раздел «Загрузки» в «Данные и память» (G31, 08.10): что качали в этой вкладке — как tdesktop «Загрузки» (Настройки →
 * Продвинутые) и Android «Недавние загрузки» (`SearchDownloadsContainer`). Строка — разметка списка папок (`dmf-row`): кольцо с
 * отменой, пока качается; готовое — «Открыть» (браузер, то, что он покажет сам) и «Сохранить снова»; неудача и отмена —
 * «Повторить»; «Убрать из списка». Внизу — «Очистить список загрузок».
 */

const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function statusText(e: DownloadEntry): string {
  switch (e.state) {
    case 'loading':
      return progressText(e.loaded, e.total);
    case 'done':
      return `${sizeText(e.total)} · ${TIME.format(e.at)}`;
    case 'failed':
      return 'Не удалось скачать';
    case 'cancelled':
      return 'Загрузка отменена';
  }
}

function DownloadRow({ e, canOpen }: { e: DownloadEntry; canOpen: boolean }) {
  const loading = e.state === 'loading';
  return (
    <div className="dmf-row" data-dl={e.state}>
      {loading ? (
        <button type="button" className="head-icon" title="Отменить загрузку" aria-label="Отменить загрузку" onClick={() => cancelFileJob(e.key)}>
          <ProgressRing ratio={progressRatio(e.loaded, e.total)} />
        </button>
      ) : (
        <span className="dmf-ico">
          <Icon name="file" size={20} />
        </span>
      )}
      <span className="dmf-main">
        <span className="dmf-title" title={e.name}>
          {e.name}
        </span>
        <span className="dmf-sub">{statusText(e)}</span>
      </span>
      {e.state === 'done' && e.href && canOpen && opensInBrowser(e.type) ? (
        <button
          type="button"
          className="head-icon"
          title="Открыть"
          aria-label="Открыть"
          onClick={() => window.open(e.href, '_blank', 'noopener')}
        >
          <Icon name="arrow-up-right" size={18} />
        </button>
      ) : null}
      {e.state === 'done' && e.href ? (
        <button
          type="button"
          className="head-icon"
          title="Сохранить снова"
          aria-label="Сохранить снова"
          onClick={() => e.href && saveObjectUrl(e.href, e.name)}
        >
          <Icon name="download" size={18} />
        </button>
      ) : null}
      {e.state === 'failed' || e.state === 'cancelled' ? (
        <button
          type="button"
          className="head-icon"
          title="Повторить"
          aria-label="Повторить"
          onClick={() => {
            removeDownload(e.id);
            startDownload({ key: e.key, url: e.url, name: e.name, size: e.total || undefined, type: e.type });
          }}
        >
          <Icon name="repeat" size={18} />
        </button>
      ) : null}
      {loading ? null : (
        <button type="button" className="head-icon" title="Убрать из списка" aria-label="Убрать из списка" onClick={() => removeDownload(e.id)}>
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}

export function DownloadsList() {
  const list = useSyncExternalStore(subscribeDownloads, downloadsSnapshot);
  // Десктоп-оболочка: новые окна WebView2 не открывает — «Открыть» только в браузере.
  const canOpen = !isDesktop();
  return (
    <>
      <div className="settings-group-label" id="set-g-dllist">
        Загрузки
      </div>
      {list.length === 0 ? (
        <div className="muted">Нет недавних загрузок</div>
      ) : (
        <div aria-live="polite">
          {list.map((e) => (
            <DownloadRow key={e.id} e={e} canOpen={canOpen} />
          ))}
        </div>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        {isDesktop()
          ? 'Файлы, скачанные в этом окне. Сами файлы — в папке загрузок (Настройки → Десктоп); после перезапуска список пуст.'
          : isMobile()
            ? 'Файлы, скачанные в этом приложении. Сами файлы — в загрузках телефона; после перезапуска список пуст.'
            : 'Файлы, скачанные в этой вкладке. Сами файлы — в загрузках браузера; после перезагрузки страницы список пуст.'}
      </div>
      {list.some((e) => e.state !== 'loading') ? (
        <button type="button" className="settings-action" onClick={clearDownloads}>
          Очистить список загрузок
        </button>
      ) : null}
    </>
  );
}
