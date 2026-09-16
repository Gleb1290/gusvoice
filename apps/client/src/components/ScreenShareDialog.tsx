import { useEffect, useState } from 'react';
import {
  bitrateLabel,
  CODEC_OPTIONS,
  FPS_OPTIONS,
  getStreamSettings,
  RES_OPTIONS,
  setStreamSettings,
  type StreamCodec,
  type StreamSettings,
} from '../streamSettings';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { formatCombo, getHotkeys, isDesktop } from '../hotkeys';
import { gvScreenSources, type ScreenSource } from '../nativeScreenShare';
import { Icon } from './Icon';
import { Toggle } from './Toggle';

const MODE_HINT: Record<StreamSettings['mode'], string> = {
  detail: 'Чёткость — резкая картинка для текста и кода.',
  motion: 'Плавность — лучше для игр и видео.',
};

const CODEC_HINT: Record<StreamCodec, string> = {
  h264: 'Рекомендуется — аппаратный NVENC-энкод, ~0 CPU, декодится у всех в железе.',
  vp9: 'Резче текст при узком канале, но софт-энкод — грузит CPU на 1440p/60fps.',
};

type Tab = 'window' | 'screen' | 'camera';

const TABS: { key: Tab; label: string; group: string }[] = [
  { key: 'window', label: 'Окно', group: 'Открытые окна' },
  { key: 'screen', label: 'Весь экран', group: 'Экраны' },
  { key: 'camera', label: 'Камеры', group: 'Камеры' },
];

/** Stable-ish accent square for a source without a thumbnail: a colour + monogram from the title. */
function monogram(title: string): { mono: string; color: string } {
  const t = title.trim() || '?';
  const words = t.split(/[\s—–-]+/).filter(Boolean);
  const mono = (words.length > 1 ? words[0][0] + words[1][0] : t.slice(0, 2)).toUpperCase();
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return { mono, color: `hsl(${h % 360} 45% 42%)` };
}

/**
 * Native screen-share picker (desktop). Replaces WebView2's getDisplayMedia plate with an on-brand,
 * centred dialog: pick a window/screen/webcam + set quality, then start. The actual connect/publish is
 * done by the caller via `onStart`/`onStartCamera` (it holds the LiveKit room); this component only
 * collects the choice. The «Камеры» tab streams a webcam/capture-card AS a regular stream.
 */
