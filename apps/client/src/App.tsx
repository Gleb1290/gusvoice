import type { AuthResponse, SetupStatus } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import {
  activeInstance,
  activeInstanceId,
  instances,
  needsServerPick,
  noteActiveSuperAdmin,
  serverHost,
  updateActiveInstance,
} from './config';
import { lastPlace } from './lastPlace';
import { setLoginNotice } from './loginNotice';
import { switchInstance } from './instanceSwitch';
import { takePendingOpen } from './pendingOpen';
import { isMobile, isTauri } from './hotkeys';
import { onDeepLink } from './desktopWindow';
import { captureInviteFromUrl, clearPendingInvite, pendingInvite, rememberInvite } from './pendingInvite';
import { inviteCodeFromPath } from './inviteLinkRules';
import { offerInviteLink } from './deepLinkInvite';
import { InviteLanding } from './components/InviteLanding';
import { EditContextMenu } from './components/EditContextMenu';
import { Login } from './components/Login';
import { InstanceUnreachable } from './components/InstanceUnreachable';
import { ConfirmHost } from './components/ConfirmHost';
import { ServerPicker } from './components/ServerPicker';
import { SetupAdminWizard, SetupConfigureWizard } from './components/SetupWizard';
import { MainLayout } from './components/MainLayout';
import { syncBgGateways } from './bgGateways';
import { connectGateway, connectPresence } from './sockets';
import { consumeDeepLink, startPushRegistration } from './nativeUnifiedPush';
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
  const loadBlocks = useStore((s) => s.loadBlocks);
  const restoreVoiceSession = useStore((s) => s.restoreVoiceSession);
  /** Поколение активного инстанса (§5.7): растёт на мягком переходе, см. `instanceSwitch.ts`. */
  const instanceEpoch = useStore((s) => s.instanceEpoch);
  /** Идёт переход между инстансами — держим экран загрузки, чтобы не мелькнула форма входа. */
  const switching = useStore((s) => s.switching);
  const [loading, setLoading] = useState(true);
  /** Активный инстанс не отвечает: сессия цела, но говорить с ним не о чем, пока он не поднимется. */
  const [unreachable, setUnreachable] = useState(false);
  // Мастер первичной настройки (#142). null — не узнали (старый сервер без ручки, сеть) = как раньше.
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  // «У меня аккаунт здесь» на странице перехода: убирает её и оставляет обычный экран входа.
  const [, setLandingDismissed] = useState(false);

  // Load the current user. Only a genuine 401 (invalid/expired token) logs out; a transient network
  // or 5xx error (e.g. backend mid-deploy) must NOT nuke the session — we retry a few times and,
  // failing that, keep the token so a later reload recovers. (Prior bug: ANY error here → setToken(null)
  // → mass logout whenever the backend blipped, which a burst of deploys made painfully common.)
  async function loadMe(): Promise<'ok' | 'unauthorized' | 'unreachable'> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const me = await api.me();
        setAuth(me);
        // Снимок для кнопки админки, пока человек будет гостем у соседа (`adminTarget`, 23.09).
        noteActiveSuperAdmin(!!me.superAdmin);
        return 'ok';
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          setToken(null);
          /**
           * 🔴 Гостевая сессия протухла — человека НЕЛЬЗЯ оставлять на экране входа чужого
           * инстанса: пароля у него там нет и быть не может, за него ручается дом. Возвращаем
           * домой; токен мы только что стёрли, поэтому следующий клик по серверу соседа заведёт
           * сессию заново сам (`ensureGuestSession`). Без этого выход был только один — стереть
           * данные сайта.
           */
          const cur = activeInstance();
          const home = instances().find((i) => i.id === cur?.guestOf);
          if (cur?.guestOf && home) {
            const there = cur.name?.trim() || cur.domain || 'соседа';
            const here = home.name?.trim() || serverHost(home.apiUrl);
            /**
             * ⚠️ ДВА канала, и они не дублируют друг друга, а покрывают два разных исхода: дома
             * человек залогинен — увидит тост; дома тоже не залогинен — увидит объяснение на
             * экране входа, где тостов нет вовсе (`ToastHost` живёт в `MainLayout`).
             * Без второго канала перенос был молчаливым: человек вводил пароль от соседа у себя
             * дома и получал «неверный пароль» (авария 18.09).
             */
            toast('info', `Сессия на «${there}» истекла`, `Вернули на «${here}» — нажмите сервер соседа, чтобы войти заново`);
            setLoginNotice(`Сессия на «${there}» истекла, поэтому вы снова на «${here}». Это вход в «${here}».`);
            void switchInstance(cur.guestOf);
          }
          return 'unauthorized';
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    /**
     * 🔴 Три попытки не достучались — это НЕ «разлогинило». Токен цел и остаётся; показывать после
     * этого форму входа значит врать человеку о том, что с ним произошло, и звать вводить пароль в
     * инстанс, который всё равно не ответит (сценарий 7 на стенде 18.09).
     */
    return 'unreachable';
  }

  /**
   * 🔴 **Гостевая запись без токена — тупик, и человека надо увести домой.**
   *
   * У гостя на чужом инстансе пароля нет и быть не может: за него ручается дом. Но экран входа
   * ничем не отличается от обычного, и человек послушно вводит туда свой пароль — от СВОЕГО
   * инстанса. Чужой отвечает «неверный пароль», и выглядит это как «меня не пускает с верным
   * паролем». Ровно на это налетели на стенде 18.09: выход из аккаунта, стоя гостем, оставлял
   * человека на экране входа соседа.
   *
   * ⚠️ Покрывает ЛЮБОЙ способ остаться без токена: свой выход, «завершить сессию», протухание,
   * очистку хранилища. Ветка 401 в `loadMe` — про другой случай (токен есть, но хост его не
   * принял) и остаётся отдельно.
   */
  function bounceStrandedGuestHome(): boolean {
    if (getToken()) return false;
    const cur = activeInstance();
    const home = instances().find((i) => i.id === cur?.guestOf);
    if (!cur?.guestOf || !home) return false;
    const there = cur.name?.trim() || cur.domain || 'соседа';
    const here = home.name?.trim() || serverHost(home.apiUrl);
    setLoginNotice(`На «${there}» вы были гостем — паролем туда не войти, туда пускает ваш инстанс. Вернули на «${here}».`);
    void switchInstance(home.id);
    return true;
  }

  async function bootstrap() {
    await loadServers();
    // Load push-mute rules so context-menu toggles reflect state (best-effort, non-blocking).
    void loadPushMutes();
    // Чёрный список ЛС (#212): кнопка в беседе и раздел настроек показывают, кого я заблокировал.
    void loadBlocks();
    connectGateway();
    connectPresence();
    // Шлюзы ОСТАЛЬНЫХ записей реестра (§5.7): непрочитанное и упоминания с инстансов, куда человек
    // сейчас не смотрит. Активную запись `syncBgGateways` не трогает — её ведут строки выше.
    syncBgGateways(activeInstanceId());
    // Соседние вкладки: прочитанное в одной гаснет во всех (`tabSync.ts`).
    useStore.getState().listenTabs();
    /**
     * Android: зарегистрировать устройство в пушах ЭТОГО инстанса. Вызов идемпотентный и вне
     * Android не делает ничего.
     *
     * ⚠️ Появилось вместе с мягким переходом (§5.7): переход снимает регистрацию у покинутого
     * инстанса, а поднять её у нового было некому — вход-то уже есть, экран входа не показывается.
     * Само бы починилось только при следующем сворачивании-разворачивании приложения.
     */
    startPushRegistration();
    // Reconnect-grace restore (#11): if we dropped from a voice channel within the grace window
    // (crash / quick restart), rejoin it now — mute/deafen come back from the persisted self state.
    void restoreVoiceSession();
    // Android push deep-link (#118): a cold start from a notification tap has a pending target — jump to it.
    consumeDeepLink();
    /**
     * Открылись по ссылке-приглашению (§4.2.2): адресом `/i/<код>` в вебе или схемой `gusvoice://`
     * на десктопе и Android. Окно проверки поднимет рейл, как только увидит намерение.
     *
     * ⚠️ Адрес чистим сразу: оставленный `/i/<код>` открывал бы окно при каждой перезагрузке — в том
     * числе через неделю, когда человек давно вступил.
     */
    const fromPath = inviteCodeFromPath(window.location.pathname);
    if (fromPath) {
      offerInviteLink(`${window.location.origin}/i/${fromPath}`);
      window.history.replaceState({}, '', '/');
    }
    /**
     * Переключились ради конкретного сервера чужого инстанса (§5.7) — открываем именно его.
     *
     * ⚠️ После `loadServers()`: сервер должен уже быть в списке, иначе рейл откроет его и тут же
     * перерисуется без него. Отказ глотаем молча — членство могли снять, пока приложение
     * перезапускалось, и вываливать это ошибкой на старте не за что.
     */
    const pending = takePendingOpen(activeInstanceId());
    if (pending?.serverId) {
      await useStore
        .getState()
        .openServer(pending.serverId)
        .catch(() => {});
      // Тап по пушу ведёт в КАНАЛ, а не просто на сервер: человек шёл читать то, о чём его позвали.
      if (pending.channelId) {
        await useStore
          .getState()
          .openChannel(pending.channelId)
          .catch(() => {});
      }
    }
    await joinPendingInvite();
    /**
     * Последним делом — вернуть человека туда, где он был до перезагрузки (`lastPlace.ts`).
     *
     * ⚠️ Именно ПОСЛЕДНИМ и только если никуда не пришли раньше: ссылка-приглашение, переход между
     * инстансами и тап по пушу — это осознанное намерение «открой вот это», и перебивать его
     * прошлым местом было бы грубо.
     *
     * ⚠️ Запись из хранилища — подсказка, а не приказ: сервер могли закрыть, канал удалить, права
     * отобрать. Поэтому `openServer`/`openChannel` зовутся с глушением отказа, а на телефоне канал
     * не открываем вовсе — там переход на сервер обязан показать СПИСОК каналов, а не вывалить
     * человека сразу в стену переписки (то же правило, что в `openServer`).
     */
    const st = useStore.getState();
    if (!st.currentServerId && !st.currentDmId) {
      const place = lastPlace(activeInstanceId());
      if (place?.dmId) {
        await useStore.getState().selectDm(place.dmId).catch(() => {});
      } else if (place?.serverId) {
        await useStore.getState().openServer(place.serverId).catch(() => {});
        if (place.channelId && !isMobile() && useStore.getState().currentServerId === place.serverId) {
          await useStore.getState().openChannel(place.channelId).catch(() => {});
        }
      }
    }
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
    // Ссылка-приглашение с рабочего стола (§4.2.2): клик в мессенджере → схема `gusvoice://` →
    // сюда. Окно проверки поднимет рейл; входить по ссылке само приложение не станет никогда.
    onDeepLink((url) => offerInviteLink(url));
    // До всего остального: код из ссылки-приглашения убирается из адреса и ждёт входа (#142).
    captureInviteFromUrl();
    /**
     * Полная ЧУЖАЯ ссылка в `?invite=` — так к нам приходят со страницы перехода соседа (§4.2.2:
     * «у вас аккаунт на другом инстансе?»). От `captureInviteFromUrl` отличается тем, что там код
     * СВОЕГО инстанса, а тут адрес чужого: вступать по нему нельзя, можно только показать окно
     * проверки — оно и решит, что это за сервер и пустят ли туда.
     */
    const queryInvite = new URLSearchParams(window.location.search).get('invite');
    if (queryInvite && offerInviteLink(queryInvite)) {
      window.history.replaceState({}, '', window.location.pathname.replace(/^\/join\/?$/, '/'));
    }
    (async () => {
      // Статус мастера спрашиваем параллельно с профилем. Ошибка (старый бэкенд без ручки) = мастера нет.
      const status = api.setupStatus().catch(() => null);
      // Auth check and bootstrap are SEPARATE: a bootstrap failure (loadServers etc. during a backend
      // blip) must never log the user out — only loadMe() may, and only on a real 401.
      // ⚠️ Раньше проверки: экран входа гостевой записи показывать нельзя вовсе.
      if (bounceStrandedGuestHome()) {
        setSetup(await status);
        return; // дальше поведёт эффект на `instanceEpoch` — уже на домашней записи
      }
      if (getToken()) {
        const state = await loadMe();
        setUnreachable(state === 'unreachable');
        if (state === 'ok') {
          try {
            await bootstrap();
          } catch {
            /* transient — session stays; a reload re-runs bootstrap */
          }
        }
      }
      setSetup(await status);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Перешли в другой инстанс без перезапуска (§5.7) — проходим вход заново.
   *
   * 🔴 Тот же самый путь, что и на старте (`loadMe` → `bootstrap`), намеренно: две разные дороги в
   * загруженное состояние разъезжаются на первой же добавленной строчке, и разъехались бы молча —
   * переход между инстансами бывает у считаных людей.
   *
   * ⚠️ Нулевое поколение пропускаем: это обычный старт, его ведёт эффект монтирования ниже.
   * ⚠️ `setLoading(true)` на время перехода — иначе человек секунду смотрит на пустой рейл
   * прежнего инстанса и думает, что его выкинуло.
   */
  useEffect(() => {
    if (instanceEpoch === 0) return;
    let alive = true;
    setLoading(true);
    (async () => {
      if (!bounceStrandedGuestHome() && getToken()) {
        const state = await loadMe();
        if (alive) setUnreachable(state === 'unreachable');
        if (state === 'ok') {
          try {
            await bootstrap();
          } catch {
            /* сеть моргнула — сессия остаётся, перезагрузка добьёт */
          }
        }
      }
      if (alive) {
        setLoading(false);
        useStore.setState({ switching: false });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceEpoch]);

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
  /**
   * Пришли по ссылке `/i/<код>` (§4.2.2). Пока человек не вошёл, показываем страницу перехода: она
   * пробует отдать ссылку приложению и предлагает запасные пути. Вошедшему она не нужна — ему
   * открывается обычное окно проверки поверх приложения (ссылку уже приняли в `bootstrap`).
   */
  const landingCode = user ? null : inviteCodeFromPath(window.location.pathname);
  const content = landingCode && !needsServerPick() && !loading ? (
    <InviteLanding
      code={landingCode}
      onHere={() => {
        // «У меня аккаунт здесь» — запоминаем код и уходим на обычный вход; после него `bootstrap`
        // вступит по нему сам (тот же путь, что у ссылки `?invite=` из мастера).
        rememberInvite(landingCode);
        window.history.replaceState({}, '', '/');
        setLandingDismissed(true);
      }}
    />
  ) : needsServerPick() ? (
    <ServerPicker />
  ) : loading || switching ? (
    <div className="center muted">Loading…</div>
  ) : unreachable ? (
    /* Сессия цела, отвечать некому. Форма входа здесь была бы неправдой — см. `InstanceUnreachable`. */
    <InstanceUnreachable
      onRetry={() => {
        setUnreachable(false);
        setLoading(true);
        void (async () => {
          const state = await loadMe();
          setUnreachable(state === 'unreachable');
          if (state === 'ok') {
            try {
              await bootstrap();
            } catch {
              /* та же логика, что и на старте: сбой загрузки сессию не рушит */
            }
          }
          setLoading(false);
        })();
      }}
    />
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
      {/* 🔴 Окно подтверждения — ЗДЕСЬ, а не в `MainLayout`: подтверждать приходится и до того, как
          главный экран собран (выбор инстанса, мастер, «инстанс не отвечает»). Ошибку `ToastHost`,
          который в такие минуты не виден, не повторяем. */}
      <ConfirmHost />
    </>
  );
}
