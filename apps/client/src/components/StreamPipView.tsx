import { useTracks, VideoTrack, type TrackReference } from '@livekit/components-react';
import { Track, type RemoteTrackPublication, type RemoteVideoTrack } from 'livekit-client';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNameResolver } from '../memberName';
import { useStore, voiceIsHere } from '../store';
import { ownerOf } from '../streamAudioRules';
import {
  closeStreamPip,
  focusMainWindow,
  openStreamPip,
  removeFromStreamPip,
  streamPipAvailable,
  useStreamPipWindow,
} from '../streamPip';
import { isInPip, pipGone, pipLayout, type PipCell } from '../streamPipRules';
import {
  resolutionText,
  setStreamQuality,
  STREAM_QUALITY_LABEL,
  streamQualityMenu,
  useStreamQuality,
} from '../streamQuality';
import { toast, toastError } from '../toast';
import { MenuItem, MenuSection } from './ContextMenu';
import { Icon } from './Icon';
import { StreamVolumeControl, useStreamVolumePop } from './StreamVolumeControl';
import { returnToVoice } from './VoicePanel';

export { closeStreamPip, removeFromStreamPip };

/**
 * Вернуть показ из окошка на сцену: он остаётся ОТКРЫТЫМ (`watchStream`), иначе после ухода со сцены (она
 * очищает открытые) он вернулся бы карточкой, а не кадром — как «развернуть» у окошка Telegram Desktop.
 * Остальные показы окошка остаются в нём (#223); последний — окошко закрывается.
 */
function returnToStage(id: string): void {
  useStore.getState().watchStream(id);
  removeFromStreamPip(id);
}

/** Открыть сцену голосового канала, где идёт голос (другой инстанс — тем же путём, что «Вернуться» в панели голоса). */
function showVoiceStage(): void {
  const st = useStore.getState();
  const v = st.voice;
  if (!v) return;
  if (!voiceIsHere(v)) {
    returnToVoice(v);
    return;
  }
  if (st.currentChannelId === v.channelId) return;
  if (v.serverId && st.currentServerId !== v.serverId) void st.openServer(v.serverId, v.channelId).catch(toastError);
  else void st.openChannel(v.channelId).catch(toastError);
}

/**
 * Кнопка ⧉ «Картинка в картинке» в ряду кнопок показа на сцене (#222). Окошко уже открыто — та же кнопка
 * ДОБАВЛЯЕТ показ в него (#223); показ уже в окошке — возвращает его на сцену. Нет ни одного API или это
 * Android — кнопки нет.
 */
export function StreamPipButton({ track }: { track: TrackReference }) {
  const inPip = isInPip(track.participant.identity, useStore((s) => s.pipStreams));
  const win = useStreamPipWindow();
  if (!streamPipAvailable()) return null;
  const title = inPip ? 'Вернуть показ из окошка' : win ? 'Добавить в окошко' : 'Картинка в картинке';
  return (
    <button
      type="button"
      className={`ctl${inPip ? ' open' : ''}`}
      title={title}
      aria-pressed={inPip}
      onClick={() => {
        if (inPip) {
          returnToStage(track.participant.identity);
          return;
        }
        openStreamPip(track).catch(() =>
          toast('warn', 'Не удалось открыть окошко', 'Браузер не дал открыть «картинку в картинке» для этого показа.'),
        );
      }}
    >
      <Icon name="pip" size={18} />
    </button>
  );
}

/** Заглушка на сцене вместо кадра показа, пока он в окошке. «Вернуть» убирает его из окошка, показ остаётся на сцене. */
export function StreamPipStub({ id }: { id: string }) {
  return (
    <div className="screen-pip-stub">
      <Icon name="pip" size={32} />
      <span>Показ в отдельном окне</span>
      <button
        type="button"
        className="btn"
        onClick={(e) => {
          e.stopPropagation();
          returnToStage(id);
        }}
      >
        Вернуть
      </button>
    </div>
  );
}

/**
 * Хост окошка: смонтирован в `VoiceConnection`, то есть пока мы в голосе. Рисует вид порталом в окно
 * документа; показа больше нет в комнате (стример завершил показ или ушёл) — убирает из окошка только его
 * (последний — окошко закрывается); размонтирован (вышли из голоса) — закрывает окошко.
 */
export function StreamPipHost() {
  const pips = useStore((s) => s.pipStreams);
  const win = useStreamPipWindow();
  // onlySubscribed:false — как на сцене: показ, от которого отписалась карточка-снимок, не должен «исчезать».
  const screens = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }], {
    onlySubscribed: false,
  }) as TrackReference[];
  const liveKey = screens.map((s) => s.participant.identity).join(',');
  const pipKey = pips.join(',');
  useEffect(() => {
    const live = liveKey ? liveKey.split(',') : [];
    for (const id of pipGone(pipKey ? pipKey.split(',') : [], live)) removeFromStreamPip(id);
  }, [pipKey, liveKey]);
  // Окно открыто, а показов в нём не осталось (стор очищен) — окно не висит пустым.
  useEffect(() => {
    if (win && !pipKey) closeStreamPip();
  }, [win, pipKey]);
  useEffect(() => () => closeStreamPip(), []);
  const tracks = pips
    .map((id) => screens.find((s) => s.participant.identity === id))
    .filter((t): t is TrackReference => !!t);
  if (!win || tracks.length === 0) return null;
  return createPortal(<StreamPipView tracks={tracks} win={win} />, win.document.body);
}

