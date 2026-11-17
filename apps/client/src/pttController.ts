export type PttSource = string | symbol;

/** Independent holds share one mic; asynchronous capture must finish before a queued close. */
export function createPttController(options: {
  canOpen(): boolean;
  apply(open: boolean): Promise<unknown>;
  releaseMs(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  onError(error: unknown): void;
}) {
  const held = new Set<PttSource>();
  let timer: unknown = null;
  let tailOwner: PttSource | null = null;
  let pending: boolean | null = null;
  let running = false;
  let disposed = false;
  let owned = false;
  const clearTail = () => {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
    tailOwner = null;
  };
  const request = (open: boolean) => {
    pending = open;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (pending !== null) {
          const next = pending && !disposed && options.canOpen();
          pending = null;
          try {
            await options.apply(next);
            if (!next && pending !== true && !held.size) owned = false;
          } catch (error) {
            if (next) {
              held.clear();
              clearTail();
              pending = false;
            }
            options.onError(error);
          }
        }
      } finally {
        running = false;
      }
    })();
  };
  const reset = () => {
    held.clear();
    clearTail();
    if (owned) request(false);
  };
  return {
    press(source: PttSource) {
      if (disposed || held.has(source) || !options.canOpen()) return;
      held.add(source);
      owned = true;
      clearTail();
      request(true);
    },
    release(source: PttSource, immediate = false) {
      const wasHeld = held.delete(source);
      if (!wasHeld && !(immediate && tailOwner === source)) return;
      if (held.size) return;
      clearTail();
      const delay = Math.max(0, options.releaseMs());
      if (immediate || !delay) request(false);
      else {
        tailOwner = source;
        timer = options.setTimer(() => {
          timer = null;
          tailOwner = null;
          request(false);
        }, delay);
      }
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}

/** Silence is still transmission: only mic/permission state matters, never a loudness meter. */
export function pttFeedbackOpen(state: {
  ptt: boolean; connected: boolean; muted: boolean; deafened: boolean;
  canPublish: boolean; micEnabled: boolean; trackLive: boolean;
}): boolean {
  return state.ptt && state.connected && !state.muted && !state.deafened &&
    state.canPublish && state.micEnabled && state.trackLive;
}

/** Re-evaluate intent after an asynchronous PTT capture, including a switch back to open mic. */
export function pttMicTarget(requested: boolean, state: {
  disposed: boolean; ptt: boolean; connected: boolean;
  muted: boolean; deafened: boolean; canPublish: boolean;
}): boolean {
  return !state.disposed && state.connected && !state.muted && !state.deafened &&
    state.canPublish && (state.ptt ? requested : true);
}

/** A blocked PTT gesture may only unmute; releasing a transmitting hold never toggles mute. */
export function pttButtonShouldToggle(state: {
  active: boolean; blocked: boolean; unmuteGesture: boolean; suppressClick: boolean;
}): boolean {
  return state.active ? state.blocked && state.unmuteGesture : !state.suppressClick;
}
