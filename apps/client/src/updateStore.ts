import { create } from 'zustand';

/**
 * Desktop auto-update progress, surfaced to the UI (UpdatePanel) so the user sees a Discord-style
 * "downloading → installing → restart" flow instead of a silent swap. Driven by updater.ts.
 * No-op on web (the flow never leaves 'idle' there).
 */
export type UpdatePhase =
  | 'idle' // nothing to do (web, or already up to date)
  | 'checking' // querying the update endpoint
  | 'available' // a newer version exists, about to download
  | 'downloading' // streaming the installer (track downloaded/total)
  | 'installing' // running the installer
  | 'ready' // installed; waiting for the user (or us) to relaunch
  | 'error'; // check/download/install failed (non-fatal — app keeps running)

interface UpdateStore {
  phase: UpdatePhase;
  version: string | null; // the new version, e.g. "0.3.4"
  notes: string | null; // release notes (Update.body)
  downloaded: number; // bytes received so far
  total: number; // total bytes (0 = unknown / not started)
  startedAt: number; // Date.now() начала скачивания — полоса доезжает плавно (`UpdatePanel`, 15.10)
  dlDone: boolean; // скачивание закончилось (полоса может ещё доезжать до 100 %)
  viaSplash: boolean; // 16.10: сборка с заставкой — «Обновить» = перезапуск, качает и ставит заставка (`applyPendingUpdate`)
  error: string | null;
  set: (patch: Partial<Omit<UpdateStore, 'set'>>) => void;
}

export const useUpdate = create<UpdateStore>((set) => ({
  phase: 'idle',
  version: null,
  notes: null,
  downloaded: 0,
  total: 0,
  startedAt: 0,
  dlDone: false,
  viaSplash: false,
  error: null,
  set: (patch) => set(patch),
}));