/** Размер окна окошка — раскладка зависит от того, где у него длинная сторона. */
function useWindowSize(win: Window): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: win.innerWidth, h: win.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: win.innerWidth, h: win.innerHeight });
    on();
    win.addEventListener('resize', on);
    return () => win.removeEventListener('resize', on);
  }, [win]);
  return size;
}

/**
 * Окошко показов (#222, вариант Б; несколько показов — #223). Раскладка — `pipLayout`: один во всё окно, два —
 * рядом по длинной стороне, три-четыре — сеткой 2×2; клик по плитке — она крупно, остальные полосой (как «Фокус»
 * на сцене), повторный клик — обратно сеткой. У плитки по наведению — свой ряд (`StreamPipTile`). На уровне окна
 * (справа сверху, как у окошка Telegram Desktop `media_view_pip.cpp`) — «Вернуться в приложение» (все показы
 * окошка — на сцену; двойной клик — то же, `OverState::Enlarge`) и «Закрыть окошко».
 */
function StreamPipView({ tracks, win }: { tracks: TrackReference[]; win: Window }) {
  const nameOf = useNameResolver();
  const { w, h } = useWindowSize(win);
  const [focusId, setFocusId] = useState<string | null>(null);
  const ids = tracks.map((t) => t.participant.identity);
  const focusIndex = tracks.length > 1 && focusId ? ids.indexOf(focusId) : -1;
  const cells = pipLayout(tracks.length, focusIndex, w, h);
  const names = tracks.map((t) => nameOf(ownerOf(t.participant.identity), t.participant.name || t.participant.identity));
  const title = names.join(', ');

  useEffect(() => {
    win.document.title = `${title} — показ`;
  }, [win, title]);

  // «Вернуться в приложение» (и двойной клик): все показы окошка — на сцену своего голосового канала, главное окно — вперёд.
  const back = () => {
    const st = useStore.getState();
    for (const id of st.pipStreams) st.watchStream(id);
    closeStreamPip();
    showVoiceStage();
    focusMainWindow();
  };

  return (
    <div className="stream-pip" onDoubleClick={back}>
      {tracks.map((t, i) => {
        const cell = cells[i];
        if (!cell) return null;
        const id = t.participant.identity;
        return (
          <StreamPipTile
            key={id}
            track={t}
            name={names[i]}
            cell={cell}
            many={tracks.length > 1}
            onFocus={() => {
              if (tracks.length < 2) return;
              setFocusId((cur) => (cur === id ? null : id));
            }}
          />
        );
      })}
      <div className="stream-pip-top" onDoubleClick={(e) => e.stopPropagation()}>
        <button type="button" className="ctl" title="Вернуться в приложение" onClick={back}>
          <Icon name="maximize" size={18} />
        </button>
        <button type="button" className="ctl" title="Закрыть окошко" onClick={closeStreamPip}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}

/** Доля окна → проценты для `style`. */
const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;

/**
 * Плитка показа в окошке: кадр и ряд `.screen-controls` по наведению — ник, громкость (тот же стор и предел,
 * что на сцене), качество (`PipQualityMenu`, тот же общий выбор, что ⚙ на сцене) и «Убрать из окошка», когда
 * показов больше одного (с одним — это «Закрыть окошко»). Клик по кадру — крупно/обратно (`onFocus`).
 */
function StreamPipTile({
  track,
  name,
  cell,
  many,
  onFocus,
}: {
  track: TrackReference;
  name: string;
  cell: PipCell;
  many: boolean;
  onFocus: () => void;
}) {
  const id = track.participant.identity;
  const muted = useStore((s) => s.mutedStreams.includes(id));
  const volume = useStore((s) => s.streamVolumes[id] ?? 1);
  const toggleMute = useStore((s) => s.toggleStreamMute);
  const setVolume = useStore((s) => s.setStreamVolume);
  const audios = useTracks([{ source: Track.Source.ScreenShareAudio, withPlaceholder: false }]);
  const hasAudio = audios.some((a) => a.participant.identity === id || a.participant.identity === ownerOf(id));
  const volPop = useStreamVolumePop();
  const qualityPref = useStreamQuality();
  const [qualityAt, setQualityAt] = useState<HTMLElement | null>(null);

  // Держим подписку на кадр сами: сцены может не быть (ушли в текстовый канал), а карточка-снимок
  // отписывается. Слой выбирает `VoiceConnection` (`wantedLayer`, `inPip`).
  const pub = track.publication as RemoteTrackPublication | undefined;
  const sid = pub?.trackSid;
  useEffect(() => {
    try {
      pub?.setSubscribed?.(true);
    } catch {
      /* подписка — best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const style = { left: pct(cell.x), top: pct(cell.y), width: pct(cell.w), height: pct(cell.h) };
  const stop = (e: ReactMouseEvent) => e.stopPropagation();
  return (
    <div
      className={`screen-viewer stream-pip-tile${volPop.open || qualityAt ? ' ctl-on' : ''}`}
      style={style}
      data-pip-id={id}
      onClick={onFocus}
    >
      <VideoTrack trackRef={track} className="screen-video" />
      <div className="screen-controls" onClick={stop} onDoubleClick={stop}>
        <span className="screen-title">
          <Icon name="screen-share" size={16} /> <span className="screen-title-text">{name}</span>
        </span>
        <span className="screen-spacer" />
        {hasAudio && (
          <StreamVolumeControl
            pop={volPop}
            muted={muted}
            volume={volume}
            onToggleAudio={() => toggleMute(id)}
            onVolume={(v) => setVolume(id, v)}
          />
        )}
        <button
          type="button"
          className="ctl"
          title={`Качество показа: ${STREAM_QUALITY_LABEL[qualityPref]}`}
          aria-haspopup="menu"
          aria-expanded={!!qualityAt}
          onClick={(e) => {
            const btn = e.currentTarget;
            setQualityAt((cur) => (cur ? null : btn));
          }}
        >
          <Icon name="settings" size={18} />
        </button>
        {many && (
          <button type="button" className="ctl" title="Убрать из окошка" onClick={() => removeFromStreamPip(id)}>
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      {qualityAt && <PipQualityMenu pub={pub} at={qualityAt} onClose={() => setQualityAt(null)} />}
    </div>
  );
}

/** Отступ меню от краёв окошка и от кнопки, px. */
const MENU_PAD = 8;

/**
 * Меню качества внутри окошка (#223): те же пункты и тот же общий выбор, что у ⚙ на сцене (`streamQualityMenu`,
 * `setStreamQuality` → `VoiceConnection` пересчитывает `wantedLayer` и для показов окошка). Своё, а не `ContextMenu`:
 * тот слушает и меряет главное окно, а это — документ окошка (`ownerDocument` меню). Ставится над кнопкой
 * (окошко низкое — под ней), прижато к краям; щелчок мимо и Escape закрывают. Строка «Сейчас приходит» — из
 * статистики приёма, как на сцене: единственное доказательство, что выбор сработал.
 */
function PipQualityMenu({
  pub,
  at,
  onClose,
}: {
  pub: RemoteTrackPublication | undefined;
  /** Кнопка ⚙: от неё место меню; щелчок по ней — не «мимо» (она сама открывает и закрывает). */
  at: HTMLElement;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pref = useStreamQuality();
  const { checked, choices, items } = streamQualityMenu(pref, pub);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    const vw = view.innerWidth;
    const vh = view.innerHeight;
    const a = at.getBoundingClientRect();
    const left = Math.max(MENU_PAD, Math.min(a.right - mw, vw - mw - MENU_PAD));
    let top = a.top - mh - MENU_PAD;
    if (top < MENU_PAD) top = Math.min(a.bottom + MENU_PAD, vh - mh - MENU_PAD);
    setPlace({ left, top: Math.max(MENU_PAD, top) });
  }, [at, items.length, receiving]);

  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!doc) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !at.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    doc.addEventListener('pointerdown', down, true);
    doc.addEventListener('keydown', key, true);
    return () => {
      doc.removeEventListener('pointerdown', down, true);
      doc.removeEventListener('keydown', key, true);
    };
  }, [onClose, at]);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const st = await (pub?.videoTrack as RemoteVideoTrack | undefined)?.getReceiverStats();
        if (alive) setReceiving(resolutionText(st?.frameWidth, st?.frameHeight));
      } catch {
        /* статистики нет — подписи не будет */
      }
    };
    void read();
    const t = window.setInterval(() => void read(), 1500);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [pub]);

  return (
    <div
      ref={ref}
      className="ctx-menu stream-pip-menu"
      role="menu"
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <MenuSection>Качество показа</MenuSection>
      {items.map(({ pref: q, sub }) => (
        <MenuItem
          key={q}
          icon={q === checked ? 'check' : undefined}
          label={STREAM_QUALITY_LABEL[q]}
          sub={sub}
          active={q === checked}
          onClick={() => {
            setStreamQuality(q);
            onClose();
          }}
        />
      ))}
      {choices.length === 0 && <MenuSection>Показывающий шлёт один слой — понизить нельзя</MenuSection>}
      {receiving && <MenuSection>Сейчас приходит {receiving}</MenuSection>}
    </div>
  );
}
