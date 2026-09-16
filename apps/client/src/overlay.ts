/**
 * Main-window controller for the in-game voice overlay (desktop only).
 *
 * The main window owns the single LiveKit connection and all voice state; this module derives the
 * current channel's roster (+ the same local-VAD speaking signal that lights the avatar ring / tray)
 * and pushes it to the separate overlay window via the Rust `gv_overlay_*` commands. The overlay
 * window itself just renders the payload (see VoiceOverlay.tsx). No-op on web (no Tauri core).
 *
 * Visibility modes (overlaySettings.mode):
 *   • 'desktop' — always on top of everything (while show conditions hold)
 *   • 'apps'    — only while a foreground app whose exe is in `apps` is focused (Rust foreground watcher
 *                 emits `gv-foreground-app`; see start_foreground_watch in lib.rs)
 */
import { useStore } from './store';
import { animatedAvatarsEnabled } from './avatarAnimation';
import { nameFromRoster } from './memberNameRules';
import { overlayHints, type OverlayHint } from './overlayHints';
import { getOverlaySettings, onOverlaySettings, setOverlaySettings } from './overlaySettings';

export interface OverlayParticipant {
  id: string;
  name: string;
  avatarUrl: string | null;
  /**
   * Ссылка на АНИМИРОВАННЫЙ аватар — оверлей снимет с неё первый кадр сам (`firstFrame.ts`).
   * 🔴 Едет ссылка, а не картинка: снимок пушится десяток раз в секунду, пока люди говорят, и
   * `data:`-кадр на несколько десятков килобайт гонялся бы по проводу каждый раз.
   * ⚠️ `null`, когда зритель выключил анимацию: выключатель бережёт ТРАФИК, а не только глаза, и
   * качать гифку ради кадра ему не надо.
   */
  animatedAvatarUrl: string | null;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
}
export interface OverlayPayload {
  content: 'list' | 'compact';
  opacity: number;
  participants: OverlayParticipant[];
  /**
   * «Кто кого типнул» — по одной свежей подсказке на человека (правила в `overlayHints.ts`).
   * 🔴 Имена разрешаются ЗДЕСЬ, в главном окне: ростер сервера есть только у него, а окно оверлея
   * получает готовый снимок и своего состояния не держит вовсе.
   */
  hints: OverlayHint[];
  /** True while the user is dragging the overlay to reposition it — render a draggable placeholder. */
  positioning?: boolean;
}
export interface AppInfo {
  exe: string;
  name: string;
  icon: string | null;
}

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
function tauriCore(): TauriCore | null {
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}
type TauriEvent = {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
};
function tauriEvent(): TauriEvent | null {
  return (window as unknown as { __TAURI__?: { event?: TauriEvent } }).__TAURI__?.event ?? null;
}

function derive(): { inVoice: boolean; participants: OverlayParticipant[]; hints: OverlayHint[] } {
  const s = useStore.getState();
  const chId = s.voice?.channelId ?? null;
  const roster = chId ? (s.presence[chId] ?? []) : [];
  // Анимации в ростере голоса нет — она живёт в ростере СЕРВЕРА, как и ники.
  const anim = new Map(s.members.map((m) => [m.user.id, m.user.animatedAvatarUrl ?? null]));
  const animOn = animatedAvatarsEnabled();
  const participants: OverlayParticipant[] = roster.map((p) => {
    const live = s.liveVoice[p.userId];
    const isMe = p.userId === s.user?.id;
    return {
      id: p.userId,
      name: p.displayName,
      avatarUrl: p.avatarUrl,
      animatedAvatarUrl: animOn ? (anim.get(p.userId) ?? null) : null,
      speaking: live?.speaking ?? false,
      muted: isMe ? s.selfMuted : live ? live.muted : p.muted,
      deafened: isMe ? s.selfDeafened : live ? live.deafened : p.deafened,
    };
  });
  // Ник этого сервера, а не имя из события (#73). Карту строим ОДИН раз на проход: derive зовётся
  // на каждое изменение стора, а `resolveMemberName` собирал бы её заново под каждую подсказку.
  const nicks = new Map(s.members.map((m) => [m.user.id, m.nickname]));
  const hints = overlayHints(s.tipHints, new Set(participants.map((p) => p.id)), (h) =>
    nameFromRoster(nicks, h.fromUserId, h.fromName),
  );
  return { inVoice: !!chId, participants, hints };
}

let started = false;
let foregroundExe = '';
let repositioning = false;
let reschedule: (() => void) | null = null;

