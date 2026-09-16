import type { AuthResponse, SetupStatus } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import { needsServerPick, updateActiveInstance } from './config';
import { isTauri } from './hotkeys';
import { captureInviteFromUrl, clearPendingInvite, pendingInvite } from './pendingInvite';
import { EditContextMenu } from './components/EditContextMenu';
import { Login } from './components/Login';
import { ServerPicker } from './components/ServerPicker';
import { SetupAdminWizard, SetupConfigureWizard } from './components/SetupWizard';
import { MainLayout } from './components/MainLayout';
import { connectGateway, connectPresence } from './sockets';
import { consumeDeepLink } from './nativeUnifiedPush';
import { useStore } from './store';
import { initVoiceTray } from './voiceTray';
import { initOverlay } from './overlay';
import { initTipToast } from './tipToast';
import { initAfk } from './afk';
import { initDownloads } from './downloads';
import { startDeviceWatch } from './deviceWatch';
import { stopGameActivity, syncGameActivity } from './gameActivity';
import { toast } from './toast';
import { CloseToTrayPrompt } from './components/CloseToTrayPrompt';
import { LastCrashNotice } from './components/LastCrashNotice';
import { UpdatePanel } from './components/UpdatePanel';

export function App() {
  const user = useStore((s) => s.user);
  const setAuth = useStore((s) => s.setAuth);
  const loadServers = useStore((s) => s.loadServers);
  const loadPushMutes = useStore((s) => s.loadPushMutes);
  const restoreVoiceSession = useStore((s) => s.restoreVoiceSession);
  const [loading, setLoading] = useState(true);
  // Мастер первичной настройки (#142). null — не узнали (старый сервер без ручки, сеть) = как раньше.
  const [setup, setSetup] = useState<SetupStatus | null>(null);

  // Load the current user. Only a genuine 401 (invalid/expired token) logs out; a transient network
  // or 5xx error (e.g. backend mid-deploy) must NOT nuke the session — we retry a few times and,
  // failing that, keep the token so a later reload recovers. (Prior bug: ANY error here → setToken(null)
  // → mass logout whenever the backend blipped, which a burst of deploys made painfully common.)
  async function loadMe(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        setAuth(await api.me());
        return true;
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          setToken(null);
          return false;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return false; // still unreachable after retries — token kept, a reload will recover
  }

  async function bootstrap() {
    await loadServers();
    // Load push-mute rules so context-menu toggles reflect state (best-effort, non-blocking).
    void loadPushMutes();
    connectGateway();
    connectPresence();
    // Reconnect-grace restore (#11): if we dropped from a voice channel within the grace window
    // (crash / quick restart), rejoin it now — mute/deafen come back from the persisted self state.
    void restoreVoiceSession();
    // Android push deep-link (#118): a cold start from a notification tap has a pending target — jump to it.
    consumeDeepLink();
    await joinPendingInvite();
  }

  /**
   * Пришли по ссылке `?invite=КОД` (#142) — после входа сразу вступаем на сервер. Код забываем, когда
   * вступили или когда он точно мёртв (нет, истёк, бан); сетевой сбой — оставляем до следующего запуска.
   */
  async function joinPendingInvite() {
    const code = pendingInvite();
    if (!code) return;
    try {
      const boot = await api.acceptInvite(code);
      clearPendingInvite();
      await loadServers();
      toast('success', `Вы на сервере «${boot.server.name}»`);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 410 || status === 403) {
        clearPendingInvite();
        toast('error', 'Приглашение не сработало', (e as Error).message);
      }
    }
  }

  /** Мастер создал супер-админа — входим так же, как после обычного входа. */
  async function adminCreated(res: AuthResponse) {
    setToken(res.token);
    setAuth(res.user);
    updateActiveInstance({ userId: res.user.id, displayName: res.user.displayName, lastLogin: res.user.username });
    setSetup((cur) => ({ needsSetup: false, tokenConfigured: cur?.tokenConfigured ?? true, wizardPending: true }));
    try {
      await bootstrap();
    } catch {
      /* как и при обычном входе: сбой загрузки сессию не рушит */
    }
  }

  useEffect(() => {
    // Desktop tray mirror (mute/deafen/speaking bubble) — self-gates to Tauri builds, no-op on web.
    initVoiceTray();
    // Desktop in-game overlay controller — pushes the voice roster to the overlay window; no-op on web.
    initOverlay();
    // Контроллер всплывающей плашки «кто кого типнул» — второе оверлейное окно; в вебе выходит сразу.
    initTipToast();
    // Desktop download toasts — WebView2 saves chat attachments silently; no-op on web.
    initDownloads();
    initAfk();
    // До всего остального: код из ссылки-приглашения убирается из адреса и ждёт входа (#142).
    captureInviteFromUrl();
    (async () => {
      // Статус мастера спрашиваем параллельно с профилем. Ошибка (старый бэкенд без ручки) = мастера нет.
      const status = api.setupStatus().catch(() => null);
      // Auth check and bootstrap are SEPARATE: a bootstrap failure (loadServers etc. during a backend
      // blip) must never log the user out — only loadMe() may, and only on a real 401.
      if (getToken() && (await loadMe())) {
        try {
          await bootstrap();
        } catch {
          /* transient — session stays; a reload re-runs bootstrap */
        }
      }
      setSetup(await status);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop game-activity reporter (#40): run while authed (re-syncs when the user toggles the switch,
  // since `user` changes), stop on logout. Self-gates to desktop, so it's a no-op on web/mobile.
  useEffect(() => {
    if (user) syncGameActivity();
    else stopGameActivity();
  }, [user]);

  // Выдернули микрофон или наушники — переходим на то, что осталось (#131). Слежение живёт ЗДЕСЬ, а
  // не в голосовом соединении: устройство выдёргивают и когда в канале не сидят, и тогда в
  // настройках просто остаётся ссылка на то, чего больше нет.
  useEffect(() => startDeviceWatch(), []);

  // Steam OpenID link (#40 Phase 1B) bounces back to `/?steam=linked|error` — toast the result,
  // refresh our profile (so steamLinked/persona show), and strip the query param.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const s = sp.get('steam');
    if (!s) return;
    sp.delete('steam');
    window.history.replaceState({}, '', window.location.pathname + (sp.toString() ? `?${sp}` : ''));
    if (s === 'linked') {
      toast('success', 'Steam привязан');
      void api.me().then(setAuth).catch(() => {});
    } else {
      toast('error', 'Не удалось привязать Steam');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generic desktop/mobile build with no server chosen yet → ask which server to connect to first.
  // (Stable per mount: only a reload — after the picker saves — changes it. Web is never in this mode.)
  // Мастер установки — только в вебе: у десктопа и Android нет своего инстанса, они подключаются к чужому.
  const web = !isTauri();
  const content = needsServerPick() ? (
    <ServerPicker />
  ) : loading ? (
    <div className="center muted">Loading…</div>
  ) : !user ? (
    setup?.needsSetup && web ? (
      <SetupAdminWizard tokenConfigured={setup.tokenConfigured} onAdminCreated={adminCreated} />
    ) : (
      <Login onAuthed={bootstrap} setupPending={!!setup?.needsSetup} />
    )
  ) : user.superAdmin && setup?.wizardPending && web ? (
    <SetupConfigureWizard
      onFinished={async () => {
        setSetup((cur) => (cur ? { ...cur, wizardPending: false } : cur));
        await loadServers();
      }}
    />
  ) : (
    <MainLayout />
  );

  return (
    <>
      {content}
      {/* Desktop auto-update panel — renders only while an update is downloading/installing/ready. */}
      <UpdatePanel />
      {/* Desktop close-to-tray: handles the window X (свернуть в трей / выйти / спросить). */}
      <CloseToTrayPrompt />
      {/* Отчёт о прошлой аварии — полоска с кнопкой скопировать. Сама решает, показываться ли. */}
      <LastCrashNotice />
      {/* Своё меню правки в полях ввода вместо родного браузерного (#75). */}
      <EditContextMenu />
    </>
  );
}