export function ScreenShareDialog({
  onClose,
  onStart,
  onStartCamera,
}: {
  onClose: () => void;
  onStart: (args: { sourceId: string; isWindow: boolean }) => Promise<void>;
  onStartCamera: (args: { deviceId: string }) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('window');
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<StreamSettings>(() => getStreamSettings());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Комбинация для метки «сломалось» — читаем при открытии пикера, чтобы подсказка показывала
  // ФАКТИЧЕСКУЮ привязку (у неё есть значение по умолчанию, но человек мог её переназначить).
  const diagHotkey = formatCombo(getHotkeys().diagMark);
  // Esc + focus in/out — shared with the other dialogs (dialogChrome.ts).
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);

  useEffect(() => {
    let alive = true;
    gvScreenSources()
      .then((list) => alive && setSources(list))
      .catch(() => alive && setSources([]));
    return () => {
      alive = false;
    };
  }, []);

  // Enumerate webcams when the «Камеры» tab first opens. A one-shot getUserMedia probe comes first:
  // without a granted camera permission Chromium hides device labels (and this surfaces the WebView2
  // permission prompt NOW, at a predictable moment, not on «Начать»). Probe tracks stop immediately.
  useEffect(() => {
    if (tab !== 'camera' || cams !== null) return;
    let alive = true;
    void (async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        /* no camera / permission denied — enumerate anyway, the empty state explains */
      }
      try {
        const list = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === 'videoinput' && d.deviceId,
        );
        if (alive) setCams(list);
      } catch {
        if (alive) setCams([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tab, cams]);

  function update(patch: Partial<StreamSettings>) {
    setSettings((s) => {
      const next = { ...s, ...patch };
      setStreamSettings(next);
      return next;
    });
  }

  function pickTab(t: Tab) {
    setTab(t);
    setSelectedId(null);
  }

  const onTabsKey = tabListKeyDown(
    TABS.map((t) => t.key),
    tab,
    pickTab,
    (k) => `ss-tab-${k}`,
  );

  /**
   * radiogroup keyboard contract: arrows move the SELECTION (not just focus) through the cards, which
   * is also what makes the grid tabbable in one stop instead of one per source — with 20 windows open,
   * tabbing through every card to reach «Начать» is not navigation, it's a punishment.
   */
  function onGridKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    if (!items.length) return;
    e.preventDefault();
    const cur = items.findIndex((el) => el.dataset.id === selectedId);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (cur < 0) next = 0;
    else next = (cur + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    const el = items[next];
    setSelectedId(el.dataset.id ?? null);
    el.focus();
  }

  const visible = (sources ?? []).filter((s) => (tab === 'window' ? s.kind === 'window' : s.kind === 'screen'));

  async function confirm() {
    if (!selectedId || starting) return;
    setStarting(true);
    setError(null);
    try {
      if (tab === 'camera') await onStartCamera({ deviceId: selectedId });
      else await onStart({ sourceId: selectedId, isWindow: tab === 'window' });
      // success → the caller closes the dialog (it owns the sharing state).
    } catch (e) {
      setError((e as Error)?.message || 'Не удалось начать трансляцию');
      setStarting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal screen-share-dialog"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ss-title"
        tabIndex={-1}
      >
        <div className="admin-head">
          <h2 className="ss-title" id="ss-title">
            <Icon name="screen-share" size={18} /> Демонстрация экрана
          </h2>
          <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="admin-tabs ss-tabs" role="tablist" aria-label="Что транслировать" onKeyDown={onTabsKey}>
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`ss-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls="ss-panel"
              // Roving tabindex: the tablist is ONE tab stop, arrows move within it.
              tabIndex={tab === t.key ? 0 : -1}
              className={tab === t.key ? 'active' : ''}
              onClick={() => pickTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* The panel is the whole body, not just the grid: the quality settings below apply to the
            source picked on THIS tab (the camera tab even swaps the audio hint), so they belong to it. */}
        <div className="ss-body" id="ss-panel" role="tabpanel" aria-labelledby={`ss-tab-${tab}`}>
          <div
            className="ss-grid"
            role="radiogroup"
            aria-label={TABS.find((t) => t.key === tab)?.group}
            aria-busy={tab === 'camera' ? cams === null : sources === null}
            onKeyDown={onGridKey}
          >
            {tab === 'camera' ? (
              <>
                {cams === null
                  ? Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="ss-card skeleton" aria-hidden="true" />
                    ))
                  : cams.map((c, i) => {
                      const label = c.label || `Камера ${i + 1}`;
                      const { color } = monogram(label);
                      return (
                        <button
                          type="button"
                          key={c.deviceId}
                          role="radio"
                          aria-checked={selectedId === c.deviceId}
                          data-id={c.deviceId}
                          tabIndex={selectedId ? (selectedId === c.deviceId ? 0 : -1) : i === 0 ? 0 : -1}
                          className={`ss-card ${selectedId === c.deviceId ? 'selected' : ''}`}
                          onClick={() => setSelectedId(c.deviceId)}
                          title={label}
                        >
                          <span className="ss-card-thumb" style={{ background: color }}>
                            <span className="ss-card-mono">
                              <Icon name="camera" size={24} />
                            </span>
                            {selectedId === c.deviceId && (
                              <span className="ss-card-check">
                                <Icon name="check" size={13} />
                              </span>
                            )}
                          </span>
                          <span className="ss-card-name">{label}</span>
                        </button>
                      );
                    })}
                {cams !== null && cams.length === 0 && (
                  <div className="ss-empty">Камер не найдено (или нет доступа к камере)</div>
                )}
              </>
            ) : (
              <>
                {sources === null
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="ss-card skeleton" aria-hidden="true" />
                    ))
                  : visible.map((src, i) => {
                      const { mono, color } = monogram(src.title);
                      return (
                        <button
                          type="button"
                          key={src.id}
                          role="radio"
                          aria-checked={selectedId === src.id}
                          data-id={src.id}
                          tabIndex={selectedId ? (selectedId === src.id ? 0 : -1) : i === 0 ? 0 : -1}
                          className={`ss-card ${selectedId === src.id ? 'selected' : ''}`}
                          onClick={() => setSelectedId(src.id)}
                          title={src.title}
                        >
                          <span className="ss-card-thumb" style={src.thumb ? undefined : { background: color }}>
                            {src.thumb ? (
                              <img className="ss-card-img" src={src.thumb} alt="" draggable={false} />
                            ) : (
                              <span className="ss-card-mono">{mono}</span>
                            )}
                            {selectedId === src.id && (
                              <span className="ss-card-check">
                                <Icon name="check" size={13} />
                              </span>
                            )}
                          </span>
                          <span className="ss-card-name">{src.title}</span>
                        </button>
                      );
                    })}
                {sources !== null && visible.length === 0 && (
                  <div className="ss-empty">{tab === 'window' ? 'Нет открытых окон' : 'Экранов не найдено'}</div>
                )}
              </>
            )}
          </div>

          <div className="ss-settings">
            <div className="ss-row">
              <span className="settings-group-label" id="ss-res-label">
                Разрешение
              </span>
              {/* Segmented controls: a group with aria-pressed on each button. Tab reaches every option
                  (there are only a few), so no roving tabindex here — unlike the source grid. */}
              <div className="seg ss-seg" role="group" aria-labelledby="ss-res-label">
                {RES_OPTIONS.map((r) => (
                  <button
                    type="button"
                    key={r.value}
                    aria-pressed={settings.resolution === r.value}
                    className={settings.resolution === r.value ? 'on' : ''}
                    onClick={() => update({ resolution: r.value })}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="ss-row">
              <span className="settings-group-label" id="ss-fps-label">
                Частота кадров
              </span>
              <div className="seg ss-seg" role="group" aria-labelledby="ss-fps-label">
                {FPS_OPTIONS.map((f) => (
                  <button
                    type="button"
                    key={f}
                    aria-pressed={settings.fps === f}
                    aria-label={`${f} кадров в секунду`}
                    className={settings.fps === f ? 'on' : ''}
                    onClick={() => update({ fps: f })}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div className="ss-row col">
              <span className="settings-group-label" id="ss-mode-label">
                Режим
              </span>
              <div className="seg ss-seg" role="group" aria-labelledby="ss-mode-label" aria-describedby="ss-mode-hint">
                <button
                  type="button"
                  aria-pressed={settings.mode === 'detail'}
                  className={settings.mode === 'detail' ? 'on' : ''}
                  onClick={() => update({ mode: 'detail' })}
                >
                  Чёткость
                </button>
                <button
                  type="button"
                  aria-pressed={settings.mode === 'motion'}
                  className={settings.mode === 'motion' ? 'on' : ''}
                  onClick={() => update({ mode: 'motion' })}
                >
                  Плавность
                </button>
              </div>
              <span className="ss-hint" id="ss-mode-hint">
                {MODE_HINT[settings.mode]}
              </span>
            </div>

            <div className="ss-row col">
              <label className="settings-group-label" htmlFor="ss-codec">
                Кодек
              </label>
              <select
                id="ss-codec"
                className="settings-select"
                value={settings.codec}
                aria-describedby="ss-codec-hint"
                onChange={(e) => update({ codec: e.target.value as StreamCodec })}
              >
                {CODEC_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <span className="ss-hint" id="ss-codec-hint">
                {CODEC_HINT[settings.codec]}
              </span>
            </div>

            {/* Обходной путь для утечки в проводнике при показе ОКНА (#100). Современный способ
                захвата подтекает в explorer.exe — у одного человека тот вырос со 150 до 750 МБ за два
                часа показа, три сессии подряд, — а когда проводнику плохо, отваливаются Alt+Tab,
                «Пуск» и панель задач. Тот же баг с той же причиной известен у TeamSpeak 6.
                Показывать только на десктопе и только для вкладки окон: показа всего экрана это не
                касается (там другой механизм, и утечки нет). */}
            {isDesktop() && tab === 'window' && (
              <div className="ss-row">
                <span className="settings-group-label" id="ss-wgc-label">
                  Современный захват окна
                </span>
                <Toggle
                  checked={settings.wgcWindow}
                  onChange={(v) => update({ wgcWindow: v })}
                  labelledBy="ss-wgc-label"
                  describedBy="ss-wgc-hint"
                />
                <span className="ss-hint" id="ss-wgc-hint">
                  {settings.wgcWindow
                    ? 'Обычный режим. Если во время показа окна перестают работать Alt+Tab и «Пуск» — выключите: это лечит, но окна игр могут показываться чёрным.'
                    : 'Старый способ захвата: лечит зависание Alt+Tab и «Пуск», но окно игры может показываться чёрным. Тогда включите обратно и показывайте весь экран.'}
                </span>
              </div>
            )}

            {/* Запасной слой качества (#109). Показываем на ОБЕИХ вкладках и в вебе: беда не в том,
                что снимаем, а в том, сколько потоков публикуем. Без запасного слоя зритель с
                потерями просит опорные кадры, и пульсирует картинка у ВСЕХ зрителей сразу. */}
            <div className="ss-row">
              <span className="settings-group-label" id="ss-layers-label">
                Запасной слой качества
              </span>
              <Toggle
                checked={settings.layers}
                onChange={(v) => update({ layers: v })}
                labelledBy="ss-layers-label"
                describedBy="ss-layers-hint"
              />
              <span className="ss-hint" id="ss-layers-hint">
                {settings.layers
                  ? 'Обычный режим. Зритель со слабым интернетом получает картинку попроще, а не портит её всем остальным. Выключайте, только если показ вообще не запускается.'
                  : 'Один поток на всех. Показ запустится даже там, где видеокарта не тянет второй, но один зритель с плохой связью снова будет портить картинку всему каналу.'}
              </span>
            </div>

            {/* Превью показа (#115). Тумблер не про нагрузку, а про приватность: раньше, чтобы
                увидеть чужой экран, надо было зайти в канал — и человек об этом узнавал. Право
                решать, отдавать ли кадр, остаётся за показывающим. */}
            <div className="ss-row">
              <span className="settings-group-label" id="ss-preview-label">
                Превью для остальных
              </span>
              <Toggle
                checked={settings.streamPreview}
                onChange={(v) => update({ streamPreview: v })}
                labelledBy="ss-preview-label"
                describedBy="ss-preview-hint"
              />
              <span className="ss-hint" id="ss-preview-hint">
                {settings.streamPreview
                  ? 'Раз в несколько секунд отправляется маленький кадр: остальные видят по наведению мышкой, что вы показываете, не заходя в канал.'
                  : 'Кадры не отправляются. Чтобы увидеть ваш показ, придётся зайти в канал — и вы это заметите.'}
              </span>
            </div>

            <div className="ss-row">
              <span className="settings-group-label" id="ss-audio-label">
                Транслировать звук
              </span>
              <Toggle
                checked={settings.audio}
                onChange={(v) => update({ audio: v })}
                labelledBy="ss-audio-label"
                describedBy={tab === 'camera' && settings.audio ? 'ss-audio-hint' : undefined}
              />
            </div>
            {tab === 'camera' && settings.audio && (
              <div className="ss-hint" id="ss-audio-hint">
                Для камеры — звук самого устройства (например, капчур-карты), если у него есть аудиовход.
                Системный звук ПК не транслируется.
              </div>
            )}

            <div className="ss-row">
              <span className="settings-group-label" id="ss-bitrate-label">
                Битрейт
              </span>
              {/* Derived, not editable — a status readout, so it announces on change instead of on focus. */}
              <span className="ss-bitrate" role="status" aria-labelledby="ss-bitrate-label">
                ≈ {bitrateLabel(settings)}
              </span>
            </div>
          </div>

          {error && (
            <div className="ss-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="modal-actions ss-foot">
          {!selectedId && (
            <span className="ss-foot-hint" id="ss-foot-hint">
              Выберите источник
            </span>
          )}
          {/* Метка «сломалось» для отчёта диагностики (#100). Показываем здесь, а не в доке голоса:
              баг отбирает Alt+Tab, то есть саму возможность дойти до окна приложения, — кнопка там
              бесполезна (за сутки её не нажал никто). Момент старта показа — последний, когда человек
              и читает подсказку, и ещё может переключаться. */}
          {isDesktop() && diagHotkey && (
            <span className="ss-diag-hint">
              <span>
                Если во время показа откажут Alt+Tab или «Пуск» — нажмите <kbd>{diagHotkey}</kbd>, это
                отметит момент в отчёте. Переключаться в GusVoice не нужно.
              </span>
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            disabled={!selectedId || starting}
            aria-describedby={!selectedId ? 'ss-foot-hint' : undefined}
            onClick={confirm}
          >
            {starting ? 'Запуск…' : 'Начать трансляцию'}
          </button>
        </div>
      </div>
    </div>
  );
}