/** Wire the overlay controller once. Bails out on web (no Tauri core). */
export function initOverlay(): void {
  if (started) return;
  const core = tauriCore();
  if (!core) return;
  started = true;

  let shown = false;
  let lastPosKey = '';
  let lastPushKey = '';
  let lastWatch = false;
  let cooldown = false;
  let dirty = false;

  const reconcile = () => {
    const st = getOverlaySettings();
    const { inVoice, participants, hints } = derive();
    // The native foreground watcher runs ONLY for 'apps' mode (opt-in — idle otherwise).
    const watchOn = st.enabled && st.mode === 'apps';
    if (watchOn !== lastWatch) {
      lastWatch = watchOn;
      core.invoke('gv_overlay_watch', { on: watchOn }).catch(() => {});
    }
    const base = st.enabled && (!st.onlyInVoice || inVoice);
    const modeOk = st.mode === 'desktop' ? true : st.apps.map((a) => a.toLowerCase()).includes(foregroundExe);
    const shouldShow = repositioning || (base && modeOk);

    if (shouldShow !== shown) {
      shown = shouldShow;
      core.invoke(shouldShow ? 'gv_overlay_show' : 'gv_overlay_hide').catch(() => {});
      if (shouldShow) {
        lastPosKey = ''; // force position re-apply on (re)show
        // The overlay window is (re)created asynchronously; a push right now can beat its listener.
        // Re-push shortly after so the card actually renders even if the ready-handshake is missed.
        setTimeout(() => {
          lastPushKey = '';
          schedule();
        }, 500);
      }
    }
    if (!shouldShow) return;

    // Position — but never fight an active drag (positioning mode leaves the window where the user drags).
    if (!repositioning) {
      const posKey =
        st.posMode === 'custom'
          ? `c:${st.customX}:${st.customY}`
          : `k:${st.corner}:${st.marginX}:${st.marginY}`;
      if (posKey !== lastPosKey) {
        lastPosKey = posKey;
        if (st.posMode === 'custom') {
          core.invoke('gv_overlay_set_position', { x: st.customX, y: st.customY }).catch(() => {});
        } else {
          core
            .invoke('gv_overlay_set_corner', { corner: st.corner, marginX: st.marginX, marginY: st.marginY })
            .catch(() => {});
        }
      }
    }

    const payload: OverlayPayload = {
      content: st.content,
      opacity: st.opacity,
      participants,
      hints,
      positioning: repositioning,
    };
    const pushKey = JSON.stringify(payload);
    if (pushKey !== lastPushKey) {
      lastPushKey = pushKey;
      core.invoke('gv_overlay_push_state', { payload }).catch(() => {});
    }
  };

  // Coalesce bursts (speaking flips) — instant first, then a short cooldown, same shape as the tray.
  const schedule = () => {
    if (cooldown) {
      dirty = true;
      return;
    }
    reconcile();
    cooldown = true;
    setTimeout(() => {
      cooldown = false;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }, 80);
  };
  reschedule = schedule;

  const ev = tauriEvent();
  void ev?.listen('gv-foreground-app', (e) => {
    foregroundExe = String(e.payload ?? '').toLowerCase();
    schedule();
  });
  // The overlay window announces itself once its listener is live — (re)push current state to it.
  void ev?.listen('gv-overlay-ready', () => {
    lastPushKey = '';
    schedule();
  });
  // «Готово» pressed ON the overlay while repositioning → persist the dragged spot + restore click-through.
  void ev?.listen('gv-overlay-reposition-done', () => {
    void finishOverlayReposition();
  });
  // The overlay resized itself to fit content → re-anchor it to the corner with the new size.
  void ev?.listen('gv-overlay-resized', () => {
    lastPosKey = '';
    schedule();
  });

  useStore.subscribe(schedule);
  onOverlaySettings(schedule);
  schedule();
}

/** Enumerate the user's currently-open apps for the "выбранные приложения" picker. */
export async function listOverlayApps(): Promise<AppInfo[]> {
  const core = tauriCore();
  if (!core) return [];
  try {
    return ((await core.invoke('gv_list_apps')) as AppInfo[]) ?? [];
  } catch {
    return [];
  }
}

/** Enter reposition mode: show the overlay and let the user drag it (a placeholder card is rendered). */
export function startOverlayReposition(): void {
  const core = tauriCore();
  if (!core) return;
  repositioning = true;
  core.invoke('gv_overlay_show').catch(() => {});
  core.invoke('gv_overlay_set_interactive', { interactive: true }).catch(() => {});
  reschedule?.();
}

/**
 * Leave reposition mode: persist the dragged position (posMode='custom') and restore click-through.
 *
 * 🔴 **Идемпотентна намеренно** — та же причина, что у плашки (`tipToast.ts`): её зовёт и закрытие
 * настроек, куда можно прийти, ни разу не включив расстановку.
 */
export async function finishOverlayReposition(): Promise<void> {
  const core = tauriCore();
  if (!core || !repositioning) return;
  const pos = (await core.invoke('gv_overlay_get_position').catch(() => null)) as [number, number] | null;
  if (Array.isArray(pos)) {
    setOverlaySettings({ posMode: 'custom', customX: Math.round(pos[0]), customY: Math.round(pos[1]) });
  }
  repositioning = false;
  core.invoke('gv_overlay_set_interactive', { interactive: false }).catch(() => {});
  reschedule?.();
}
