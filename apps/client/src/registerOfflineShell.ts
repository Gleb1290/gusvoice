import { isTauri } from './hotkeys';

export function registerOfflineShell(): void {
  if (!import.meta.env.PROD || isTauri() || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
    // Обычный запуск работает и при отключённых service workers или недоступном хранилище.
  });
}
