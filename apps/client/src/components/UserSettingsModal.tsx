import {
  CAP_CONV1,
  FEATURE_CONV2,
  normalizeNotifyRepeat,
  normalizeNotifyView,
  notifyRepeatLabel,
  notifyShowsName,
  notifyShowsText,
  notifyViewOf,
  NOTIFY_REPEAT_MAX,
  NOTIFY_REPEAT_MINUTES,
} from '@gusvoice/shared';
import { hasFolderEditRequest, useFoldersOn } from './DmFolderBar';
import { DataStorageSettings } from './DataStorageSettings';
import { DmFolderSettings } from './DmFolderSettings';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushBackHandler } from '../androidBack';
import { activeAnchor, atBottomOf, groupLabelAt } from '../settingsAnchor';
import { markChangedSeen, markGroupSeen, seedSeenOnce, seenChangedPrints, seenGroups } from '../settingsSeen';
import { api, setToken } from '../api';
import { getAudioSettings, setAudioSettings, type AudioSettings } from '../audioSettings';
import { VAD_THRESHOLD_MAX, VAD_THRESHOLD_MIN } from '../micProcessorRules';
import {
  activeInstance,
  activeInstanceId,
  clearServer,
  config,
  currentServer,
  isPickerBuild,
  multiInstanceEnabled,
  RELEASES_URL,
  renameInstance,
  serverHost,
} from '../config';
import {
  appVersion,
  type CloseBehavior,
  getCloseBehavior,
  gpuAccelGet,
  gpuAccelSet,
  openExternal,
  setCloseBehavior,
} from '../desktopWindow';
import { useDialogChrome } from '../dialogChrome';
import { chooseDownloadDir, getDownloadDir, setDownloadDir } from '../downloads';
import { comboFromEvent, comboFromMouse, formatCombo, getHotkeys, type Hotkeys, isAndroid, isDesktop, isMobile, isTauri, setHotkeys } from '../hotkeys';
import { hasPushDistributor } from '../nativeUnifiedPush';
import { useStore } from '../store';
import { convClientSwitch, feedWindowSwitch, setConvClientSwitch, setFeedWindowSwitch } from '../convStore';
import { dmBubblesSwitch, setDmBubblesSwitch } from '../dmBubbles';
import {
  coinNotifyLevel,
  notifyPermissionState,
  osNotify,
  osNotifyLevel,
  requestNotifyPermission,
  setCoinNotifyLevel,
  setOsNotifyLevel,
  type NotifyPermission,
} from '../notifications';
import type { CoinNotifyLevel } from '../coinNotifyRules';
import type { OsNotifyLevel } from '../notifyRules';
import { manualUpdateCheck } from '../updater';
import { getTheme, setTheme, type Theme } from '../theme';
import {
  getSidebarWidth,
  getUiScale,
  setSidebarWidth,
  setUiScale,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  UI_SCALES,
  type UiScale,
} from '../uiPrefs';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { AvatarCropModal } from './AvatarCropModal';
import { Icon, type IconName } from './Icon';
import { NotifyExceptions } from './NotifyExceptions';
import { Select } from './Select';
import { RailAnchor, RailAnchors, RailItem, SettingsHead, SettingsRail, SettingsSearch, SettingsWindow } from './SettingsShell';
import {
  changedDotOn,
  groupPrints,
  markChanged,
  marksLabel,
  sameMarks,
  samePrints,
  sectionMark,
  type SettingsMarks,
} from '../settingsChanged';
import { SEARCH_MIN, searchSettings, SECTIONS, sectionOf, type SectionKey, visibleSections } from '../settingsNav';
import { factorySettings, readSettings } from '../settingsSnapshot';
import { GuestPlacesPanel } from './GuestPlacesPanel';
import { InstancesPanel } from './InstancesPanel';
import { useFederationEnabled } from '../federationClient';
import { OverlaySettingsPanel } from './OverlaySettingsPanel';
import { ToastSettingsPanel } from './ToastSettingsPanel';
import { SoundSettingsPanel } from './SoundSettingsPanel';
import { StreamQualityPanel } from './StreamQualityPanel';
import { getStreamSettings, setStreamSettings } from '../streamSettings';
import { Toggle } from './Toggle';
import { animatedAvatarsEnabled, setAnimatedAvatarsEnabled } from '../avatarAnimation';
import { liteModeEnabled, setLiteModeEnabled } from '../liteMode';
import { linkPreviewsEnabled, setLinkPreviewsEnabled } from './LinkPreview';
import { getSendMode, setSendMode, type SendMode } from '../sendMode';
import { emojiSuggestEnabled, setEmojiSuggestEnabled } from '../emojiSuggest';
import { setListLines, useListLines, type ListLines } from '../dmListView';
import { ChatSwipeSetting } from './DmListSwipe';
import {
  type DoubleClickAction,
  getDoubleClickAction,
  getQuickReaction,
  quickBarOrder,
  setDoubleClickAction,
  setQuickReaction,
} from '../quickReaction';
import { QUICK_REACTIONS } from './ContextMenu';
import { EmojiPicker } from './EmojiPicker';
import {
  forgetTrustedLinkAuthors,
  linkWarningsOff,
  setLinkWarningsOff,
  trustedLinkAuthors,
} from '../linkGuard';
import { DiagSettingsSection } from './DiagConsent';
import type { LastSeenPrivacy } from '@gusvoice/shared';
import { serverLastSeen } from '../lastSeenText';
import { LastSeenExceptionsBlock } from './LastSeenExceptions';
import { serverCallPrivacy } from '../lastSeenExceptionsRules';
import { serverCalls } from '../callView';
import { serverPush2, serverPush3 } from '../convSyncRules';



/**
 * Курсор в трансляции (28.09) — своим пунктом слева, по правилу «новая настройка = пункт в рельсе».
 * Та же галочка стоит в окне выбора показа. Пишем поверх СВЕЖИХ настроек, а не своей копии: рядом
 * живёт панель качества со своим состоянием.
 */
function StreamCursorSetting() {
  const [on, setOn] = useState(() => getStreamSettings().cursor !== false);
  return (
    <>
      <div className="settings-group-label" id="set-g-stream-cursor" style={{ marginTop: 18 }}>
        Курсор в трансляции
      </div>
      <div className="settings-row">
        <span>Показывать курсор зрителям</span>
        <Toggle
          checked={on}
          onChange={(v) => {
            setStreamSettings({ ...getStreamSettings(), cursor: v });
            setOn(v);
          }}
          label="Показывать курсор зрителям"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Зрители видят ваш курсор поверх экрана или окна. Если игра прячет курсор, его не видно и в показе.
        Применяется при следующем запуске показа.
      </div>
    </>
  );
}

const LAST_SEEN_OPTIONS: { value: LastSeenPrivacy; label: string }[] = [
  { value: 'everyone', label: 'Все' },
  { value: 'peers', label: 'Собеседники' },
  { value: 'nobody', label: 'Никто' },
];

/**
 * «Время захода» (С1, #211, `lastseen1`) — Telegram «Конфиденциальность → Время захода» (`settings_privacy_controllers.cpp`
 * `LastSeenPrivacyController`): кто видит точное «был(а) в сети». «Мои контакты» у нас — собеседники и люди с общих серверов
 * (решение владельца Р-2, по умолчанию). Ниже, когда выбрано не «Все», — «Скрывать время прочтения» (там же у Telegram).
 * Настройка серверная: живёт в профиле (`PATCH /users/me`), другие устройства получают её с профилем.
 */
function LastSeenPrivacySetting() {
  const on = useStore((s) => serverLastSeen(s.serverFeatures));
  // `presence4` (решения владельца 08.10): «в сети» в ЛС видно всегда, «Невидимый» — только серверы; подсказка — по серверу.
  const p4 = useStore((s) => serverCallPrivacy(s.serverFeatures));
  const user = useStore((s) => s.user);
  const setAuth = useStore((s) => s.setAuth);
  if (!on || !user) return null;
  const value = user.lastSeenPrivacy ?? 'peers';
  const save = (body: { lastSeenPrivacy?: LastSeenPrivacy; hideReadTime?: boolean }) =>
    api.updateProfile(body).then(setAuth, toastError);
  return (
    <>
      <div className="settings-group-label" id="set-g-lastseen" style={{ marginTop: 22 }}>
        Время захода
      </div>
      <div className="muted set-sub-label" style={{ fontSize: 13 }} id="set-lastseen-label">
        Кто видит время последнего захода
      </div>
      <div className="seg" role="group" aria-labelledby="set-lastseen-label">
        {LAST_SEEN_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            className={value === o.value ? 'on' : ''}
            onClick={() => value !== o.value && void save({ lastSeenPrivacy: o.value })}
          >
            {o.label}
          </button>
        ))}
      </div>
      {p4 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          «Собеседники» — люди, с которыми у вас есть переписка или общий сервер. Вы не будете видеть время последнего захода
          тех, от кого скрыли своё: вместо точного времени будет видно примерное (недавно, на этой неделе, в этом месяце).
          «В сети» в личных сообщениях видно всегда, пока вы в сети. Режим «Невидимый» действует только на серверах.
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          «Собеседники» — люди, с которыми у вас есть переписка или общий сервер. Вы не будете видеть время последнего захода
          тех, от кого скрыли своё: вместо точного времени будет видно примерное (недавно, на этой неделе, в этом месяце). Те, кому
          время захода скрыто, не видят и «в сети» — только «был(а) недавно».
          В режиме «Невидимый» время захода скрыто от всех.
        </div>
      )}
      <LastSeenExceptionsBlock privacy={value} />
      {value !== 'everyone' && (
        <>
          <div className="settings-row">
            <span>Скрывать время прочтения</span>
            <Toggle
              checked={user.hideReadTime === true}
              onChange={(v) => void save({ hideReadTime: v })}
              label="Скрывать время прочтения"
            />
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Если включено, люди, от которых вы скрыли время последнего захода, не смогут видеть, во сколько вы прочли их
            сообщения. Вы также не будете видеть, во сколько они прочли ваши.
          </div>
        </>
      )}
    </>
  );
}

/**
 * «Кто может звонить» (08.10, #211, решение владельца, `presence4`) — Telegram «Конфиденциальность → Звонки» (tdesktop
 * `settings_privacy_controllers.cpp` `CallsPrivacyController`, `lng_edit_privacy_calls_header` «Who can call me»): та же тройка,
 * что у «Времени захода» (по умолчанию «Все» — как было), и те же исключения («Всегда разрешать» / «Никогда не разрешать»).
 * Серверная: `PATCH /users/me` + `callPrivacy`.
 */
function CallPrivacySetting() {
  const on = useStore((s) => serverCallPrivacy(s.serverFeatures) && serverCalls(s.serverFeatures));
  const user = useStore((s) => s.user);
  const setAuth = useStore((s) => s.setAuth);
  if (!on || !user) return null;
  const value = user.callPrivacy ?? 'everyone';
  return (
    <>
      <div className="settings-group-label" id="set-g-calls" style={{ marginTop: 22 }}>
        Звонки
      </div>
      <div className="muted set-sub-label" style={{ fontSize: 13 }} id="set-calls-label">
        Кто может мне звонить
      </div>
      <div className="seg" role="group" aria-labelledby="set-calls-label">
        {LAST_SEEN_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            className={value === o.value ? 'on' : ''}
            onClick={() => value !== o.value && void api.updateProfile({ callPrivacy: o.value }).then(setAuth, toastError)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        «Собеседники» — люди из принятых бесед: вы им отвечали, они в контактах или у вас общий сервер. Незнакомцам, которые только
        написали вам, звонить нельзя. Тем, кому нельзя, при нажатии на трубку объясняется, почему.
      </div>
      <LastSeenExceptionsBlock privacy={value} setting="calls" />
    </>
  );
}

/**
 * Чёрный список личных сообщений (#212, этап 0 ЛС). Блокируют из шапки беседы; здесь — кого и
 * разблокировать. Заблокированный об этом не узнаёт (`backend/src/blockRules.ts`).
 */
function BlockedUsersSetting() {
  const blocked = useStore((s) => s.blockedUsers);
  const setBlocked = useStore((s) => s.setBlocked);
  return (
    <>
      <div className="settings-group-label" id="set-g-blocked" style={{ marginTop: 22 }}>
        Заблокированные
      </div>
      {blocked.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Никого. Заблокировать человека можно кнопкой в шапке личной беседы: он не узнает об этом, а его новые
          сообщения до вас не дойдут.
        </div>
      ) : (
        blocked.map((u) => (
          <div key={u.id} className="settings-row">
            <span className="blocked-user">
              <Avatar url={u.avatarUrl} name={u.displayName} size={24} fallback="icon" />
              {u.displayName}
            </span>
            <button type="button" className="settings-action" onClick={() => void setBlocked(u, false).catch(toastError)}>
              Разблокировать
            </button>
          </div>
        ))
      )}
    </>
  );
}

/** One re-bindable hotkey row: click to capture a key combo, × to clear. Esc cancels capture. */
function HotkeyRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return setCapturing(false);
      const combo = comboFromEvent(e);
      if (!combo) return; // a bare modifier — keep waiting for the real key
      onChange(combo);
      setCapturing(false);
    };
    // Also accept a mouse button (incl. side buttons Mouse3/4). Left click is ignored — it's how the
    // capture is toggled; right-click's context menu is suppressed and side-button nav prevented.
    const onMouse = (e: MouseEvent) => {
      const combo = comboFromMouse(e);
      if (!combo) return; // left button — keep waiting
      e.preventDefault();
      e.stopPropagation();
      onChange(combo);
      setCapturing(false);
    };
    const onCtx = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('contextmenu', onCtx, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('contextmenu', onCtx, true);
    };
  }, [capturing, onChange]);
  return (
    <div className="settings-row">
      <span>{label}</span>
      <div className="hotkey-bind">
        <button type="button" className={`ptt-key ${capturing ? 'capturing' : ''}`} onClick={() => setCapturing((c) => !c)}>
          {capturing ? 'Нажмите сочетание…' : formatCombo(value)}
        </button>
        {value && !capturing && (
          <button type="button" className="hotkey-clear" title="Очистить" onClick={() => onChange('')}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Выбор устройства: пустое значение — «как в системе», отдельной первой строкой со своей подписью.
 *
 * ⚠️ Объявлен на уровне модуля намеренно. Компонент, созданный внутри другого компонента, — новый
 * тип при каждом рендере: React размонтирует старый и монтирует новый, унося с собой раскрытый
 * список. Нативный `<select>` схлопывался здесь ровно по этой причине (см. ref у индикатора
 * уровня микрофона ниже), и повторять её своим списком было бы обидно.
 */
function DeviceSelect({
  value,
  onChange,
  list,
  icon,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  list: MediaDeviceInfo[];
  icon: IconName;
  title: string;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      icon={icon}
      title={title}
      searchPlaceholder="Поиск устройства"
      emptyText="Устройств не найдено"
      ariaLabel={title}
      options={[
        { value: '', label: 'По умолчанию', hint: 'следовать системе' },
        ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `Устройство ${i + 1}` })),
      ]}
    />
  );
}

