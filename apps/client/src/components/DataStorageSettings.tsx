import { useEffect, useState, type CSSProperties } from 'react';
import { resetAutoDownload, saveDataOn, setAutoDownload, useAutoDownload } from '../autoDownload';
import {
  AUTO_DOWNLOAD_DEFAULTS,
  LIMIT_STEPS_MB,
  limitIndex,
  MEDIA_SOURCES,
  SWITCH_KINDS,
  type AutoDownloadSettings,
  type MediaSource,
  type SwitchKind,
} from '../autoDownloadRules';
import { confirmAction } from '../confirm';
import { sizeText } from '../fileActions';
import { isMobile, isTauri } from '../hotkeys';
import { sameValue } from '../settingsChanged';
import { clearDeviceCache, measureStorage, type StorageUsage } from '../storageUsage';
import { toast } from '../toast';
import { DownloadsList } from './DownloadsList';
import { RaiseToEarSetting } from './RaiseToEarSetting';
import { Toggle } from './Toggle';

/**
 * Раздел настроек «Данные и память» (G32, FD-10, FD-12, FA-06–FA-10, UN-24) — как «Данные и память» Telegram:
 * автозагрузка медиа по типам и источникам с пределом размера (`boxes/auto_download_box.cpp`), автовоспроизведение GIF и
 * видео, «Использование памяти» с «Очистить кэш» (`settings_local_storage.cpp`, Android `CacheControlActivity`).
 * Правило — `autoDownloadRules.ts`, хранение — `autoDownload.ts` (на этом устройстве), место — `storageUsage.ts`.
 */

const SOURCE_LABEL: Record<MediaSource, string> = { dm: 'Личные', group: 'Группы', channel: 'Каналы' };
const KIND_LABEL: Record<SwitchKind, string> = { photo: 'Фото', video: 'Видео', gif: 'GIF' };

function LimitSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (mb: number) => void;
}) {
  const i = limitIndex(value);
  const max = LIMIT_STEPS_MB.length - 1;
  return (
    <label className="settings-row col">
      <span>
        {label} · до {LIMIT_STEPS_MB[i]} МБ
      </span>
      <input
        type="range"
        className="gv-range"
        min={0}
        max={max}
        step={1}
        value={i}
        style={{ ['--p']: i / max } as CSSProperties}
        onChange={(e) => onChange(LIMIT_STEPS_MB[Number(e.target.value)] ?? value)}
      />
    </label>
  );
}

function AutoDownloadPanel() {
  const s = useAutoDownload();
  const save = saveDataOn();
  const put = (patch: Partial<AutoDownloadSettings>) => setAutoDownload({ ...s, ...patch });
  const flip = (kind: SwitchKind, src: MediaSource, on: boolean) => put({ [kind]: { ...s[kind], [src]: on } });
  const changed = !sameValue(s, AUTO_DOWNLOAD_DEFAULTS);
  return (
    <>
      <div className="settings-group-label" id="set-g-autodl">
        Автозагрузка медиа
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Что лента качает сама, а что показывает плиткой с кнопкой «Скачать». Настройка только для этого устройства.
      </div>
      {save ? (
        <div className="autodl-note" role="note">
          Браузер просит экономить трафик: фото качаются до 1 МБ, видео и GIF — до 500 КБ, само ничего не играет.
        </div>
      ) : null}
      <div className="autodl-grid" role="group" aria-label="Автозагрузка по типам и источникам">
        <span />
        {MEDIA_SOURCES.map((src) => (
          <span key={src} className="autodl-head">
            {SOURCE_LABEL[src]}
          </span>
        ))}
        {SWITCH_KINDS.map((kind) => (
          <div key={kind} className="autodl-row">
            <span className="autodl-kind">{KIND_LABEL[kind]}</span>
            {MEDIA_SOURCES.map((src) => (
              <span key={src} className="autodl-cell">
                <Toggle
                  checked={s[kind][src]}
                  onChange={(v) => flip(kind, src, v)}
                  label={`${KIND_LABEL[kind]}: ${SOURCE_LABEL[src].toLowerCase()}`}
                />
              </span>
            ))}
          </div>
        ))}
      </div>
      <LimitSlider label="Фото" value={s.photoLimitMb} onChange={(mb) => put({ photoLimitMb: mb })} />
      <LimitSlider label="Видео и GIF" value={s.videoLimitMb} onChange={(mb) => put({ videoLimitMb: mb })} />
      <div className="muted" style={{ fontSize: 12 }}>
        Голосовые и файлы заранее не качаются никогда: голосовое загружается, когда его включают, файл — по нажатию.
      </div>

      <div className="settings-group-label" id="set-g-autoplay">
        Автовоспроизведение
      </div>
      <div className="settings-row">
        <span>GIF</span>
        <Toggle checked={s.autoplayGif} onChange={(v) => put({ autoplayGif: v })} label="Автовоспроизведение GIF" />
      </div>
      <div className="settings-row">
        <span>Видео</span>
        <Toggle checked={s.autoplayVideo} onChange={(v) => put({ autoplayVideo: v })} label="Автовоспроизведение видео" />
      </div>
      <div className="settings-row">
        <span>Видеосообщения</span>
        <Toggle checked={s.autoplayRound} onChange={(v) => put({ autoplayRound: v })} label="Автовоспроизведение видеосообщений" />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Играет в ленте само, без звука и по кругу. Выключено — кадр с ▶, играет по нажатию.
      </div>
      <RaiseToEarSetting />
      {changed ? (
        <button type="button" className="settings-action" onClick={resetAutoDownload}>
          Сбросить настройки автозагрузки
        </button>
      ) : null}
    </>
  );
}