function AudioVideoTab() {
  const [s, setS] = useState<AudioSettings>(getAudioSettings());
  const [hk, setHk] = useState<Hotkeys>(getHotkeys());
  const [pttCapturing, setPttCapturing] = useState(false);

  function updateHk(next: Hotkeys) {
    setHk(next);
    setHotkeys(next);
  }
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  // The level meter updates ~60fps. Drive it through a DOM ref (not state) so it never re-renders this
  // tab — a re-render here was dismissing the open native device <select> dropdowns mid-pick.
  const meterRef = useRef<HTMLDivElement>(null);
  const [monitoring, setMonitoring] = useState(false);
  const monitoringRef = useRef(false);
  const testRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    inputGain: GainNode;
    gateNode: AudioWorkletNode | null;
    monGain: GainNode;
    filterTeardown: (() => void) | null;
    raf: number;
  } | null>(null);

  function update(next: AudioSettings) {
    setS(next);
    setAudioSettings(next);
  }

  // PTT bind capture: accept a keyboard key OR a mouse button (incl. side buttons "Mouse3/4").
  // Esc cancels; left-click is ignored (it's how capture was opened). Right-click menu is
  // suppressed and the navigation gestures of side buttons are prevented while capturing.
  useEffect(() => {
    if (!pttCapturing) return;
    const stop = () => setPttCapturing(false);
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.code !== 'Escape') update({ ...getAudioSettings(), pttKey: ev.code });
      stop();
    };
    const onMouse = (ev: MouseEvent) => {
      if (ev.button === 0) return; // ignore left clicks
      ev.preventDefault();
      ev.stopPropagation();
      update({ ...getAudioSettings(), pttKey: `Mouse${ev.button}` });
      stop();
    };
    const onCtx = (ev: Event) => ev.preventDefault();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('contextmenu', onCtx, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('contextmenu', onCtx, true);
    };
  }, [pttCapturing]);

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  const byKind = (k: MediaDeviceKind) => devices.filter((d) => d.kind === k);

  function stopSession() {
    const t = testRef.current;
    if (!t) return;
    cancelAnimationFrame(t.raf);
    t.filterTeardown?.();
    t.stream.getTracks().forEach((tr) => tr.stop());
    void t.ctx.close();
    testRef.current = null;
    if (meterRef.current) meterRef.current.style.width = '0%';
  }

  // Mic-test/monitor session that mirrors the REAL published chain, so the meter shows exactly what
  // the gate compares against and "Прослушать себя" plays exactly what friends hear:
  //   mic(device + echo/NS/AGC) → inputGain → [RNNoise|DeepFilter]* → analyser(meter) → gate → speakers
  // *The heavy neural filter loads ONLY when monitoring (playback) is on — opening the tab for the
  // live meter stays cheap; that meter is then post-DSP+gain, close enough to set the threshold.
  async function startSession(monitor: boolean) {
    stopSession();
    monitoringRef.current = monitor;
    setMonitoring(monitor);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(s.inputDeviceId ? { deviceId: { exact: s.inputDeviceId } } : {}),
          // Mirror the live call's mobile override (VoiceConnection.audioCaptureDefaults): on Android we
          // force ALL getUserMedia processing OFF and do NS/gain in the in-app chain, so the test meter
          // must capture the same raw mic — otherwise Samsung's AEC/AGC mangle the test and mislead tuning.
          echoCancellation: isMobile() ? false : s.echoCancellation,
          noiseSuppression: isMobile() ? false : s.noiseFilter === 'system',
          autoGainControl: isMobile() ? false : s.autoGainControl,
        },
      });
      navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const inputGain = ctx.createGain();
      inputGain.gain.value = s.inputGain;
      // Моно ДО нейрофильтра — та же причина, что в micProcessor.ts: RNNoise/DeepFilter обрабатывают
      // один канал и оставляют остальные нулями, поэтому на стерео-микрофоне «Прослушать себя» играло
      // в одно ухо — и ТОЛЬКО при включённом шумодаве (без него стерео доезжало до колонок целым).
      inputGain.channelCount = 1;
      inputGain.channelCountMode = 'explicit';
      inputGain.channelInterpretation = 'speakers';
      src.connect(inputGain);
      let node: AudioNode = inputGain;
      let filterTeardown: (() => void) | null = null;
      if (monitor) {
        try {
          if (s.noiseFilter === 'rnnoise') {
            const r = await (await import('../noiseFilter')).createRnnoiseNode(ctx);
            filterTeardown = r.teardown;
            node.connect(r.node);
            node = r.node;
          } else if (s.noiseFilter === 'deepfilter') {
            const d = await (await import('../deepFilterProcessor')).createDeepFilterNode(ctx);
            filterTeardown = d.teardown;
            node.connect(d.node);
            node = d.node;
          }
        } catch (e) {
          console.warn('[mic-test] filter load failed:', e);
        }
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      node.connect(analyser); // meter taps post-gain/post-filter — same signal the gate measures
      let gateNode: AudioWorkletNode | null = null;
      const monGain = ctx.createGain();
      monGain.gain.value = monitor ? 1 : 0;
      try {
        await ctx.audioWorklet.addModule('/gv-gate-worklet.js');
        gateNode = new AudioWorkletNode(ctx, 'gv-gate');
        gateNode.port.postMessage({ threshold: s.pushToTalk ? 0 : s.vadThreshold });
        node.connect(gateNode);
        gateNode.connect(monGain);
      } catch {
        node.connect(monGain);
      }
      monGain.connect(ctx.destination);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        if (meterRef.current) meterRef.current.style.width = `${Math.round(Math.min(1, peak / 90) * 100)}%`;
        const raf = requestAnimationFrame(tick);
        if (testRef.current) testRef.current.raf = raf;
      };
      const raf = requestAnimationFrame(tick);
      testRef.current = { stream, ctx, inputGain, gateNode, monGain, filterTeardown, raf };
    } catch {
      toast('error', 'Не удалось получить доступ к микрофону.');
      monitoringRef.current = false;
      setMonitoring(false);
    }
  }

  // "Прослушать себя": rebuild WITH the neural filter + playback so you hear the exact processed
  // output friends get. Headphones recommended — on speakers it loops back as echo.
  function toggleMonitor(on: boolean) {
    if (on) toast('info', 'Лучше в наушниках', 'На колонках вы услышите эхо/фон от своего же микрофона.');
    void startSession(on);
  }

  // Live meter starts when the Audio tab opens and restarts when the capture pipeline changes
  // (device, filter, echo/AGC), preserving the monitor state — so it always reflects current settings.
  useEffect(() => {
    void startSession(monitoringRef.current);
    return () => stopSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.inputDeviceId, s.noiseFilter, s.echoCancellation, s.autoGainControl]);

  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-devices">Устройства</div>
      <label className="settings-row col">
        <span>Микрофон</span>
        <DeviceSelect
          value={s.inputDeviceId}
          onChange={(v) => update({ ...s, inputDeviceId: v })}
          list={byKind('audioinput')}
          icon="mic"
          title="Микрофон"
        />
      </label>
      <label className="settings-row col">
        <span>Динамики</span>
        <DeviceSelect
          value={s.outputDeviceId}
          onChange={(v) => update({ ...s, outputDeviceId: v })}
          list={byKind('audiooutput')}
          icon="headphones"
          title="Динамики"
        />
      </label>
      <label className="settings-row col">
        <span>Камера</span>
        <DeviceSelect
          value={s.cameraDeviceId}
          onChange={(v) => update({ ...s, cameraDeviceId: v })}
          list={byKind('videoinput')}
          icon="camera"
          title="Камера"
        />
      </label>

      <div className="settings-group-label" id="set-g-mic">Микрофон · уровень и чувствительность</div>
      <div className="mic-meter mic-meter-lg">
        <div className="mic-meter-fill" ref={meterRef} style={{ width: '0%' }} />
        <div className="mic-meter-thresh" style={{ left: `${Math.round(s.vadThreshold * 100)}%` }} title="Порог голоса" />
      </div>
      <label className="settings-row col" style={{ marginTop: 8 }}>
        <span>
          Чувствительность (порог голоса) · {Math.round(s.vadThreshold * 100)}%
        </span>
        <input
          type="range"
          className="gv-range"
          // Шкала 1–60 %, «выкл» нет (29.09) — `micProcessorRules.VAD_THRESHOLD_MIN/MAX`.
          min={VAD_THRESHOLD_MIN}
          max={VAD_THRESHOLD_MAX}
          step={0.01}
          value={s.vadThreshold}
          style={
            { ['--p']: (s.vadThreshold - VAD_THRESHOLD_MIN) / (VAD_THRESHOLD_MAX - VAD_THRESHOLD_MIN) } as CSSProperties
          }
          disabled={s.pushToTalk}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            update({ ...s, vadThreshold: v });
            testRef.current?.gateNode?.port.postMessage({ threshold: s.pushToTalk ? 0 : v });
          }}
        />
      </label>
      <div className="muted" style={{ fontSize: 12 }}>
        Метр выше — живой уровень голоса. Ставьте порог (honey-метка) чуть выше фонового шума: громче
        метки — звук идёт и обводка горит, тише — тишина. По умолчанию 1 % — отрезает только самый слабый фон. В
        режиме рации не используется.
      </div>

      <label className="settings-row col">
        <span>Громкость микрофона · {Math.round(s.inputGain * 100)}%</span>
        <input
          type="range"
          className="gv-range"
          min={0}
          max={2}
          step={0.05}
          value={s.inputGain}
          style={{ ['--p']: s.inputGain / 2 } as CSSProperties}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            update({ ...s, inputGain: v });
            if (testRef.current) testRef.current.inputGain.gain.value = v;
          }}
        />
      </label>
      <div className="settings-row">
        <span>Прослушать себя</span>
        <Toggle checked={monitoring} onChange={(v) => void toggleMonitor(v)} label="Прослушать себя" />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Воспроизводит ваш микрофон ровно так, как его слышат друзья — с эхоподавлением, шумодавом и
        громкостью. Наденьте наушники, чтобы не словить эхо.
      </div>

      <div className="settings-group-label" id="set-g-audio-proc">Обработка звука</div>
      <div className="settings-row">
        <span id="set-nf-label">Шумоподавление</span>
        <div className="seg" role="group" aria-labelledby="set-nf-label">
          {(
            [
              ['off', 'Выкл'],
              ['system', 'Системное'],
              ['rnnoise', 'RNNoise'],
              ['deepfilter', 'DeepFilter'],
            ] as const
          )
            // 'system' = getUserMedia NS, which is force-disabled on mobile (the WebView's WebRTC path
            // mangles the Samsung mic). Hide it there so the option isn't a dead no-op.
            .filter(([val]) => !(isMobile() && val === 'system'))
            .map(([val, label]) => (
            <button
              key={val}
              type="button"
              aria-pressed={s.noiseFilter === val}
              className={s.noiseFilter === val ? 'on' : ''}
              onClick={() => update({ ...s, noiseFilter: val, noiseSuppression: val === 'system' })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {s.noiseFilter === 'deepfilter'
          ? 'DeepFilter (DeepFilterNet3) — самый сильный шумодав, давит шум агрессивнее RNNoise. ⚠️ High CPU usage + заметная задержка звука: лучше для стрима/записи, чем для живого разговора. Модель (~18 МБ) грузится один раз; применяется при следующем входе в голосовой канал.'
          : s.noiseFilter === 'rnnoise'
            ? 'RNNoise — лёгкий нейросетевой шумодав в приложении (вырезает клавиатуру, вентиляторы). Чуть грузит CPU; применяется при следующем входе в голосовой канал.'
            : s.noiseFilter === 'system'
              ? 'Системное шумоподавление браузера/ОС.'
              : 'Без шумоподавления — чистый сигнал микрофона.'}
      </div>
      {isMobile() ? (
        <div className="muted" style={{ fontSize: 12 }}>
          На телефоне обработка микрофона идёт в приложении (шумодав + громкость выше), а системные
          эхоподавление и авто-усиление отключены — на Android они корёжат звук. Эхо не слышно в наушниках;
          для громкой связи используйте гарнитуру.
        </div>
      ) : (
        <>
          <div className="settings-row">
            <span>Эхоподавление</span>
            <Toggle
              checked={s.echoCancellation}
              onChange={(v) => update({ ...s, echoCancellation: v })}
              label="Эхоподавление"
            />
          </div>
          <div className="settings-row">
            <span>Авто-усиление (AGC)</span>
            <Toggle
              checked={s.autoGainControl}
              onChange={(v) => update({ ...s, autoGainControl: v })}
              label="Авто-усиление (AGC)"
            />
          </div>
        </>
      )}

      <div className="settings-group-label" id="set-g-ptt">Режим передачи</div>
      <div className="settings-row">
        <span>Push-to-talk (говорить по кнопке)</span>
        <Toggle
          label="Push-to-talk (говорить по кнопке)"
          checked={s.pushToTalk}
          onChange={(v) => {
            update({ ...s, pushToTalk: v });
            testRef.current?.gateNode?.port.postMessage({ threshold: v ? 0 : s.vadThreshold });
          }}
        />
      </div>
      {/* 🔴 Клавиша — только там, где есть клавиатура. На телефоне строка честно писала «Пробел»,
          и это читалось как издевательство: нажать его не на чем. Кнопка поверх игр — отдельная
          задача, до неё режим рации на телефоне живёт без назначения клавиши. */}
      {s.pushToTalk && !isMobile() && (
        <div className="settings-row">
          <span>Клавиша</span>
          <button
            type="button"
            className={`ptt-key ${pttCapturing ? 'capturing' : ''}`}
            onClick={() => setPttCapturing((c) => !c)}
          >
            {pttCapturing ? 'Нажмите клавишу или кнопку мыши…' : formatCombo(s.pttKey)}
          </button>
        </div>
      )}
      {s.pushToTalk && (
        <label className="settings-row col">
          <span>Задержка отпускания · {s.pttReleaseMs} мс</span>
          <input
            type="range"
            className="gv-range"
            min={0}
            max={2000}
            step={50}
            value={s.pttReleaseMs}
            style={{ ['--p']: s.pttReleaseMs / 2000 } as CSSProperties}
            onChange={(e) => update({ ...s, pttReleaseMs: parseInt(e.target.value, 10) })}
          />
        </label>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        Изменения устройства/обработки применяются при следующем входе в голосовой канал.
      </div>

      {/* Вся группа — про физическую клавиатуру, поэтому на телефоне её нет: там она показывала
          три «Не задано», которые назначить нечем. */}
      {!isMobile() && (
        <>
      <div className="settings-group-label" id="set-g-hotkeys" style={{ marginTop: 18 }}>
        Горячие клавиши
      </div>
      <HotkeyRow label="Заглушить микрофон" value={hk.mute} onChange={(v) => updateHk({ ...hk, mute: v })} />
      <HotkeyRow label="Деафен (заглушить звук)" value={hk.deafen} onChange={(v) => updateHk({ ...hk, deafen: v })} />
      <HotkeyRow
        label="Демонстрация экрана"
        value={hk.screenShare}
        onChange={(v) => updateHk({ ...hk, screenShare: v })}
      />
      {isDesktop() && (
        <HotkeyRow
          label="Показать/скрыть оверлей"
          value={hk.overlayToggle}
          onChange={(v) => updateHk({ ...hk, overlayToggle: v })}
        />
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        {isDesktop()
          ? 'В десктоп-версии работают глобально — даже когда GusVoice не в фокусе (например, в игре). Демонстрацию экрана надёжнее запускать из окна приложения.'
          : 'Работают, пока вкладка GusVoice в фокусе и вы в голосовом канале. Глобальные хоткеи (поверх игр) — в десктоп-версии.'}
      </div>
        </>
      )}

      <div className="settings-group-label" id="set-g-stream" style={{ marginTop: 18 }}>
        Качество трансляции экрана
      </div>
      <StreamQualityPanel />

      {isDesktop() && <StreamCursorSetting />}

      {isDesktop() && (
        <>
          <div className="settings-group-label" id="set-g-native-audio" style={{ marginTop: 18 }}>
            Тест нативного захвата звука (отладка)
          </div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Записывает 8 секунд системного звука <strong>без голосов GusVoice</strong> в WAV — проверка
            нативного захвата. Во время записи включи музыку/видео и пусть кто-нибудь говорит в голосовом
            канале, потом проиграй полученный файл.
          </div>
          <button
            type="button"
            className="stream-restart"
            onClick={async () => {
              try {
                toast('info', 'Записываю 8 секунд…', 'Включи звук и пусть кто-то говорит в голосовом канале.');
                const inv = (
                  window as unknown as { __TAURI__?: { core?: { invoke: (c: string, a?: unknown) => Promise<unknown> } } }
                ).__TAURI__?.core?.invoke;
                if (!inv) throw new Error('Tauri API недоступен (нужна сборка с этой версией).');
                const path = (await inv('gv_audio_record_wav', { seconds: 8 })) as string;
                toast('success', 'Готово — проиграй этот файл', path);
              } catch (e) {
                toastError(e, 'Нативный захват не удался');
              }
            }}
          >
            🎙 Записать 8 сек теста
          </button>
        </>
      )}
    </div>
  );
}

function AppearanceTab() {
  const [theme, setT] = useState<Theme>(getTheme());
  const [scale, setScale] = useState<UiScale>(getUiScale());
  const [sidebar, setSidebar] = useState<number>(() => Math.max(getSidebarWidth(), SIDEBAR_MIN)); // «только аватары» (72) на ползунке — нижняя граница
  // Настройки ссылок (#63/#64) — пер-девайсные, в localStorage, аккаунт не синкают.
  const [previews, setPreviews] = useState(linkPreviewsEnabled);
  const [warnOff, setWarnOff] = useState(linkWarningsOff);
  const [trusted, setTrusted] = useState(() => trustedLinkAuthors().length);
  /**
   * Анимированные аватары — тоже пер-девайсная настройка: «не тянет» это про конкретный ноутбук и
   * конкретный интернет, а не про аккаунт.
   * ⚠️ Умолчание ВКЛЮЧЕНО (так решено), кроме случая, когда система просит не двигать ничего —
   * там выключено по умолчанию, но включается руками.
   */
  const [animated, setAnimated] = useState(animatedAvatarsEnabled);
  const [lite, setLite] = useState(liteModeEnabled);
  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-theme">
        Тема
      </div>
      {isMobile() ? (
        // Mobile (design-step8 E2): tappable preview cards instead of a text segment.
        <div className="theme-cards" role="group" aria-labelledby="set-g-theme">
          {(['dark', 'light'] as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={theme === t}
              className={`theme-card ${t} ${theme === t ? 'sel' : ''}`}
              onClick={() => {
                setTheme(t);
                setT(t);
              }}
            >
              <span className="tc-preview">
                <span className="tc-side" />
                <span className="tc-lines">
                  <span />
                  <span />
                </span>
              </span>
              <span className="tc-label">{t === 'dark' ? 'Тёмная' : 'Светлая'}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="seg" role="group" aria-labelledby="set-g-theme">
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            className={theme === 'dark' ? 'on' : ''}
            onClick={() => {
              setTheme('dark');
              setT('dark');
            }}
          >
            Тёмная
          </button>
          <button
            type="button"
            aria-pressed={theme === 'light'}
            className={theme === 'light' ? 'on' : ''}
            onClick={() => {
              setTheme('light');
              setT('light');
            }}
          >
            Светлая
          </button>
        </div>
      )}

      <div className="settings-group-label" style={{ marginTop: 16 }} id="set-g-scale">
        Масштаб интерфейса
      </div>
      <div className="seg" role="group" aria-labelledby="set-g-scale">
        {UI_SCALES.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={scale === s.key}
            className={scale === s.key ? 'on' : ''}
            onClick={() => {
              setUiScale(s.key);
              setScale(s.key);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* The mobile sidebar is a full-screen pane (no draggable edge), so the width control + its
          desktop-only "drag the right edge" hint are dead weight on phones — hide them there. */}
      {!isMobile() && (
        <>
          <label className="settings-group-label" id="set-g-sidebar" style={{ marginTop: 16 }} htmlFor="set-sidebar-w">
            Ширина боковой панели · {sidebar}px
          </label>
          <input
            id="set-sidebar-w"
            type="range"
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            step={4}
            value={sidebar}
            style={{ ['--p']: (sidebar - SIDEBAR_MIN) / (SIDEBAR_MAX - SIDEBAR_MIN) } as CSSProperties}
            onChange={(e) => {
              const w = Number(e.target.value);
              setSidebarWidth(w);
              setSidebar(w);
            }}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Панель также можно тянуть за правый край (двойной клик по краю — сброс). Анимации приглушаются,
            если в системе включён «уменьшить движение».
          </div>
        </>
      )}

      <ListViewSetting />

      <div className="settings-group-label" id="set-g-lite">Оптимизированный режим</div>
      <div className="settings-row">
        <span>Оптимизированный режим</span>
        <Toggle
          checked={lite}
          onChange={(v) => {
            setLiteModeEnabled(v);
            setLite(v);
          }}
          label="Оптимизированный режим"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Для слабых компьютеров и игр: интерфейс перестаёт двигаться сам. Анимированные аватары замирают на
        первом кадре и оживают при наведении, пульсирующие значки и прочие украшения стоят на месте. Звук,
        показ и сообщения работают как обычно. Настройка только для этого устройства.
      </div>

      <div className="settings-group-label" id="set-g-avatars">Аватары</div>
      <div className="settings-row">
        <span>Показывать анимированные аватары</span>
        <Toggle
          checked={animated}
          onChange={(v) => {
            setAnimatedAvatarsEnabled(v);
            setAnimated(v);
          }}
          label="Показывать анимированные аватары"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Движущиеся аватары тех, кто их купил. Выключи, если компьютер или интернет не тянет: тогда
        анимация не только не показывается, но и НЕ СКАЧИВАЕТСЯ — вместо неё останется обычная
        картинка. Настройка только для этого устройства.
      </div>

      <div className="settings-group-label" id="set-g-links">Ссылки</div>
      {/* ⚠️ `Toggle` рисует ТОЛЬКО сам переключатель — `label` уходит в `aria-label`, для скринридера.
          Видимая подпись ставится рядом, обёрткой `settings-row` (как во всех остальных настройках).
          Без неё выходило два безымянных тумблера подряд: непонятно, что к чему относится, а описание
          под первым визуально приклеивалось ко второму. */}
      <div className="settings-row">
        <span>Показывать предпросмотр ссылок</span>
        <Toggle
          checked={previews}
          onChange={(v) => {
            setLinkPreviewsEnabled(v);
            setPreviews(v);
          }}
          label="Показывать предпросмотр ссылок"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Под сообщением со ссылкой показывается заголовок и описание страницы. Их забирает сервер,
        а не твой браузер — сторонний сайт не узнает, что ты читаешь сообщение. Картинки в карточке
        нет по той же причине.
      </div>
      <div className="settings-row" style={{ marginTop: 12 }}>
        <span>Предупреждать при переходе на сторонний сайт</span>
        <Toggle
          checked={!warnOff}
          onChange={(v) => {
            setLinkWarningsOff(!v);
            setWarnOff(!v);
          }}
          label="Предупреждать при переходе на сторонний сайт"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Клик по чужой ссылке сначала показывает, куда она ведёт. Ссылки на этот же сервер не
        спрашивают никогда.
      </div>
      {trusted > 0 && (
        <button
          type="button"
          className="link"
          style={{ marginTop: 6 }}
          onClick={() => {
            forgetTrustedLinkAuthors();
            setTrusted(0);
          }}
        >
          Забыть доверенных отправителей ({trusted})
        </button>
      )}
      {!isMobile() && <SendModeSetting />}
      <EmojiSuggestSetting />
      <DoubleClickSetting />
      {isMobile() && <ChatSwipeSetting />}
    </div>
  );
}

/**
 * «Вид списка бесед» (G34, Telegram Android «Вид списка чатов»: «Две строки» / «Три строки», `SharedConfig.useThreeLinesLayout`):
 * в трёх строках строка выше (70 → 76 dp), текст последнего сообщения идёт в две строки, имя автора в группе — отдельной.
 * Настройка устройства (`dmListView.ts`); на ПК список ещё сворачивается в аватары — тянуть колонку за правый край.
 */
function ListViewSetting() {
  const lines = useListLines();
  const opts: { val: ListLines; label: string; sub: string }[] = [
    { val: 'two', label: 'Две строки', sub: 'Имя и одна строка сообщения' },
    { val: 'three', label: 'Три строки', sub: 'Сообщение в две строки, автор в группе — отдельной строкой' },
  ];
  return (
    <>
      <div className="settings-group-label" id="set-g-listview" style={{ marginTop: 18 }}>
        Вид списка бесед
      </div>
      <div role="group" aria-labelledby="set-g-listview" style={{ display: 'contents' }}>
        {opts.map((o) => (
          <button
            key={o.val}
            type="button"
            aria-pressed={lines === o.val}
            className={`close-opt ${lines === o.val ? 'on' : ''}`}
            onClick={() => setListLines(o.val)}
          >
            <span className="close-opt-text">
              <span>{o.label}</span>
              <span className="close-opt-sub">{o.sub}</span>
            </span>
            {lines === o.val && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
      {!isMobile() && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Колонку списка можно стянуть за правый край до конца — останутся только аватары с отметками непрочитанного.
        </div>
      )}
    </>
  );
}

/**
 * «Подсказывать эмодзи» (G53, Telegram Desktop «Настройки чатов → Подсказывать замену эмодзи»): полоса эмодзи над полем по
 * `:слову` и по слову целиком. По умолчанию включено; настройка устройства (`emojiSuggest.ts`).
 */
function EmojiSuggestSetting() {
  const [on, setOn] = useState(emojiSuggestEnabled);
  return (
    <>
      <div className="settings-group-label" id="set-g-emoji" style={{ marginTop: 18 }}>
        Подсказки эмодзи
      </div>
      <div className="settings-row">
        <span>Подсказывать эмодзи при наборе</span>
        <Toggle
          checked={on}
          onChange={(v) => {
            setEmojiSuggestEnabled(v);
            setOn(v);
          }}
          label="Подсказывать эмодзи при наборе"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Набери «:» и две буквы (например, «:огон»), либо одно слово в пустом поле («привет») — над полем появится полоса эмодзи.
        {/* C4: на телефоне нет клавиш — там подсказку выбирают касанием (без Tab/Enter/Esc). */}
        {isMobile() ? 'Нажми на эмодзи в полосе — оно встанет в текст. ' : '←/→ выбирают, Tab или Enter подставляют, Esc закрывает. '}
        «:код:» с закрывающим двоеточием заменяется и без подсказок.
      </div>
    </>
  );
}

/**
 * «Отправка по Enter / по Ctrl+Enter» (07.10, G36) — как в Telegram Desktop: «Настройки чатов → Сообщения», два варианта.
 * Наш аналог «Настроек чатов» — раздел «Вид» (тема, масштаб, лента). Настройка устройства (`sendMode.ts`); в приложении
 * для телефона её нет — там Enter переносит строку, отправка кнопкой (`enterSends`).
 */
function SendModeSetting() {
  const [mode, setMode] = useState<SendMode>(getSendMode);
  const opts: { val: SendMode; label: string; sub: string }[] = [
    { val: 'enter', label: 'Отправка по Enter', sub: 'Shift+Enter и Ctrl+Enter — новая строка' },
    { val: 'ctrl-enter', label: 'Отправка по Ctrl+Enter', sub: 'Enter — новая строка' },
  ];
  return (
    <>
      <div className="settings-group-label" id="set-g-send" style={{ marginTop: 18 }}>
        Отправка сообщений
      </div>
      {/* display:contents — варианты остаются прямыми детьми `.settings-pane`, как у «При нажатии на крестик». */}
      <div role="group" aria-labelledby="set-g-send" style={{ display: 'contents' }}>
        {opts.map((o) => (
          <button
            key={o.val}
            type="button"
            aria-pressed={mode === o.val}
            className={`close-opt ${mode === o.val ? 'on' : ''}`}
            onClick={() => {
              setSendMode(o.val);
              setMode(o.val);
            }}
          >
            <span className="close-opt-text">
              <span>{o.label}</span>
              <span className="close-opt-sub">{o.sub}</span>
            </span>
            {mode === o.val && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * «Двойной клик по сообщению» (07.10, G45) — как в Telegram Desktop («Настройки чатов»: «Ответ по двойному клику» /
 * «Реакция по двойному клику»; у нас третий — «Ничего», как `DoubleClickQuickAction::None`) и выбор быстрой реакции: её
 * ставит двойной клик, у Telegram — «любимая» первая в полосе. По умолчанию — реакция 👍 (решение владельца; у Telegram —
 * ответ). Настройка устройства (`quickReaction.ts`); на телефоне — двойной тап.
 */
function DoubleClickSetting() {
  const [action, setAction] = useState<DoubleClickAction>(getDoubleClickAction);
  const [quick, setQuick] = useState(getQuickReaction);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const opts: { val: DoubleClickAction; label: string; sub: string }[] = [
    { val: 'react', label: 'Ставить реакцию', sub: 'Повторный двойной клик снимает её' },
    { val: 'reply', label: 'Отвечать на сообщение', sub: 'Двойной клик открывает ответ в поле ввода' },
    { val: 'none', label: 'Ничего', sub: 'Двойной клик выделяет слово' },
  ];
  const choose = (emoji: string) => {
    setQuickReaction(emoji);
    setQuick(getQuickReaction());
  };
  return (
    <>
      <div className="settings-group-label" id="set-g-dblclick" style={{ marginTop: 18 }}>
        Двойной клик по сообщению
      </div>
      <div role="group" aria-labelledby="set-g-dblclick" style={{ display: 'contents' }}>
        {opts.map((o) => (
          <button
            key={o.val}
            type="button"
            aria-pressed={action === o.val}
            className={`close-opt ${action === o.val ? 'on' : ''}`}
            onClick={() => {
              setDoubleClickAction(o.val);
              setAction(o.val);
            }}
          >
            <span className="close-opt-text">
              <span>{o.label}</span>
              <span className="close-opt-sub">{o.sub}</span>
            </span>
            {action === o.val && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
      {action === 'react' && (
        <div className="quick-react-pick">
          <span className="quick-react-label" id="set-quick-reaction">
            Быстрая реакция
          </span>
          <div className="quick-react-row" role="group" aria-labelledby="set-quick-reaction">
            {quickBarOrder(QUICK_REACTIONS, quick).map((e) => (
              <button
                key={e}
                type="button"
                className={`quick-react-btn ${e === quick ? 'on' : ''}`}
                aria-pressed={e === quick}
                onClick={() => choose(e)}
              >
                {e}
              </button>
            ))}
            <button
              type="button"
              className="quick-react-btn more"
              aria-label="Другая реакция"
              title="Другая реакция"
              onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}
            >
              <Icon name="chevron-down" size={18} />
            </button>
          </div>
        </div>
      )}
      {/* Через портал: окно настроек анимируется `transform`, а у предка с ним `position: fixed` считается от него, не от окна. */}
      {pick &&
        createPortal(
          <EmojiPicker
            anchor={pick}
            onPick={(emoji, custom) => {
              if (!custom) choose(emoji);
              setPick(null);
            }}
            onClose={() => setPick(null)}
          />,
          document.body,
        )}
    </>
  );
}

function AccountTab({ onClose }: { onClose: () => void }) {
  const user = useStore((s) => s.user)!;
  const setAuth = useStore((s) => s.setAuth);
  const logout = useStore((s) => s.logout);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [instanceName, setInstanceName] = useState(activeInstance()?.name ?? '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  // Email change: idle → edit (new address + password) → verify (code sent to new address).
  const [emailMode, setEmailMode] = useState<'idle' | 'edit' | 'verify'>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [emailPw, setEmailPw] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [deleteMode, setDeleteMode] = useState(false);
  const [deletePw, setDeletePw] = useState('');

  async function doDelete() {
    setBusy(true);
    try {
      await api.deleteAccount(deletePw);
      await logout();
      onClose();
      location.reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function startEmailChange() {
    setBusy(true);
    try {
      setAuth(await api.changeEmail(newEmail.trim(), emailPw));
      setEmailPw('');
      setEmailMode('verify');
      toast('info', 'Код отправлен на новый адрес');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEmail() {
    setBusy(true);
    try {
      const res = await api.verify(newEmail.trim(), emailCode);
      setToken(res.token);
      // Ссылки на закрытые файлы ЛС выданы под прежний токен — перечитать ленту (этап 2, шаг 2б).
      useStore.getState().convTokenChanged();
      setAuth(res.user);
      setEmailMode('idle');
      setNewEmail('');
      setEmailCode('');
      toast('success', 'Почта обновлена');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  function saveInstanceName() {
    const id = activeInstanceId();
    if (!id) return;
    renameInstance(id, instanceName); // empty → falls back to the server host
    setInstanceName(activeInstance()?.name ?? '');
    toast('success', 'Имя сервера сохранено');
  }

  async function saveName() {
    if (!displayName.trim() || displayName.trim() === user.displayName) return;
    setBusy(true);
    try {
      setAuth(await api.updateProfile({ displayName: displayName.trim() }));
      toast('success', 'Имя обновлено');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  // Game activity (#40): link/unlink Steam + toggle the master "show what I'm playing" switch.
  async function linkSteam() {
    setBusy(true);
    try {
      const { url } = await api.steamLinkUrl();
      if (isDesktop()) {
        // Desktop (#43/#44): open Steam in the SYSTEM browser via the native shell. NEVER navigate the
        // main window — a full-page nav takes the Tauri WebView off the embedded app to the server's web origin
        // (a DIFFERENT origin) → its localStorage (token/settings/instances) is gone → looks like a logout
        // + full reset, and native context (overlay/hotkeys) detaches. `window.open` is a no-op in WebView2
        // (#44 — "button does nothing"), so we shell out. Refresh the profile when we regain focus (Steam
        // returns to the web callback in the browser, which flips steamLinked).
        await openExternal(url);
        toast('info', 'Открыл Steam в браузере — заверши вход, потом вернись в приложение');
        const onFocus = () => {
          window.removeEventListener('focus', onFocus);
          api.me().then(setAuth).catch(() => {});
        };
        window.addEventListener('focus', onFocus);
      } else {
        // Web: same-origin round-trip is safe and reliable (avoids popup-blockers after the await).
        // Steam returns to /?steam=linked, which App.tsx handles (toast + profile refresh).
        window.location.href = url;
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  async function unlinkSteam() {
    setBusy(true);
    try {
      setAuth(await api.steamUnlink());
      toast('success', 'Steam отвязан');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  async function toggleActivity(v: boolean) {
    try {
      setAuth(await api.updateProfile({ showGameActivity: v }));
    } catch (e) {
      toastError(e);
    }
  }

  async function doUpload(f: File | Blob) {
    setBusy(true);
    try {
      const file = f instanceof File ? f : new File([f], 'avatar.png', { type: 'image/png' });
      setAuth(await api.uploadAvatar(file));
      toast('success', 'Аватар обновлён');
      setCropFile(null);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  // Crop non-GIF images before upload; GIFs upload as-is so their animation survives.
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.type === 'image/gif') void doUpload(file);
    else setCropFile(file);
  }

  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-profile">
        Профиль
      </div>
      <div className="profile-avatar">
        <Avatar url={user.avatarUrl} name={user.displayName} size={72} />
        <div>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
            Загрузить аватар
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={onPick} />
          <div className="muted">PNG / JPG / WEBP / GIF, до 5 МБ</div>
        </div>
      </div>
      {cropFile && (
        <AvatarCropModal file={cropFile} busy={busy} onCancel={() => setCropFile(null)} onCrop={(b) => void doUpload(b)} />
      )}
      <label className="settings-row col">
        <span>Отображаемое имя</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveName();
          }}
        />
      </label>
      <div className="settings-row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => void saveName()} disabled={busy || !displayName.trim() || displayName.trim() === user.displayName}>
          Сохранить имя
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        @{user.username}
        {user.superAdmin ? ' · super-admin' : ''}
      </div>

      {/* Игровая активность — только в десктоп-аппе (#43): детект игр локальный (десктоп), а веб-путь
          Steam-линка ломал сессию. На вебе секцию не показываем. */}
      {isDesktop() && (
        <>
          <div className="settings-group-label" id="set-g-game">Игровая активность</div>
          <div className="settings-row">
            <span>Показывать, во что я играю</span>
            <Toggle
              checked={user.showGameActivity !== false}
              onChange={(v) => void toggleActivity(v)}
              label="Показывать, во что я играю"
            />
          </div>
          <div className="settings-row">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Icon name="gamepad" size={16} />
              Steam
              {user.steamLinked && user.steamPersona && <span className="acc-badge ok">{user.steamPersona}</span>}
            </span>
            {user.steamLinked ? (
              <button type="button" onClick={() => void unlinkSteam()} disabled={busy}>
                Отвязать
              </button>
            ) : (
              <button type="button" onClick={() => void linkSteam()} disabled={busy}>
                Привязать Steam
              </button>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            В списке участников показывается «Играет в …»: автоматически по запущенной игре, а привязка Steam
            уточняет название. Данные о процессах не покидают компьютер — отправляется только название игры.
          </div>
          {/* Согласие на сбор диагностики (#113). Секция сама себя прячет, если инстанс не собирает. */}
          <DiagSettingsSection />
        </>
      )}

      <div className="settings-group-label" id="set-g-email">Email</div>
      {emailMode === 'idle' ? (
        <div className="settings-row">
          <span className="acc-email">
            <span className="acc-email-val">{user.email || '—'}</span>
            {user.email && <span className={`acc-badge ${user.verified ? 'ok' : 'warn'}`}>{user.verified ? 'подтверждён' : 'не подтверждён'}</span>}
          </span>
          <button type="button" onClick={() => { setNewEmail(''); setEmailPw(''); setEmailMode('edit'); }}>Изменить</button>
        </div>
      ) : emailMode === 'edit' ? (
        <>
          <label className="settings-row col">
            <span>Новый email</span>
            <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="settings-row col">
            <span>Пароль (для подтверждения)</span>
            <input type="password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} placeholder="••••••••" />
          </label>
          <div className="muted" style={{ fontSize: 12 }}>На новый адрес придёт код — почту нужно будет подтвердить заново.</div>
          <div className="settings-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="acc-ghost" onClick={() => setEmailMode('idle')}>Отмена</button>
            <button type="button" onClick={() => void startEmailChange()} disabled={busy || !newEmail.trim() || !emailPw}>Отправить код</button>
          </div>
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 13 }}>Введите код, отправленный на {newEmail}.</div>
          <label className="settings-row col">
            <span>Код подтверждения</span>
            <input
              inputMode="numeric"
              maxLength={6}
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
            />
          </label>
          <div className="settings-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="acc-ghost" onClick={() => setEmailMode('idle')}>Отмена</button>
            <button type="button" onClick={() => void confirmEmail()} disabled={busy || emailCode.length < 6}>Подтвердить</button>
          </div>
        </>
      )}

      <div className="danger-zone" style={{ marginTop: 8 }}>
        <strong>Сессия</strong>
        <button
          type="button"
          className="leave"
          onClick={async () => {
            await logout();
            onClose();
            location.reload();
          }}
        >
          Выйти из аккаунта
        </button>
      </div>

      {/* Active instance display name (#7) — desktop (multi-instance). Lets you label this server; empty
          resets to the server host. Все записи разом — «Федерация › Мои инстансы» (`InstancesPanel`, 23.09). */}
      {multiInstanceEnabled() && activeInstance() && (
        <>
          <div className="settings-group-label" style={{ marginTop: 14 }}>
            Сервер · {serverHost(activeInstance()!.apiUrl)}
          </div>
          <label className="settings-row col">
            <span>Отображаемое имя сервера</span>
            <input
              value={instanceName}
              placeholder={serverHost(activeInstance()!.apiUrl)}
              maxLength={40}
              onChange={(e) => setInstanceName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveInstanceName();
              }}
            />
          </label>
          <div className="settings-row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={saveInstanceName}
              disabled={instanceName === (activeInstance()?.name ?? '')}
            >
              Сохранить
            </button>
          </div>
        </>
      )}

      {/* Server the app is connected to — only on generic picker builds (a server was chosen). Changing
          it returns to the server-picker and logs out on this device (the token is per-instance).
          On desktop, the multi-instance switcher (#7) in the rail supersedes this. */}
      {isPickerBuild() && currentServer() && (
        <div className="danger-zone" style={{ marginTop: 8 }}>
          <strong>Сервер</strong>
          <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            Подключено к <code>{serverHost(currentServer()!.apiUrl)}</code>. Смена сервера выйдет из аккаунта на этом устройстве.
          </div>
          <button
            type="button"
            className="leave"
            onClick={async () => {
              clearServer();
              await logout();
              onClose();
              location.reload();
            }}
          >
            Сменить сервер
          </button>
        </div>
      )}

      <div className="danger-zone" style={{ marginTop: 8 }}>
        <strong>Удалить аккаунт</strong>
        <div className="muted" style={{ fontSize: 12 }}>
          Безвозвратно удалит логин, почту, пароль, аватар и участие в серверах. Ваши сообщения останутся у собеседников с подписью «Удалённый пользователь». Если у вас есть свои серверы — сначала передайте или удалите их.
        </div>
        {!deleteMode ? (
          <button type="button" className="leave" onClick={() => { setDeletePw(''); setDeleteMode(true); }}>
            Удалить аккаунт
          </button>
        ) : (
          <>
            <input
              type="password"
              value={deletePw}
              onChange={(e) => setDeletePw(e.target.value)}
              placeholder="Пароль для подтверждения"
              autoFocus
            />
            <div className="settings-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="acc-ghost" onClick={() => setDeleteMode(false)}>Отмена</button>
              <button type="button" className="leave" onClick={() => void doDelete()} disabled={busy || !deletePw}>
                Удалить навсегда
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Read-only list of one-time backup codes with copy/download — shown right after they're generated. */
function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  function copy() {
    navigator.clipboard?.writeText(codes.join('\n')).then(
      () => toast('success', 'Коды скопированы'),
      () => toast('error', 'Не удалось скопировать'),
    );
  }
  function download() {
    const blob = new Blob([`Резервные коды GusVoice\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gusvoice-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="sec-block">
      <div className="settings-group-label">Резервные коды</div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        Сохраните их в надёжном месте. Каждый код одноразовый — он заменит код из приложения, если вы потеряете телефон.
        <strong> Они показываются только сейчас.</strong>
      </div>
      <div className="backup-codes">
        {codes.map((c) => (
          <code key={c}>{c}</code>
        ))}
      </div>
      <div className="sec-actions">
        <button type="button" onClick={copy}>
          Скопировать
        </button>
        <button type="button" onClick={download}>
          Скачать .txt
        </button>
        <button type="button" className="primary" onClick={onDone}>
          Готово
        </button>
      </div>
    </div>
  );
}

function SecurityTab() {
  const user = useStore((s) => s.user)!;
  const setAuth = useStore((s) => s.setAuth);

  // Password change
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  // Logout everywhere (session revocation)
  const [loPw, setLoPw] = useState('');
  const [loBusy, setLoBusy] = useState(false);

  // 2FA
  const [view, setView] = useState<'idle' | 'setup' | 'codes' | 'disable'>('idle');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [enableCode, setEnableCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function changePassword() {
    if (newPw.length < 6) return toast('error', 'Новый пароль: минимум 6 символов');
    if (newPw !== confirmPw) return toast('error', 'Пароли не совпадают');
    setPwBusy(true);
    try {
      const res = await api.changePassword(curPw, newPw);
      // The change revokes every session; the backend hands THIS device a fresh token.
      if (res.token) {
        setToken(res.token);
        useStore.getState().convTokenChanged();
      }
      setCurPw('');
      setNewPw('');
      setConfirmPw('');
      toast('success', 'Пароль изменён', 'Остальные сессии завершены');
    } catch (e) {
      toastError(e);
    } finally {
      setPwBusy(false);
    }
  }

  async function logoutEverywhere() {
    setLoBusy(true);
    try {
      const res = await api.logoutAll(loPw);
      setToken(res.token); // this device keeps a fresh token; every other session is dead
      useStore.getState().convTokenChanged();
      setLoPw('');
      toast('success', 'Готово', 'Все остальные устройства разлогинены');
    } catch (e) {
      toastError(e);
    } finally {
      setLoBusy(false);
    }
  }

  async function startSetup() {
    setBusy(true);
    try {
      setSetup(await api.twoFactorSetup());
      setEnableCode('');
      setView('setup');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable() {
    setBusy(true);
    try {
      const res = await api.twoFactorEnable(enableCode);
      if (res.user) setAuth(res.user);
      setBackupCodes(res.backupCodes);
      setSetup(null);
      setView('codes');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisable() {
    setBusy(true);
    try {
      const res = await api.twoFactorDisable(disablePw, disableCode);
      setAuth(res.user);
      setDisablePw('');
      setDisableCode('');
      setView('idle');
      toast('success', 'Двухфакторная отключена');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-pane">
      {/* ---- Password ---- */}
      <div className="settings-group-label" id="set-g-password">Смена пароля</div>
      <label className="settings-row col">
        <span>Текущий пароль</span>
        <input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="settings-row col">
        <span>Новый пароль</span>
        <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="settings-row col">
        <span>Повторите новый пароль</span>
        <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
      </label>
      <div className="sec-actions">
        <button type="button" className="primary" disabled={pwBusy || !curPw || !newPw} onClick={changePassword}>
          {pwBusy ? '…' : 'Сменить пароль'}
        </button>
      </div>

      {/* ---- Sessions ---- */}
      <div className="settings-group-label" id="set-g-sessions" style={{ marginTop: 22 }}>
        Сессии
      </div>
      {/* 🔴 Про чужие инстансы сказано ВСЛУХ (#139, §5.6.1, требование 24): отзыв действительно
          доходит до них (`revokeSessionsEverywhere` рассылает хостам), но человек об этом не знал —
          а именно ради этого требование и писалось. Тот, кто ходит гостем на чужие серверы, должен
          понимать, что нажатие закрывает и их, не проверяя это на себе. */}
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        Разлогинит этот аккаунт на всех остальных устройствах (браузеры, десктоп, телефон) и там, где
        вы были гостем на других инстансах. Текущая сессия останется активной.
      </div>
      <label className="settings-row col">
        <span>Пароль</span>
        <input type="password" value={loPw} onChange={(e) => setLoPw(e.target.value)} autoComplete="current-password" />
      </label>
      <div className="sec-actions">
        <button type="button" className="settings-action" disabled={loBusy || !loPw} onClick={logoutEverywhere}>
          {loBusy ? '…' : 'Выйти на всех устройствах'}
        </button>
      </div>

      {/* ---- 2FA ---- */}
      <div className="settings-group-label" id="set-g-2fa" style={{ marginTop: 22 }}>
        Двухфакторная аутентификация (2FA)
      </div>

      {user.twoFactorEnabled ? (
        view === 'disable' ? (
          <div className="sec-block">
            <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
              Подтвердите паролем и кодом из приложения (или резервным кодом), чтобы отключить 2FA.
            </div>
            <label className="settings-row col">
              <span>Пароль</span>
              <input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
            </label>
            <label className="settings-row col">
              <span>Код приложения или резервный код</span>
              <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="123456 / xxxx-xxxx" />
            </label>
            <div className="sec-actions">
              <button type="button" onClick={() => setView('idle')}>
                Отмена
              </button>
              <button type="button" className="danger" disabled={busy || !disablePw || !disableCode} onClick={confirmDisable}>
                {busy ? '…' : 'Отключить 2FA'}
              </button>
            </div>
          </div>
        ) : view === 'codes' && backupCodes ? (
          <BackupCodesView codes={backupCodes} onDone={() => { setBackupCodes(null); setView('idle'); }} />
        ) : (
          <div className="sec-block">
            <div className="sec-status on">
              <Icon name="lock" size={15} /> Включена — при входе запрашивается код
            </div>
            <div className="sec-actions">
              <button type="button" className="danger" onClick={() => setView('disable')}>
                Отключить
              </button>
            </div>
          </div>
        )
      ) : view === 'codes' && backupCodes ? (
        <BackupCodesView codes={backupCodes} onDone={() => { setBackupCodes(null); setView('idle'); }} />
      ) : view === 'setup' && setup ? (
        <div className="sec-block">
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            1. Отсканируйте QR в приложении-аутентификаторе (Google Authenticator, Authy, 1Password…).
            <br />
            2. Введите 6-значный код из приложения, чтобы подтвердить.
          </div>
          <div className="totp-qr">
            <img src={setup.qrDataUrl} alt="QR для 2FA" width={200} height={200} />
            <div className="totp-secret">
              <span className="muted" style={{ fontSize: 12 }}>Не сканируется? Введите ключ вручную:</span>
              <code>{setup.secret}</code>
            </div>
          </div>
          <label className="settings-row col">
            <span>Код из приложения</span>
            <input value={enableCode} onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" inputMode="numeric" />
          </label>
          <div className="sec-actions">
            <button type="button" onClick={() => { setView('idle'); setSetup(null); }}>
              Отмена
            </button>
            <button type="button" className="primary" disabled={busy || enableCode.length < 6} onClick={confirmEnable}>
              {busy ? '…' : 'Включить 2FA'}
            </button>
          </div>
        </div>
      ) : (
        <div className="sec-block">
          <div className="sec-status off">2FA выключена — вход защищён только паролем.</div>
          <div className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
            Добавьте второй фактор: одноразовый код из приложения-аутентификатора при каждом входе.
          </div>
          <div className="sec-actions">
            <button type="button" className="primary" disabled={busy} onClick={startSetup}>
              {busy ? '…' : 'Включить 2FA'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Desktop-only: behaviour when the window's X is clicked. */
/** Browser visitors get the installer here (the app already has itself). The version + link come
    from the updater feed (/api/download/latest), so they always track the latest signed release. */
function WindowsDownload() {
  // undefined = probing the feed; null = this server hosts NO build of its own (turnkey → /download 503,
  // #48); object = its own signed installer. The button target depends on which, so we wait for the probe.
  const [feed, setFeed] = useState<{ version: string } | null | undefined>(undefined);
  useEffect(() => {
    api
      .latestDownload()
      .then((d) => setFeed({ version: d.version }))
      .catch(() => setFeed(null));
  }, []);
  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-windows">Приложение для Windows</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Отдельное десктоп-приложение: глобальные горячие клавиши, работа в трее, авто-обновление и
        нативный захват экрана. Скачайте и установите — данные те же, вход тот же.
      </div>
      {feed === undefined ? (
        <div className="muted" style={{ fontSize: 12 }}>Проверяем доступность сборки…</div>
      ) : feed ? (
        // This server publishes its own signed build → hand out its installer directly.
        <a className="dl-btn" href={api.downloadWindowsUrl()}>
          ⬇ Скачать{feed.version ? ` · v${feed.version}` : ''}
        </a>
      ) : (
        // Turnkey server with no build feed → the universal "picker" client from the project's releases.
        // It connects to any server, so the user just enters THIS server's address at login. Web-only
        // pane (isTauri ? DesktopTab : this), so a plain new-tab link is safe.
        <>
          <a className="dl-btn" href={RELEASES_URL} target="_blank" rel="noreferrer">
            ⬇ Скачать с GitHub
          </a>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Этот сервер не собирает собственную сборку — качаем универсальный клиент из релизов проекта.
            После установки при входе впишите адрес этого сервера.
          </div>
        </>
      )}
    </div>
  );
}

/** «Android» — in-app install guide for the self-hosted F-Droid store. The credentialed add-link + QR
 *  come from the AUTHED backend endpoint (never the public bundle); the guide text is static here. */
function AndroidInstallTab() {
  const [info, setInfo] = useState<
    { repoUrl: string; fingerprint: string; addUrl: string; qr: string } | null | undefined
  >(undefined);
  const [copied, setCopied] = useState(false);
  // Whether a UnifiedPush distributor (the ntfy app) is installed — gates the push-setup hint (#120).
  // Only meaningful in the Android APK; false on web/desktop, so the guide always renders there.
  const [hasDist, setHasDist] = useState(() => hasPushDistributor());
  useEffect(() => {
    api
      .fdroidInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-android">GusVoice на Android</div>
      {info === undefined && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>Загружаю данные репозитория…</div>
      )}
      {info === null && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Скачайте приложение <b>GusVoice для Android</b> (APK) со страницы релизов вашего сервера или проекта и
          установите — Android попросит разрешить установку из этого источника. Обновления придут внутри приложения.
        </div>
      )}
      {info && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            Приложение ставится из F-Droid-репозитория этого сервера. Пять шагов, пара минут.
          </div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5, display: 'grid', gap: 8 }}>
        <li>
          <b>Поставьте магазин Droid-ify.</b> Скачайте APK с{' '}
          <a href="https://f-droid.org/packages/com.looker.droidify/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
            f-droid.org
          </a>{' '}
          (кнопка «Download APK») и откройте — Android попросит разрешить установку из этого источника, разрешите. Либо
          попросите файл у того, кто вас пригласил.
        </li>
        <li>
          <b>Добавьте наш репозиторий.</b> Droid-ify → «Репозитории» → ➕ → сканируйте QR ниже (или откройте ссылку прямо
          на телефоне). Логин и пароль уже внутри — вводить ничего не нужно.
        </li>
        <li>
          <b>Отключите чужие репозитории.</b> На экране «Репозитории» выключите все стандартные — F-Droid, F-Droid Archive,
          IzzyOnDroid, Guardian Project (снимите галочку/тумблер). Оставьте включённым только добавленный репозиторий
          GusVoice и потяните вниз для синхронизации.
        </li>
        <li>
          <b>Установите GusVoice</b> (с гусём) → «Установить».
        </li>
        <li>
          <b>Войдите</b> логином и паролем вашего аккаунта GusVoice.
        </li>
          </ol>
          <div className="settings-group-label" style={{ marginTop: 18 }}>QR — сканировать в Droid-ify</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            ⚠️ Сканируйте <b>изнутри Droid-ify</b> (Репозитории → ➕ → сканировать), <b>не камерой телефона</b>: камера
            откроет ссылку в браузере и покажет 404 — это нормально, репозиторий рабочий. Внутри — логин/пароль
            репозитория, не выкладывайте публично.
          </div>
          <img
            src={info.qr}
            alt="QR для добавления репозитория"
            width={200}
            height={200}
            style={{ borderRadius: 10, background: '#fff', padding: 8, display: 'block' }}
          />

          <div className="settings-group-label" style={{ marginTop: 18 }}>Ссылка для добавления</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Открыли эту страницу прямо на телефоне? Нажмите — Droid-ify предложит добавить репозиторий.
          </div>
          <a className="dl-btn" href={info.addUrl}>
            Открыть в Droid-ify
          </a>
          <button
            type="button"
            className="settings-action"
            style={{ marginTop: 8 }}
            onClick={() => {
              void navigator.clipboard?.writeText(info.addUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Скопировано ✓' : 'Скопировать ссылку'}
          </button>

          <div className="muted" style={{ fontSize: 11, marginTop: 12, wordBreak: 'break-all' }}>
            Репозиторий: {info.repoUrl}
            <br />
            Отпечаток: {info.fingerprint}
          </div>
        </>
      )}

      {/* Push-setup guide (#120): DMs/@mentions wake the phone even when GusVoice is closed only if a
          UnifiedPush distributor (ntfy) is installed AND pointed at our server. */}
      <div className="settings-group-label" id="set-g-push" style={{ marginTop: 22 }}>Пуш-уведомления (ntfy)</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        <b>Без ntfy уведомления (ЛС, упоминания) в фоне и при закрытом приложении приходить не будут.</b> Нужен
        маленький бесплатный приёмник <b>UnifiedPush</b> — <b>ntfy</b>.
      </div>
      {isAndroid() && hasDist ? (
        <div style={{ color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>
          ✓ Приёмник установлен — пуши включены.{' '}
          {config.ntfyServer ? (
            <>
              Проверьте, что в ntfy указан сервер <code>{config.ntfyServer.replace(/^https?:\/\//, '')}</code>.
            </>
          ) : (
            <>Проверьте, что в ntfy указан адрес ntfy вашего сервера.</>
          )}
        </div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5, display: 'grid', gap: 8 }}>
          <li>
            <b>Установите ntfy</b> из F-Droid (или вашего магазина приложений).
          </li>
          <li>
            <b>Откройте ntfy → Settings (Настройки) → «Default server» (Основной сервер)</b> и впишите{' '}
            {config.ntfyServer ? <code>{config.ntfyServer}</code> : <b>адрес ntfy вашего сервера</b>}. Иначе
            приёмник уйдёт на публичный ntfy.sh. Логин и регистрация <b>не нужны</b>.
          </li>
          <li>
            <b>Там же, в «Advanced» (Расширенные) → «Connection protocol» (Протокол соединения), выберите WebSockets.</b>{' '}
            С протоколом по умолчанию за прокси сервера уведомления могут опаздывать на десятки минут.
          </li>
          <li>
            Вернитесь в GusVoice — при первом запуске он попросит выбрать приёмник (ntfy), разрешите. Всё.
          </li>
        </ol>
      )}
      {isAndroid() && (
        <button
          type="button"
          className="settings-action"
          style={{ marginTop: 10 }}
          onClick={() => setHasDist(hasPushDistributor())}
        >
          Проверить снова
        </button>
      )}
    </div>
  );
}

/**
 * ЛС этап 2 (`docs/dm/STAGE2.md`, «Переключение»): новый путь ЛС через беседы на ЭТОМ устройстве — для приёмки
 * владельцем до включения всем. Смена перезагружает страницу: шлюз должен подключиться заново с другими `caps`.
 */
function ConvClientTestRow() {
  const [on, setOn] = useState(convClientSwitch());
  const [feedWin, setFeedWin] = useState(feedWindowSwitch());
  const [bubbles, setBubbles] = useState(dmBubblesSwitch());
  const features = useStore((s) => s.serverFeatures);
  const active = useStore((s) => s.convActive);
  const supported = !!features?.includes(CAP_CONV1) && !!features?.includes(FEATURE_CONV2);
  return (
    <>
      <div className="settings-group-label" id="set-g-conv-test" style={{ marginTop: 22 }}>
        Новые ЛС
      </div>
      <div className="settings-row">
        <span>Личные сообщения через беседы</span>
        <Toggle
          checked={on}
          onChange={(v) => {
            setConvClientSwitch(v);
            setOn(v);
            location.reload();
          }}
          label="Личные сообщения через беседы"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Включены у всех, где сервер умеет беседы. Выключить — только на этом устройстве, если с ЛС что-то не так:
        вернётся прежний путь. Сейчас: {active ? 'включено' : supported ? 'выключено' : 'сервер не умеет беседы'}. После
        переключения страница перезагрузится.
      </div>
      <div className="settings-row" style={{ marginTop: 12 }}>
        <span>Лента бесед: окно и переходы</span>
        <Toggle
          checked={feedWin}
          onChange={(v) => {
            setFeedWindowSwitch(v);
            setFeedWin(v);
            location.reload();
          }}
          label="Лента бесед: окно и переходы"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Беседа открывается у первого непрочитанного или там, где вы её оставили; клик по цитате ведёт к сообщению, «Назад»
        — обратно; длинная история не копится в памяти. Включено у всех. Выключить — только на этом устройстве, если с
        лентой что-то не так: вернётся прежняя. После переключения страница перезагрузится.
      </div>
      <div className="settings-row" style={{ marginTop: 12 }}>
        <span>Пузыри в ЛС, как в Telegram (проверка)</span>
        <Toggle
          checked={bubbles}
          onChange={(v) => {
            setDmBubblesSwitch(v);
            setBubbles(v);
            location.reload();
          }}
          label="Пузыри в ЛС, как в Telegram"
        />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Свои сообщения — справа на цветном пузыре, собеседника — слева, время внутри. Каналы не меняются. Только на этом
        устройстве, пока идёт проверка.
      </div>
    </>
  );
}

function DesktopTab() {
  const [behavior, setBehavior] = useState<CloseBehavior>(getCloseBehavior());
  // Ускорение отрисовки видеокартой (#193). Умолчание — включено; выключатель нужен на случай
  // битого драйвера, когда принудительное ускорение даёт артефакты.
  const [gpu, setGpu] = useState<boolean | null>(null);
  const [gpuBusy, setGpuBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  // Installed app version (tauri.conf.json) — shown under «Обновления» so a user can always tell
  // which update they're on (and copy it into a bug report). Desktop-only: this tab is Tauri-gated.
  const [ver, setVer] = useState<string | null>(null);
  // Downloads folder: null = not chosen, so the first download opens the picker itself (downloads.ts).
  const [dlDir, setDlDir] = useState<string | null>(getDownloadDir());
  useEffect(() => {
    void appVersion().then(setVer);
    void gpuAccelGet().then(setGpu);
  }, []);
  function flipGpu(on: boolean) {
    setGpuBusy(true);
    void gpuAccelSet(on)
      .then(() => {
        setGpu(on);
        toast('info', 'Применится после перезапуска', 'Движок читает эту настройку один раз, при запуске окна');
      })
      .catch((e) => toastError(e as Error))
      .finally(() => setGpuBusy(false));
  }
  function pick(b: CloseBehavior) {
    setCloseBehavior(b);
    setBehavior(b);
  }
  const opts: { val: CloseBehavior; label: string; sub: string }[] = [
    { val: 'tray', label: 'Сворачивать в трей', sub: 'Окно прячется в трей — приложение и голос продолжают работать' },
    { val: 'quit', label: 'Закрывать приложение', sub: 'Полный выход из GusVoice' },
    { val: 'ask', label: 'Спрашивать каждый раз', sub: 'Показывать выбор при каждом закрытии' },
  ];
  return (
    <div className="settings-pane">
      {gpu !== null && (
        <>
          <div className="settings-group-label">Отрисовка</div>
          <div className="settings-row">
            <span>Рисовать окно видеокартой</span>
            <Toggle checked={gpu} onChange={flipGpu} disabled={gpuBusy} label="Рисовать окно видеокартой" />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {gpu
              ? 'Окно рисует видеокарта — процессор свободнее, а игре рядом достаётся больше. Если вместо интерфейса появились полосы или чёрные пятна, выключите: у некоторых драйверов ускорение работает криво.'
              : 'Окно рисует процессор. Медленнее и заметно дороже, зато работает на любом драйвере.'}{' '}
            Настройка применяется после перезапуска приложения.
          </div>
        </>
      )}
      <div className="settings-group-label" id="set-g-close">
        При нажатии на крестик
      </div>
      {/* display:contents keeps the options direct children of .settings-pane so its gap survives. */}
      <div role="group" aria-labelledby="set-g-close" style={{ display: 'contents' }}>
        {opts.map((o) => (
          <button
            key={o.val}
            type="button"
            aria-pressed={behavior === o.val}
            className={`close-opt ${behavior === o.val ? 'on' : ''}`}
            onClick={() => pick(o.val)}
          >
            <span className="close-opt-text">
              <span>{o.label}</span>
              <span className="close-opt-sub">{o.sub}</span>
            </span>
            {behavior === o.val && <Icon name="check" size={16} />}
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Иконка в трее позволяет вернуть окно (клик) или выйти из приложения (правый клик → «Выйти»).
      </div>

      <div className="settings-group-label" id="set-g-downloads" style={{ marginTop: 18 }}>Загрузки</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {dlDir ? (
          <>
            Файлы из чата сохраняются в <b>{dlDir}</b>. Одноимённые не перезаписываются — рядом ляжет
            «файл (1)».
          </>
        ) : (
          'Папка не выбрана — спросим при первом скачивании.'
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="settings-action"
          onClick={() => {
            void chooseDownloadDir().then((d) => d && setDlDir(d));
          }}
        >
          {dlDir ? 'Изменить папку' : 'Выбрать папку'}
        </button>
        {dlDir && (
          <button
            type="button"
            className="settings-action"
            title="Забыть папку — при следующем скачивании спросим заново"
            onClick={() => {
              setDownloadDir(null);
              setDlDir(null);
            }}
          >
            Спрашивать снова
          </button>
        )}
      </div>

      <div className="settings-group-label" id="set-g-updates" style={{ marginTop: 18 }}>Обновления</div>
      {ver && (
        // A real <button>: it copies on click, so it has to be reachable and pressable from the
        // keyboard. Styled flat so it still reads as the caption it looks like.
        <button
          type="button"
          className="muted"
          style={{
            fontSize: 12,
            marginBottom: 4,
            width: 'fit-content',
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          }}
          title="Нажмите, чтобы скопировать"
          onClick={() => {
            navigator.clipboard
              ?.writeText(`GusVoice v${ver}`)
              .then(() => toast('success', 'Версия скопирована', `GusVoice v${ver}`))
              .catch(() => {});
          }}
        >
          Текущая версия: <b>v{ver}</b>
        </button>
      )}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Приложение обновляется автоматически при перезапуске. Можно проверить прямо сейчас — если найдётся
        новее, появится предложение обновить.
      </div>
      <button
        type="button"
        className="settings-action"
        disabled={checking}
        onClick={async () => {
          setChecking(true);
          try {
            await manualUpdateCheck();
          } finally {
            setChecking(false);
          }
        }}
      >
        {checking ? 'Проверяю…' : 'Проверить обновления'}
      </button>
    </div>
  );
}

/**
 * Состояние разрешения на уведомления + кнопка запроса — одна строка на обе панели.
 *
 * 🔴 **Почему это отдельный узел.** Разрешение спрашивалось молча, при выборе положения, и отказ
 * системы откатывал выбор назад. Со стороны это выглядело как «кнопки не нажимаются» (04.09):
 * человек жмёт, ничего не меняется, и почему — не сказано нигде.
 * ⚠️ Отказавшему второй раз системный запрос уже не показывается — ни в Windows, ни в браузере.
 * Поэтому там, где мы умеем, ведём прямо в системные настройки, а не предлагаем жать бесполезное.
 */
function NotifyPermissionRow() {
  const [perm, setPerm] = useState<NotifyPermission | null>(null);
  const refresh = () => void notifyPermissionState().then(setPerm);
  useEffect(refresh, []);
  if (perm === null) return null;
  if (perm === 'granted') {
    return (
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Разрешение на уведомления: <b>есть</b>.
      </div>
    );
  }
  return (
    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
      {perm === 'unsupported' ? (
        'В этой среде системные уведомления недоступны — настройки ниже ничего не покажут.'
      ) : (
        <>
          Разрешение на уведомления <b>не выдано</b> — до этого всплывашки не придут, как ни
          настраивай.{' '}
          <button
            type="button"
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}
            onClick={() => void requestNotifyPermission().then(refresh)}
          >
            Запросить
          </button>
          {isTauri() && (
            <>
              {' · '}
              <button
                type="button"
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}
                // Отказавшему один раз Windows больше не покажет запрос — остаётся только системный
                // переключатель, и довести до него честнее, чем оставить человека с немой кнопкой.
                onClick={() => void openExternal('ms-settings:notifications')}
              >
                Настройки Windows
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Настройки уведомлений как у Telegram (08.10, #211, G38, `push2`): «Показывать имя отправителя» / «Показывать текст
 * сообщения» (tdesktop `settings_notifications.cpp`: галочки «Имя» и «Текст»; без имени нет и текста — `ShowNothing`) и
 * «Уведомления из групп» (там же, «Уведомления для чатов → Группы»). Серверные: живут в профиле (`PATCH /users/me`),
 * действуют на пуш телефона (сервер), всплывашку браузера и тост десктопа (`notifications.osNotify`).
 */
function NotifyContentSetting({ onClose }: { onClose: () => void }) {
  const on = useStore((s) => serverPush2(s.serverFeatures));
  const push3 = useStore((s) => serverPush3(s.serverFeatures));
  const user = useStore((s) => s.user);
  const setAuth = useStore((s) => s.setAuth);
  if (!on || !user) return null;
  const view = normalizeNotifyView(user.notifyView);
  const save = (body: {
    notifyView?: ReturnType<typeof normalizeNotifyView>;
    notifyGroups?: boolean;
    notifyDm?: boolean;
    notifyRepeat?: number;
  }) =>
    api.updateProfile(body).then(setAuth, toastError);
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="settings-group-label" id="set-g-notify-view">
        Что показывать в уведомлениях
      </div>
      <div className="settings-row">
        <span>Показывать имя отправителя</span>
        <Toggle
          checked={notifyShowsName(view)}
          onChange={(v) => void save({ notifyView: notifyViewOf(v, v && notifyShowsText(view)) })}
          label="Показывать имя отправителя"
        />
      </div>
      <div className="settings-row">
        <span>Показывать текст сообщения</span>
        <Toggle
          checked={notifyShowsText(view)}
          onChange={(v) => void save({ notifyView: notifyViewOf(v || notifyShowsName(view), v) })}
          label="Показывать текст сообщения"
        />
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Действует на телефоне, на компьютере и в браузере. Если скрыто, придёт просто «Новое сообщение». Пока вы за
        компьютером, телефон ждёт 30 секунд и молчит, если сообщение уже прочитано.
      </div>
      {push3 && (
        <>
          <div className="settings-group-label" id="set-g-notify-dm" style={{ marginTop: 22 }}>
            Личные сообщения
          </div>
          <div className="settings-row">
            <span>Сообщения в личных беседах</span>
            <Toggle checked={user.notifyDm !== false} onChange={(v) => void save({ notifyDm: v })} label="Уведомления из личных бесед" />
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Выключите — личные сообщения будут приходить без уведомлений (на телефон, в браузер и на компьютер).
          </div>
        </>
      )}
      <div className="settings-group-label" id="set-g-notify-groups" style={{ marginTop: 22 }}>
        Уведомления из групп
      </div>
      <div className="settings-row">
        <span>Сообщения в группах</span>
        <Toggle
          checked={user.notifyGroups !== false}
          onChange={(v) => void save({ notifyGroups: v })}
          label="Уведомления из групп"
        />
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Выключите — сообщения групп будут приходить без уведомлений. Личные сообщения уведомляют, как раньше.
      </div>
      <NotifyExceptions onOpen={onClose} />
      {push3 && (
        <>
          <div className="settings-group-label" id="set-g-notify-repeat" style={{ marginTop: 22 }}>
            Повторять уведомления
          </div>
          <Select
            value={String(normalizeNotifyRepeat(user.notifyRepeat))}
            onChange={(v) => void save({ notifyRepeat: Number(v) })}
            title="Повторять уведомления"
            ariaLabel="Повторять уведомления"
            options={NOTIFY_REPEAT_MINUTES.map((m) => ({ value: String(m), label: notifyRepeatLabel(m) }))}
          />
          <div className="muted" style={{ fontSize: 13 }}>
            Если личное сообщение висит непрочитанным, на телефон придёт напоминание — не больше {NOTIFY_REPEAT_MAX} раз подряд.
            Прочитали или выключили звук беседы — напоминания прекращаются.
          </div>
        </>
      )}
    </div>
  );
}

/** «Системные уведомления» — OS-level toasts while the window is unfocused (#77: три положения). */
function OsNotifyPanel() {
  const [level, setLevel] = useState<OsNotifyLevel>(osNotifyLevel());
  const [hint, setHint] = useState<string | null>(null);
  const on = level !== 'off';

  async function pick(next: OsNotifyLevel) {
    // Разрешение спрашиваем при ЛЮБОМ включении (в т.ч. при переходе mentions→all), иначе
    // человек выберет «все сообщения» и не поймёт, почему тихо.
    if (next !== 'off') {
      const perm = await requestNotifyPermission();
      // 🔴 Выбор СОХРАНЯЕМ даже без разрешения (04.09). Откат назад читался как «кнопка не
      // нажимается»: человек выбрал, ничего не изменилось, объяснения нет. Настройка — это его
      // намерение; разрешение — отдельная преграда, и про неё сказано строкой выше.
      if (perm !== 'granted') {
        setHint(
          perm === 'denied'
            ? 'Выбор сохранён, но разрешение не выдано — всплывашки не придут, пока не разрешите их системе.'
            : 'В этой среде системные уведомления пока недоступны — выбор сохранён на будущее.',
        );
        setOsNotifyLevel(next);
        setLevel(next);
        return;
      }
    }
    setHint(null);
    setOsNotifyLevel(next);
    setLevel(next);
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="settings-group-label" id="set-g-osn">
        Системные уведомления
      </div>
      <div className="seg" role="group" aria-labelledby="set-osn-label">
        {(
          [
            ['off', 'Выключены'],
            ['mentions', 'Упоминания и ЛС'],
            ['all', 'Все сообщения'],
          ] as const
        ).map(([val, label]) => (
          <button
            key={val}
            type="button"
            aria-pressed={level === val}
            // ⚠️ Класс подсветки в `.seg` называется `on` — `sel` в стилях НЕТ вовсе. Из-за опечатки
            // выбранное положение не подсвечивалось ни в одной панели уведомлений, и настройка
            // выглядела мёртвой: жмёшь — ничего не меняется (04.09).
            className={level === val ? 'on' : undefined}
            onClick={() => void pick(val)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Показываются системой, только когда окно GusVoice не в фокусе. «Все сообщения» уважают
        настройку каждого канала: заглушённый канал молчит, а из живого приходит не чаще одного
        уведомления в 20 секунд. Личные сообщения приходят в обоих включённых режимах.
        {on && (
          <>
            {' '}
            <button
              type="button"
              className="link-btn"
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}
              onClick={() => osNotify('GusVoice', 'Так выглядит уведомление 🦆', undefined, true)}
            >
              Проверить
            </button>
          </>
        )}
      </div>
      {hint && (
        <div className="muted" role="alert" style={{ fontSize: 12, color: 'var(--danger, #e5484d)', marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * «Уведомления о монетах» — кто кого типнул и ущипнул (запрос 04.09).
 *
 * 🔴 Отдельно от уведомлений о сообщениях: это разные потоки, и выключивший болтовню не обязан
 * терять монеты. Умолчание «когда меня» — адресное событие редкое, а чужую ленту включают сами.
 * ⚠️ Панель показывается только там, где экономика вообще видна: настройка про то, чего нет, —
 * мусор в окне.
 */
function CoinNotifyPanel() {
  const [level, setLevel] = useState<CoinNotifyLevel>(coinNotifyLevel());
  const [hint, setHint] = useState<string | null>(null);

  async function pick(next: CoinNotifyLevel) {
    if (next !== 'off') {
      const perm = await requestNotifyPermission();
      // Выбор сохраняем и без разрешения — разбор в `NotifyPermissionRow`.
      if (perm !== 'granted') {
        setHint(
          perm === 'denied'
            ? 'Выбор сохранён, но разрешение не выдано — всплывашки не придут, пока не разрешите их системе.'
            : 'В этой среде системные уведомления пока недоступны — выбор сохранён на будущее.',
        );
        setCoinNotifyLevel(next);
        setLevel(next);
        return;
      }
    }
    setHint(null);
    setCoinNotifyLevel(next);
    setLevel(next);
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="settings-group-label" id="set-g-coin">
        Уведомления о монетах
      </div>
      <div className="seg" role="group" aria-labelledby="set-coin-notify-label">
        {(
          [
            ['off', 'Выключены'],
            ['mine', 'Когда меня'],
            ['all', 'Все в канале'],
          ] as const
        ).map(([val, label]) => (
          <button
            key={val}
            type="button"
            aria-pressed={level === val}
            // ⚠️ Класс подсветки в `.seg` называется `on` — `sel` в стилях НЕТ вовсе. Из-за опечатки
            // выбранное положение не подсвечивалось ни в одной панели уведомлений, и настройка
            // выглядела мёртвой: жмёшь — ничего не меняется (04.09).
            className={level === val ? 'on' : undefined}
            onClick={() => void pick(val)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Типы и щипки — как и остальные уведомления, только когда окно не в фокусе и не стоит «не
        беспокоить». «Все в канале» показывают и чужие, но не чаще одного раза в 20 секунд; когда
        типают или щипают лично тебя, уведомление приходит всегда.
        {/* C4: «полноэкранная игра Windows» — про десктоп, на телефоне предупреждение не нужно. */}
        {!isMobile() && ' ⚠️ В полноэкранной игре Windows прячет уведомления — оттуда доходит только звук.'}
      </div>
      {hint && (
        <div className="muted" role="alert" style={{ fontSize: 12, color: 'var(--danger, #e5484d)', marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Доехать до группы настроек — плавно, когда это видно, и гарантированно всегда.
 *
 * 🔴 Плавная прокрутка — это анимация, а анимации в СКРЫТОЙ вкладке браузер не выполняет вовсе.
 * Замерено на проде: мгновенная уезжает на 1333 px, плавная не двигается ни на пиксель — то есть
 * клик по разделу в фоновой вкладке молча не делал НИЧЕГО. Поэтому решаем по видимости, а не
 * надеемся: на экране — плавно (так живее, и это осознанный выбор), в фоне — сразу.
 *
 * ⚠️ И всё равно страхуемся: если через полсекунды позиция не сдвинулась (браузер урезал анимации,
 * вкладку спрятали посреди пути), дожимаем мгновенно. Обещание «нажал — попал» важнее красоты.
 */
function scrollToAnchor(el: HTMLElement, box: HTMLElement | null) {
  const before = box?.scrollTop ?? 0;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = document.visibilityState === 'visible' && !calm;
  el.scrollIntoView({ block: 'start', behavior: canAnimate ? 'smooth' : 'auto' });
  if (!canAnimate) return;
  setTimeout(() => {
    if (box && Math.abs(box.scrollTop - before) < 2) el.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, 500);
}

export function UserSettingsModal({ onClose }: { onClose: () => void }) {
  // Раздел «Федерация» появляется ТОЛЬКО на инстансе с федерацией (#139, §5.7): без неё он отвечал
  // бы на вопрос, которого у человека нет, и пугал бы словом «гость» на ровном месте.
  const fed = useFederationEnabled();
  const desktop = isDesktop();
  const mobile = isMobile();
  // «Мои инстансы» — там, где у приложения свой реестр инстансов (десктоп, Android); в вебе инстанс один.
  const multi = multiInstanceEnabled();
  const superAdmin = useStore((s) => !!s.user?.superAdmin);
  // Папки бесед ЛС (G40) — только при сервере `folders1` и новых ЛС; из меню вкладки окно открывается сразу на них.
  const folders = useFoldersOn();
  const sections = useMemo(
    () => visibleSections({ federation: fed, desktop, mobile, multi, superAdmin, folders }),
    [fed, desktop, mobile, multi, superAdmin, folders],
  );
  const [section, setSection] = useState<SectionKey>(() => (hasFolderEditRequest() ? 'folders' : 'sound'));
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState<string | null>(null);
  // Телефон: сперва список разделов, тап — экран раздела (list→detail, как везде в приложении).
  const [picked, setPicked] = useState(hasFolderEditRequest);

  /**
   * Системная «назад» на телефоне: из раздела — к списку разделов, и только потом закрытие окна.
   * Без этого один жест закрывал окно целиком (найдено на живом устройстве).
   */
  useEffect(() => {
    if (!picked) return;
    return pushBackHandler(() => {
      setPicked(false);
      return true;
    });
  }, [picked]);

  const [live, setLive] = useState<string[]>([]);
  /** До какого момента НЕ слушаем скролл: пока едем сами, «кто сверху» отвечает про прошлую группу. */
  const scrollLock = useRef(0);
  /**
   * Что здесь не как с завода (#153) — точка у раздела и группы, счётчик в шапке.
   *
   * 🔴 Пересчитываем ПО ЖЕСТУ, а не на каждый рендер: настройки лежат в десятке разных хранилищ,
   * половина меняется из вложенных панелей со своим состоянием, и подписки есть не у всех. Жест
   * внутри этого окна — единственное общее событие, после которого значение могло измениться.
   */
  const [marks, setMarks] = useState<SettingsMarks>(() => markChanged(readSettings(), factorySettings()));
  // Отпечатки значений по группам и то, какие из них человек уже видел (точка «изменено» гаснет
  // наведением и загорается снова, когда значение поменяли, — `settingsChanged.groupPrints`).
  const [prints, setPrints] = useState<Record<string, string>>(() => groupPrints(readSettings()));
  const [changedSeen, setChangedSeen] = useState<Record<string, string>>(() => seenChangedPrints());
  const dotOn = (id: string) => changedDotOn(marks[id], changedSeen[id], prints[id]);
  function refreshMarks() {
    // ⚠️ `setTimeout`, а не `requestAnimationFrame`: в фоновой вкладке rAF не вызывается вовсе, и
    // маркеры замерли бы ровно там, где окно оставили. Ноль нужен, чтобы обработчик самой строки
    // успел записать новое значение — перехват идёт до него.
    //
    // 🔴 Слушаем `click`/`change`, а НЕ `pointerup`. На мышке разницы нет — они приходят одной
    // задачей, и отложенный на ноль пересчёт видел уже новое значение. На ТАЧЕ между ними пауза:
    // пересчёт успевал первым и читал прошлое состояние, поэтому счётчик на телефоне отставал
    // ровно на одно касание (переключил — тихо, переключил ещё раз — показалось первое).
    // Поймано на живом телефоне; ни типы, ни тесты, ни проверка в браузере этого не видят.
    setTimeout(() => {
      const snap = readSettings();
      const next = markChanged(snap, factorySettings());
      setMarks((prev) => (sameMarks(prev, next) ? prev : next));
      const nextPrints = groupPrints(snap);
      setPrints((prev) => (samePrints(prev, nextPrints) ? prev : nextPrints));
    }, 0);
  }
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  const hits = searchSettings(query, sections);
  const current = sections.find((s) => s.key === section) ?? sections[0];
  const headMark = marksLabel(sectionMark(marks, current.groups));

  /**
   * Перейти к найденной настройке и подсветить её.
   *
   * ⚠️ Подсветка временная (класс снимается через пару секунд), а не постоянное состояние: она
   * отвечает на вопрос «куда я попал», а не помечает строку навсегда.
   */
  function goTo(sec: SectionKey, id: string) {
    setSection(sec);
    setPicked(true);
    setQuery('');
    setAnchor(id);
    // 🔴 Глушим слежение за скроллом, пока едем САМИ. Иначе полоска у якоря мигает: её ставят на
    // нужную группу сразу, плавная прокрутка тут же зовёт пересчёт «кто сверху» — а сверху всё ещё
    // предыдущая группа, — полоска отскакивает назад и возвращается только по прибытии.
    scrollLock.current = Date.now() + 900;
    // Ждём перерисовку: раздел только что переключился, узла с этим id в дереве ещё нет.
    setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      scrollToAnchor(el, bodyRef.current);
      el.classList.add('set-hit');
      setTimeout(() => el.classList.remove('set-hit'), 2600);
    });
  }



  /**
   * «Ты сюда ещё не заглядывал» — вторая отметка, независимая от «изменено» (19.09, просьба
   * владельца). Она про то, ЗНАЕТ ли человек, что настройка появилась, а не про её значение.
   *
   * ⚠️ Группа считается просмотренной, когда РЕАЛЬНО побывала перед глазами: пробыла в видимой
   * части списка полсекунды или человек навёл на неё мышь. Отмечать по «открыл раздел» нельзя —
   * в разделе полтора десятка групп, и нижние он не видел.
   */
  const [seen, setSeen] = useState<Set<string>>(() => seenGroups());

  useEffect(() => {
    seedSeenOnce(SECTIONS.flatMap((sec) => sec.groups.map((g) => g.id)));
    setSeen(seenGroups());
  }, []);

  function noteSeen(id: string): void {
    if (seen.has(id)) return;
    markGroupSeen(id);
    setSeen(seenGroups());
  }

  /** Погасить точки «изменено» у групп — запомнить их нынешние значения как увиденные. */
  function noteChangedSeen(ids: string[]): void {
    const lit = ids.filter((id) => dotOn(id) && prints[id] !== undefined);
    if (lit.length === 0) return;
    markChangedSeen(Object.fromEntries(lit.map((id) => [id, prints[id]!])));
    setChangedSeen(seenChangedPrints());
  }

  /**
   * Наведение гасит точки не сразу, а через 300 мс под курсором: мышь, пролетевшая через весь рельс
   * к другой кнопке, иначе стёрла бы все отметки разом, и человек их так и не увидел бы.
   */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function hoverAck(ids: string[]) {
    return {
      onMouseEnter: () => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => noteChangedSeen(ids), 300);
      },
      onMouseLeave: () => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      },
    };
  }

  /**
   * Наведение на группу СПРАВА подсвечивает её заголовок так же, как переход к ней из рельса слева
   * (просьба владельца 23.09), и гасит её точку «изменено». Класс ставим прямо на узел, как `set-hit`:
   * состояние в React перерисовывало бы всю панель на каждое движение мыши.
   */
  const hoverLabel = useRef<HTMLElement | null>(null);
  function setHoverLabel(next: HTMLElement | null) {
    if (hoverLabel.current === next) return;
    hoverLabel.current?.classList.remove('set-hover');
    hoverLabel.current = next;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (!next) return;
    next.classList.add('set-hover');
    const id = next.id;
    hoverTimer.current = setTimeout(() => noteChangedSeen([id]), 300);
  }

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.id;
          if (e.isIntersecting) {
            if (timers.has(id)) continue;
            // Полсекунды на виду: пролистанное насквозь просмотренным не считается.
            timers.set(id, setTimeout(() => noteSeen(id), 500));
          } else {
            const t = timers.get(id);
            if (t) clearTimeout(t);
            timers.delete(id);
          }
        }
      },
      { root: body, threshold: 0.6 },
    );
    for (const g of current.groups) {
      const el = document.getElementById(g.id);
      if (el) io.observe(el);
    }
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, live]);
  /**
   * Показать, ЧТО именно изменено: доехать до первой изменённой группы и подсветить все.
   *
   * ⚠️ Подсветка та же, что у поиска (`set-hit`), и по той же причине гаснет сама: это ответ на
   * вопрос «где оно», а не состояние, которое надо потом снимать руками.
   */
  function showChanged() {
    const changed = current.groups.filter((g) => (marks[g.id]?.changed ?? 0) > 0).map((g) => g.id);
    if (changed.length === 0) return;
    scrollLock.current = Date.now() + 900;
    setAnchor(changed[0]!);
    setTimeout(() => {
      const first = document.getElementById(changed[0]!);
      if (first) scrollToAnchor(first, bodyRef.current);
      for (const id of changed) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.add('set-hit');
        setTimeout(() => el.classList.remove('set-hit'), 2600);
      }
    });
  }
  /**
   * Какие группы РЕАЛЬНО есть в открытом разделе.
   *
   * ⚠️ Половина настроек показывается по условию: «Игровая активность» — не у всех, оверлей и
   * загрузки — только в десктопной оболочке. Якорь на то, чего в разделе нет, — обещание, которого
   * рельс не держит: нажимаешь и не происходит ничего. Поэтому список якорей сверяется с деревом.
   */
  useEffect(() => {
    // ⚠️ Через таймер, а не requestAnimationFrame: кадры в СКРЫТОМ окне не рисуются вовсе, и
    // список якорей остался бы пустым до первого показа. Поймано на стенде — пейн был в фоне.
    const t = setTimeout(() => setLive(current.groups.filter((g) => document.getElementById(g.id)).map((g) => g.id)), 0);
    return () => clearTimeout(t);
  }, [current]);

  // Какая группа сейчас наверху — тем якорем и светится рельс. Дешёвая проверка на скролле: групп
  // в разделе меньше десятка, IntersectionObserver тут был бы из пушки по воробьям.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      // Пока идёт наша собственная плавная прокрутка, «кто сверху» врёт — ответ придёт по прибытии.
      if (Date.now() < scrollLock.current) return;
      const top = body.getBoundingClientRect().top;
      const groups = current.groups
        .map((g) => ({ id: g.id, el: document.getElementById(g.id) }))
        .filter((g): g is { id: string; el: HTMLElement } => !!g.el)
        .map((g) => ({ id: g.id, top: g.el.getBoundingClientRect().top - top }));
      setAnchor(activeAnchor({ groups, atBottom: atBottomOf(body) }));
    };
    onScroll();
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, [current]);

  // Ctrl+K — в поиск. Ровно та привычка, с которой люди приходят из редакторов и мессенджеров.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPicked(false);
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function openSection(key: SectionKey) {
    setSection(key);
    setPicked(true);
    bodyRef.current?.scrollTo({ top: 0 });
  }

  return (
    <SettingsWindow
      variant="user"
      picked={picked}
      onClose={onClose}
      titleId="settings-title"
      dialogRef={dialogRef}
      onClickCapture={refreshMarks}
      onChangeCapture={refreshMarks}
      onKeyUpCapture={refreshMarks}
      rail={
        <SettingsRail
          title="Настройки"
          label="Разделы настроек"
          onClose={onClose}
          search={
            <SettingsSearch
              inputRef={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
                if (e.key === 'Enter' && hits[0]) goTo(hits[0].section, hits[0].id);
              }}
            />
          }
        >
          {sections.map((s) => (
            <div key={s.key}>
              <RailItem
                id={`set-tab-${s.key}`}
                icon={s.icon}
                label={s.label}
                active={section === s.key}
                changed={s.groups.some((g) => dotOn(g.id))}
                unseen={s.groups.some((g) => !seen.has(g.id))}
                onClick={() => openSection(s.key)}
                {...hoverAck(s.groups.map((g) => g.id))}
              />
              {section === s.key && s.groups.length > 1 && (
                <RailAnchors>
                  {s.groups.filter((g) => live.length === 0 || live.includes(g.id)).map((g) => (
                    <RailAnchor
                      key={g.id}
                      on={anchor === g.id}
                      changed={dotOn(g.id)}
                      unseen={!seen.has(g.id)}
                      onClick={() => goTo(s.key, g.id)}
                      onMouseEnter={() => {
                        noteSeen(g.id);
                        hoverAck([g.id]).onMouseEnter();
                      }}
                      onMouseLeave={hoverAck([g.id]).onMouseLeave}
                    >
                      {g.label}
                    </RailAnchor>
                  ))}
                </RailAnchors>
              )}
            </div>
          ))}
        </SettingsRail>
      }
    >
      <SettingsHead
        title={current.label}
        titleId="settings-title"
        sub={current.sub}
        // Счётчик молчит, когда всё заводское: «изменено 0 из 14» — это шум в каждом окне у каждого, кто
        // настройки не трогал. Клик ведёт к первой изменённой группе и подсвечивает все изменённые тем же
        // приёмом, что и поиск (`set-hit` гаснет сам — это подсказка, а не состояние).
        // ⚠️ Живёт вместе с точками (решение владельца 23.09): все изменения раздела увидены — счётчика нет,
        // поменяли что-то снова — появится вместе с точкой.
        changed={headMark && current.groups.some((g) => dotOn(g.id)) ? headMark : undefined}
        onShowChanged={showChanged}
        onBack={() => setPicked(false)}
        onClose={onClose}
      />

      {hits.length > 0 && (
        <div className="set-results" role="listbox" aria-label="Результаты поиска">
          <div className="set-results-label">НАЙДЕНО · {hits.length}</div>
          {hits.map((h) => (
            <button key={h.id} type="button" className="set-result" onClick={() => goTo(h.section, h.id)}>
              <Icon name={sectionOf(h.section).icon} size={16} />
              <span className="set-result-text">
                <span className="set-result-title">{h.title}</span>
                <span className="set-result-path">{h.path}</span>
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
      )}
      {query.length >= SEARCH_MIN && hits.length === 0 && (
        <div className="set-results">
          <div className="set-nothing">
            Ничего не нашлось по «{query}». Попробуйте другое слово — например, «звук» или «пароль».
          </div>
        </div>
      )}

      <div
        className="settings-body"
        id="settings-body"
        role="tabpanel"
        aria-labelledby={`set-tab-${section}`}
        ref={bodyRef}
        onMouseOver={(e) => setHoverLabel(bodyRef.current ? groupLabelAt(e.target as Element, bodyRef.current) : null)}
        onMouseLeave={() => setHoverLabel(null)}
      >
        {/* Обёртка с ключом по разделу: на ней живёт появление содержимого. Анимировать сам
            блок прокрутки нельзя — его пересоздание рвало бы слежение за скроллом. */}
        <div className="set-pane-anim" key={section}>
        {section === 'sound' && <AudioVideoTab />}
        {section === 'notif' && (
          <div className="settings-pane">
            <NotifyPermissionRow />
            <OsNotifyPanel />
            <NotifyContentSetting onClose={onClose} />
            <CoinNotifyPanel />
            {/* Плашка «кто кого типнул» переехала сюда из «Аудио и видео»: искали её здесь. */}
            {desktop && <ToastSettingsPanel />}
            <div className="settings-group-label" id="set-g-sounds">
              Звуки уведомлений
            </div>
            <SoundSettingsPanel />
          </div>
        )}
        {section === 'look' && (
          <>
            <AppearanceTab />
            {desktop && (
              <div className="settings-pane">
                <OverlaySettingsPanel />
              </div>
            )}
          </>
        )}
        {section === 'account' && (
          <>
            <AccountTab onClose={onClose} />
            <SecurityTab />
            <LastSeenPrivacySetting />
            <CallPrivacySetting />
            <BlockedUsersSetting />
          </>
        )}
        {section === 'federation' && (
          <>
            {multi && <InstancesPanel onClose={onClose} />}
            {fed && (
              <>
                <div className="settings-pane">
                  <div className="settings-group-label" id="set-g-guest">
                    Где я гость
                  </div>
                </div>
                <GuestPlacesPanel />
              </>
            )}
          </>
        )}
        {section === 'data' && <DataStorageSettings />}
        {section === 'folders' && <DmFolderSettings />}
        {section === 'apps' && (
          <>
            {isTauri() ? <DesktopTab /> : <WindowsDownload />}
            <AndroidInstallTab />
            {superAdmin && <ConvClientTestRow />}
          </>
        )}
        </div>
      </div>
    </SettingsWindow>
  );
}