function bytesText(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '0 KB';
  // Квота браузера — гигабайты: «10240.0 MB» не читается.
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : sizeText(n);
}

function StoragePanel() {
  const [u, setU] = useState<StorageUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    measureStorage()
      .then(setU)
      .catch(() => setU(null));
  };
  useEffect(refresh, []);
  const clear = async () => {
    const ok = await confirmAction({
      title: 'Очистить кэш?',
      body: 'Сохранённые ленты бесед загрузятся заново из сети. Вход, настройки, черновики и неотправленные сообщения останутся.',
      confirmLabel: 'Очистить',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const done = await clearDeviceCache();
      if (done) toast('success', 'Кэш очищен');
      else toast('error', 'Не удалось очистить кэш целиком');
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <>
      <div className="settings-group-label" id="set-g-storage">
        Использование памяти
      </div>
      <div className="storage-list" aria-live="polite">
        <div className="settings-row">
          <span>Сохранённые ленты бесед</span>
          <span className="storage-val">{u ? bytesText(u.conv?.messageBytes) : '…'}</span>
        </div>
        <div className="settings-row">
          <span>Список бесед и черновики</span>
          <span className="storage-val">{u ? bytesText(u.conv ? u.conv.bytes - u.conv.messageBytes : null) : '…'}</span>
        </div>
        {u?.caches != null ? (
          <div className="settings-row">
            <span>Кэш файлов (Cache Storage)</span>
            <span className="storage-val">{bytesText(u.caches)}</span>
          </div>
        ) : null}
        <div className="settings-row">
          <span>Всего занято на устройстве</span>
          <span className="storage-val">
            {u ? bytesText(u.total) : '…'}
            {u?.quota ? <span className="muted"> из {bytesText(u.quota)}</span> : null}
          </span>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {isTauri()
          ? `Картинки и видео из лент приложение хранит во временном кэше${isMobile() ? ' — его можно очистить и в настройках телефона (Приложения → GusVoice → Хранилище)' : ''}. Здесь очищается то, что сохранил сам GusVoice.`
          : 'Картинки и видео из лент браузер хранит в своём кэше — его чистят в настройках браузера («Удалить данные о просмотре»). Здесь очищается то, что сохранил сам GusVoice.'}
      </div>
      <button type="button" className="settings-action" disabled={busy} onClick={() => void clear()}>
        {busy ? 'Очищаем…' : 'Очистить кэш'}
      </button>
    </>
  );
}

export function DataStorageSettings() {
  return (
    <div className="settings-pane">
      <AutoDownloadPanel />
      <DownloadsList />
      <StoragePanel />
    </div>
  );
}
