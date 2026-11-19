import { CAP_CONV1, FEATURE_CONV2, type AuthResponse, type SetupStatus, type User } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api, getToken, setToken } from './api';
import {
  activeInstance,
  activeInstanceId,
  config,
  instances,
  needsServerPick,
  noteActiveSuperAdmin,
  serverHost,
  updateActiveInstance,
} from './config';
import { lastPlace } from './lastPlace';
import { entryAccount, entryFailure, savedEntryTargets, withEntryDeadline } from './entryRules';
import { switchInstance } from './instanceSwitch';
import { takePendingOpen } from './pendingOpen';
import { isMobile, isTauri } from './hotkeys';
import { onDeepLink } from './desktopWindow';
import { captureInviteFromUrl, clearPendingInvite, pendingInvite, rememberInvite } from './pendingInvite';
import { BROKEN_INVITE_HINT, BROKEN_INVITE_TITLE, inviteCodeFromPath, isBrokenInvitePath } from './inviteLinkRules';
import { offerInviteLink } from './deepLinkInvite';
import { noticeFromRefusal } from './accessClosed';
import { InviteLanding } from './components/InviteLanding';
import { EditContextMenu } from './components/EditContextMenu';
import { Login } from './components/Login';
import { EntryChoices, InstanceUnreachable, type EntryProblem } from './components/InstanceUnreachable';
import { ConfirmHost } from './components/ConfirmHost';
import { MuteCustomHost } from './components/MuteCustomHost';
import { RaiseToEarHost } from './components/RaiseToEarHost';
import { StickerSetModal } from './components/StickerSetModal';
import { ServerPicker } from './components/ServerPicker';
import { SetupAdminWizard, SetupConfigureWizard } from './components/SetupWizard';
import { MainLayout } from './components/MainLayout';
import { ShareIncoming } from './components/ShareIncoming';
import { KeyboardContentIncoming } from './components/KeyboardContentIncoming';
import { onBgVoiceEvent, syncBgGateways } from './bgGateways';
import { connectGateway, connectPresence } from './sockets';
import { consumeDeepLink, startPushRegistration } from './nativeUnifiedPush';
import { useStore, voiceIsHere } from './store';
import { afterSplash } from './splashGate';
import { captureStartupVoiceSession, clearVoiceSession } from './voiceSession';
import { setNotifyAlwaysProbe } from './notifications';
import { clearConvCacheWipe, deleteConvCache, finishConvCacheWipes, readConvCache } from './convCache';
import { convCacheKey } from './convCacheRules';
import { onConvCacheFlushed, startConvCacheWriter } from './convCacheWriter';
import { initVoiceTray } from './voiceTray';
import { initDesktopConvNotifications } from './desktopConvNotifications';
import { initNotifyPopups } from './notifyPopupHost';
import { initOverlay } from './overlay';
import { initTipToast } from './tipToast';
import { initAfk } from './afk';
import { initDownloads } from './downloads';
import { startDeviceWatch } from './deviceWatch';
import { stopGameActivity, syncGameActivity } from './gameActivity';
import { toast, toastError } from './toast';
import { playSound } from './sounds';
import { CloseToTrayPrompt } from './components/CloseToTrayPrompt';
import { LastCrashNotice } from './components/LastCrashNotice';
import { UpdatePanel } from './components/UpdatePanel';
import { setDmFileLimit } from './attachRules';

/**
 * Раскладка телефона — список и лента РАЗНЫЕ экраны: приложение на телефоне (`isMobile()`) или окно не шире 760 px (граница
 * `PHONE_LAYOUT_QUERY`, `phoneLayout.ts`): вкладка браузера телефона, узкое окно ПК. 🔴 29.10: здесь был только `isMobile()`,
 * и вкладка Chrome на телефоне считала ленту видимой, когда человек уже ушёл в список, — отмечала прочитанным и прятала число.
 */
function phonePanes(): boolean {
  return isMobile() || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches);
}

/**
 * Всплывашка беседы при выключенных «Личных» / группах (решение владельца 38, `push4`): исключение «Уведомления включены»
 * держится по цели заглушки (id собеседника или `group:<id беседы>`), а `osNotify` знает только id беседы — сопоставляем здесь (не в `store.ts`: его тесты подменяют импорты по списку).
 */
setNotifyAlwaysProbe((convId) => {
  if (!convId) return false;
  const s = useStore.getState();
  if (s.pushAlwaysTargets.length === 0) return false;
  const d = s.dms.find((x) => x.id === convId);
  return !!d && s.pushAlwaysTargets.includes(d.otherUser.id);
});

/** Запись черновиков при срочной записи кеша (Р7) подключается один раз на всё время жизни страницы. */
let draftFlushHooked = false;

const ENTRY_TIMEOUT_MS = 4000;
const ENTRY_RETRY_MS = 650;
const INVITE_ORIGIN_KEY = 'gv.pendingInviteOrigin';

interface EntryState {
  epoch: number;
  attempt: number;
  problem: EntryProblem | null;
  setup: SetupStatus | null;
  notice: string | null;
}

function waitForEntryRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(finish, ENTRY_RETRY_MS);
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

type ProfileCheck =
  | { user: User }
  | 'unauthorized'
  | 'unreachable'
  | 'refused'
  | 'stale';

async function checkProfile(stale: () => boolean, signal: AbortSignal): Promise<ProfileCheck> {
  for (let attempt = 0; attempt < 2 && !stale(); attempt++) {
    const sent = getToken();
    try {
      const user = await withEntryDeadline((requestSignal) => api.me(requestSignal), ENTRY_TIMEOUT_MS, signal);
      if (stale()) return 'stale';
      return user?.id ? { user } : 'refused';
    } catch (error) {
      if (stale() || (error as { switched?: boolean } | null)?.switched) return 'stale';
      if ((error as { status?: number } | null)?.status === 401) {
        // Другой запрос мог уже продлить эту сессию, пока сервер проверял старый токен.
        if (sent === getToken()) return 'unauthorized';
        if (attempt === 1) return 'refused';
        continue;
      }
      const problem = entryFailure(error);
      if (problem === 'refused' || attempt === 1) return problem;
      await waitForEntryRetry(signal);
    }
  }
  return 'stale';
}

async function checkSetup(signal: AbortSignal) {
  try {
    const setup = await withEntryDeadline((requestSignal) => api.setupStatus(requestSignal), ENTRY_TIMEOUT_MS, signal);
    return { setup: typeof setup?.needsSetup === 'boolean' ? setup : null };
  } catch (error) {
    // Ручки нет на старых инстансах. HTTP 404 при этом подтверждает, что адрес отвечает.
    if ((error as { status?: number } | null)?.status === 404) return { setup: null };
    return { setup: null, problem: entryFailure(error) };
  }
}

/** Короткий код остаётся у своего инстанса даже после перезапуска на другой записи. */
function scopePendingInvite(origin: string) {
  try {
    const previous = localStorage.getItem(INVITE_ORIGIN_KEY);
    const code = pendingInvite();
    if (code && previous && previous !== origin) {
      try {
        localStorage.setItem(`${INVITE_ORIGIN_KEY}:${previous}`, code);
      } finally {
        clearPendingInvite();
      }
    }
    const key = `${INVITE_ORIGIN_KEY}:${origin}`;
    if (!pendingInvite()) {
      const saved = localStorage.getItem(key);
      if (saved) rememberInvite(saved);
    }
    localStorage.removeItem(key);
    localStorage.setItem(INVITE_ORIGIN_KEY, origin);
  } catch {
    /* Хранилище недоступно. */
  }
}

export function App() {
  const user = useStore((s) => s.user);
  const setAuth = useStore((s) => s.setAuth);
  const loadServers = useStore((s) => s.loadServers);
  const loadPushMutes = useStore((s) => s.loadPushMutes);
  const loadBlocks = useStore((s) => s.loadBlocks);
  const restoreVoiceSession = useStore((s) => s.restoreVoiceSession);
  /** Поколение активного инстанса (§5.7): растёт на мягком переходе, см. `instanceSwitch.ts`. */
  const instanceEpoch = useStore((s) => s.instanceEpoch);
  const voice = useStore((s) => s.voice);
  const [attempt, setAttempt] = useState(0);
  const requestedAttempt = useRef(0);
  const [entry, setEntry] = useState<EntryState | null>(null);
  const [, setLandingDismissed] = useState(false);
  const invite = useRef({ origin: config.apiUrl, broken: false });
  const guestNotice = useRef<{ epoch: number; id: string; text: string } | null>(null);
  const steamResult = useRef<string | null>(null);
  const web = !isTauri();
  const activeId = activeInstanceId();

  function entryChanged() {
    return useStore.getState().instanceEpoch !== instanceEpoch ||
      activeInstanceId() !== activeId || requestedAttempt.current !== attempt;
  }

  function authenticatedScope(changed = entryChanged) {
    const account = entryAccount(getToken());
    const userId = useStore.getState().user?.id;
    return () => changed() || entryAccount(getToken()) !== account || useStore.getState().user?.id !== userId;
  }

  /**
   * ЛС этап 2 (`docs/dm/STAGE2.md`): говорить ли с ЛС через беседы. Решается ДО подключения шлюза — от этого зависит
   * `caps` в `identify`. После входа по паролю `loadMe` не звали, признаков нет — узнаём их здесь. Сервер без бесед
   * (`conv1`+`conv2`: коробки ≤ 0.8.17) — ЛС нет, в списке заглушка «нужно обновить сервер» (решение владельца 09.10:
   * старого пути `/api/dm*` у клиента больше нет); каналы и голос работают как раньше.
   */
  async function decideConvMode(stale: () => boolean): Promise<void> {
    const st = useStore.getState();
    let features = st.serverFeatures;
    if (features === null) {
      const me = await withEntryDeadline((signal) => api.me(signal), ENTRY_TIMEOUT_MS).catch(() => null);
      if (stale()) return;
      if (me?.id) {
        setDmFileLimit(me.features, me.dmFileMaxBytes);
        features = me.features ?? [];
        st.setServerFeatures(features);
      }
    }
    // Оба признака: у сервера 0.8.17 есть `conv1`, но нет `created` и старой рассылки — там ЛС недоступны.
    const active = !!features?.includes(CAP_CONV1) && !!features?.includes(FEATURE_CONV2);
    st.setConvActive(active);
    const me = useStore.getState().user;
    if (!active || !me) return;
    /* Шаг 2б: первый кадр из кеша на диске — список бесед и хвосты лент до их запросов; догонка на `ready` пойдёт с
       номера из кеша. Ключ — инстанс + человек (другой аккаунт того же инстанса — другая запись). */
    const key = convCacheKey(activeInstance(), config.apiUrl, me.id);
    st.setConvCacheKey(key);
    // Стирание, оборванное прошлой перезагрузкой после выхода, — доделать ДО чтения кеша.
    await finishConvCacheWipes();
    // Человек уже ушёл в другой инстанс — кеш ЭТОГО в стор нового не вливаем (01.10: переход не закрыт экраном).
    if (stale()) return;
    // Не стёрлось (база не открылась), а человек уже снова вошёл — это его же запись: метку снять, иначе следующий запуск
    // стёр бы уже новые черновики и неотправленное.
    clearConvCacheWipe(key);
    const rec = await readConvCache(key);
    if (stale()) return;
    if (rec) {
      try {
        useStore.getState().convHydrate(rec);
      } catch {
        // Запись прошла проверку, но подъём упал — запуск важнее кеша: чистое состояние, запись долой, список из сети.
        useStore.getState().convReset();
        void deleteConvCache(key);
      }
    }
    startConvCacheWriter();
    // Черновики на сервер при уходе в фон, закрытии окна и переходе в другой инстанс (Р7) — ПОСЛЕ того, как лента
    // отдала свой отложенный черновик в стор; `keepalive` — запрос переживёт выгрузку страницы.
    if (!draftFlushHooked) {
      draftFlushHooked = true;
      onConvCacheFlushed(() => useStore.getState().convFlushDrafts(true));
    }
  }

  /** `stale` проверяет, принадлежит ли работа текущему заходу и аккаунту. */
  async function bootstrap(stale: () => boolean) {
    if (stale()) return;
    /** Закрытый держателем сервер объясняем окном (#203) только в текущем заходе. */
    function explainClosedServer(serverId: string): (err: unknown) => never {
      return (err) => {
        if (!stale()) {
          const s = useStore.getState();
          const notice = noticeFromRefusal(err, { id: serverId, name: s.servers.find((x) => x.id === serverId)?.name ?? 'сервер' });
          if (notice) s.noteAccessClosed(notice);
        }
        throw err;
      };
    }
    // Admission and stale-intent cleanup precede both async loading and gateway reconnects.
    const startupVoice = useStore.getState().voice ? null : captureStartupVoiceSession();
    await decideConvMode(stale);
    if (stale()) return;
    await loadServers();
    if (stale()) return;
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
    // Трансляция геопозиции в ЛС (`geolive1`): идущие с прошлого запуска (в `localStorage`, пока не вышел срок) продолжаются.
    void import('./geoLiveSharing').then((m) => { if (!stale()) m.resumeGeoLive(); }, () => {});
    // Reconnect-grace restore (#11): if we dropped from a voice channel within the grace window
    // (crash / quick restart), rejoin it now — mute/deafen come back from the persisted self state.
    // На десктопе — только после заставки (28.10, `splashGate.ts`): иначе прежняя версия заходила в канал, пока
    // заставка ставит обновление, и новая версия — ещё раз.
    if (startupVoice) {
      void afterSplash(() => {
        if (!stale() && !useStore.getState().voice) startupVoice.touch();
      }).then(() => {
        if (stale() || useStore.getState().voice) return;
        const session = startupVoice.current();
        if (session) return restoreVoiceSession(session);
      });
    }
    // Android push deep-link (#118): a cold start from a notification tap has a pending target — jump to it.
    // Забрали ссылку из пуша — «последнее место» ниже её не перебивает: переход идёт асинхронно, и в режиме бесед
    // (список из кеша, без сети) сервер из прошлого места открывался раньше беседы и затирал её.
    const tookLink = consumeDeepLink();
    /**
     * Открылись по ссылке-приглашению (§4.2.2): адресом `/i/<код>` в вебе или схемой `gusvoice://`
     * на десктопе и Android. Окно проверки поднимет рейл, как только увидит намерение.
     *
     * ⚠️ Адрес чистим сразу: оставленный `/i/<код>` открывал бы окно при каждой перезагрузке — в том
     * числе через неделю, когда человек давно вступил.
     */
    const fromPath = inviteCodeFromPath(window.location.pathname);
    if (fromPath && config.apiUrl === invite.current.origin) {
      offerInviteLink(`${window.location.origin}/i/${fromPath}`);
      window.history.replaceState({}, '', '/');
    }
    /**
     * Переключились ради конкретного сервера чужого инстанса (§5.7) — открываем именно его.
     *
     * ⚠️ После `loadServers()`: сервер должен уже быть в списке, иначе рейл откроет его и тут же
     * перерисуется без него. Отказ глотаем молча — членство могли снять, пока приложение
     * перезапускалось, и вываливать это ошибкой на старте не за что. Кроме «закрыт держателем» —
     * его сперва объясняет окно (`explainClosedServer`, #203).
     */
    const pending = takePendingOpen(activeInstanceId());
    if (pending?.serverId) {
      await useStore
        .getState()
        .openServer(pending.serverId)
        .catch(explainClosedServer(pending.serverId))
        .catch(() => {});
      if (stale()) return;
      // Тап по пушу ведёт в КАНАЛ, а не просто на сервер: человек шёл читать то, о чём его позвали.
      // Сервер не открылся (закрыт держателем, членство сняли) — канал не трогаем: без своего сервера
      // он открылся бы пустым «Выбери канал».
      if (pending.channelId && useStore.getState().currentServerId === pending.serverId) {
        await useStore
          .getState()
          .openChannel(pending.channelId)
          .catch(() => {});
        /* Отказ «ушли в другой инстанс» глотается вместе с прочими — без проверки устаревший заход шёл дальше, к
           приглашению, уже через API НОВОГО инстанса: чужой код там 404, его стирали и показывали ошибку (Codex, 01.10). */
        if (stale()) return;
      }
    }
    await joinPendingInvite(stale);
    if (stale()) return;
    /**
     * Последним делом — вернуть человека туда, где он был до перезагрузки (`lastPlace.ts`).
     *
     * ⚠️ Именно ПОСЛЕДНИМ и только если никуда не пришли раньше: ссылка-приглашение, переход между
     * инстансами и тап по пушу — это осознанное намерение «открой вот это», и перебивать его
     * прошлым местом было бы грубо.
     *
     * ⚠️ Запись из хранилища — подсказка, а не приказ: сервер могли закрыть, канал удалить, права
     * отобрать. Поэтому `openServer`/`openChannel` зовутся с глушением отказа («закрыт держателем»
     * сперва объясняет окно, #203), а на телефоне канал не открываем вовсе — там переход на сервер
     * обязан показать СПИСОК каналов, а не вывалить человека сразу в стену переписки (то же правило,
     * что в `openServer`).
     */
    const st = useStore.getState();
    if (!tookLink && !st.currentServerId && !st.currentDmId) {
      const place = lastPlace(activeInstanceId());
      if (place?.dmId) {
        await useStore.getState().selectDm(place.dmId).catch(() => {});
      } else if (place?.serverId) {
        await useStore.getState().openServer(place.serverId).catch(explainClosedServer(place.serverId)).catch(() => {});
        if (stale()) return;
        if (place.channelId && !phonePanes() && useStore.getState().currentServerId === place.serverId) {
          await useStore.getState().openChannel(place.channelId).catch(() => {});
        }
      }
    }
  }

  /**
   * Пришли по ссылке `?invite=КОД` (#142) — после входа сразу вступаем на сервер. Код забываем, когда
   * вступили или когда он точно мёртв (нет, истёк, бан); сетевой сбой — оставляем до следующего запуска.
   */
  async function joinPendingInvite(stale: () => boolean) {
    const code = pendingInvite();
    if (!code) return;
    try {
      const boot = await api.acceptInvite(code);
      if (stale() || pendingInvite() !== code) return;
      clearPendingInvite();
      await loadServers();
      if (!stale()) toast('success', `Вы на сервере «${boot.server.name}»`);
    } catch (e) {
      if (stale() || pendingInvite() !== code) return;
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 410 || status === 403) {
        clearPendingInvite();
        toast('error', 'Приглашение не сработало', (e as Error).message);
      }
    }
  }

  async function finishAuthentication(stale: () => boolean) {
    try {
      await bootstrap(stale);
    } catch {
      /* Сбой загрузки не меняет состояние входа. */
    } finally {
      if (!stale()) useStore.setState({ switching: false });
    }
  }

  /** Мастер создал супер-админа — входим так же, как после обычного входа. */
  async function adminCreated(res: AuthResponse) {
    if (entryChanged() || getToken()) return;
    setToken(res.token);
    setAuth(res.user);
    updateActiveInstance({ userId: res.user.id, displayName: res.user.displayName, lastLogin: res.user.username });
    setEntry((cur) => cur && {
      ...cur,
      setup: { needsSetup: false, tokenConfigured: cur.setup?.tokenConfigured ?? true, wizardPending: true },
    });
    await finishAuthentication(authenticatedScope());
  }

  useEffect(() => {
    // Переписка на диске, чьё стирание при выходе оборвала перезагрузка (ЛС этап 2), — стереть при любом запуске,
    // не дожидаясь входа.
    void finishConvCacheWipes();
    // Desktop tray mirror (mute/deafen/speaking bubble) — self-gates to Tauri builds, no-op on web.
    initVoiceTray();
    initDesktopConvNotifications();
    // Десктоп: свои всплывающие окна уведомлений, как у Telegram Desktop (G38, ND-07); веб и Android — без изменений.
    initNotifyPopups();
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
    if (!needsServerPick()) scopePendingInvite(config.apiUrl);
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
    /**
     * Битая ссылка `/i/…` — кода не разобрать (#200). Адрес убираем сразу (перезагрузка не должна повторять того же),
     * а сказать словами можно, только когда станет ясно, какой экран увидит человек: вошедшему — тостом, остальным —
     * строкой на экране входа (тостов там нет вовсе, `ToastHost` живёт в `MainLayout`).
     */
    invite.current.broken = isBrokenInvitePath(window.location.pathname);
    if (invite.current.broken) window.history.replaceState({}, '', '/');

    const query = new URLSearchParams(window.location.search);
    steamResult.current = query.get('steam');
    if (steamResult.current) {
      query.delete('steam');
      const search = query.toString();
      window.history.replaceState({}, '', window.location.pathname + (search ? `?${search}` : '') + window.location.hash);
    }
  }, []);

  // Один заход для запуска, Retry и перехода. Смена записи инвалидирует его синхронно, ещё до cleanup эффекта.
  useEffect(() => {
    if (needsServerPick()) return;
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted || entryChanged();

    const record = activeInstance();
    const host = serverHost(config.apiUrl);
    const home = instances().find((instance) => instance.id === record?.guestOf && !instance.guestOf);
    const notice = guestNotice.current;
    const incomingNotice = notice?.epoch === instanceEpoch && notice.id === activeId ? notice.text : null;

    // Код короткой ссылки относится к инстансу, на котором получен. Вход у другого не должен подставлять его в форму.
    const inviteState = invite.current;
    scopePendingInvite(config.apiUrl);

    function publish(problem: EntryProblem | null, setup: SetupStatus | null = null, message = incomingNotice) {
      setEntry({ epoch: instanceEpoch, attempt, problem, setup, notice: message });
      if (problem || !useStore.getState().user) useStore.setState({ switching: false });
    }

    function returnFromGuest(expired: boolean) {
      const message = expired
        ? `Гостевая сессия на «${host}» истекла.`
        : `Для входа на «${host}» нужна гостевая сессия от вашего инстанса.`;
      if (home) {
        guestNotice.current = {
          epoch: instanceEpoch + 1,
          id: home.id,
          text: `${message} Ваш инстанс — «${serverHost(home.apiUrl)}».`,
        };
        void switchInstance(home.id);
      } else {
        publish('guest', null, message);
      }
    }

    async function enter() {
      if (record?.guestOf && !getToken()) {
        returnFromGuest(false);
        return;
      }

      const account = entryAccount(getToken());
      const stale = authenticatedScope(cancelled);
      const setupCheck = web || !account ? checkSetup(controller.signal) : null;
      let authed = false;
      if (account) {
        const profile = await checkProfile(stale, controller.signal);
        if (stale() || profile === 'stale') return;
        if (profile === 'unreachable' || profile === 'refused') {
          publish(profile);
          return;
        }
        if (profile === 'unauthorized') {
          setToken(null);
          const s = useStore.getState();
          if (s.voice && voiceIsHere(s.voice)) s.leaveVoice();
          else clearVoiceSession(activeId);
          s.setServerFeatures(null);
          useStore.setState({ user: null });
          if (record?.guestOf) {
            returnFromGuest(true);
            return;
          }
        } else {
          setDmFileLimit(profile.user.features, profile.user.dmFileMaxBytes);
          useStore.getState().setServerFeatures(profile.user.features ?? []);
          noteActiveSuperAdmin(!!profile.user.superAdmin);
          setAuth(profile.user);
          authed = true;
        }
      }

      const currentAccount = authenticatedScope(cancelled);
      // Для обычного пользователя статус мастера ни на что не влияет.
      const result = !authed || useStore.getState().user?.superAdmin ? await setupCheck : null;
      if (currentAccount()) return;
      if (!account && result?.problem) {
        publish(result.problem);
        return;
      }

      let message = incomingNotice;
      if (config.apiUrl === inviteState.origin) {
        if (inviteState.broken) {
          inviteState.broken = false;
          if (authed) toast('error', BROKEN_INVITE_TITLE, BROKEN_INVITE_HINT);
          else message = [message, `${BROKEN_INVITE_TITLE}. ${BROKEN_INVITE_HINT}`].filter(Boolean).join(' ');
        }
        if (steamResult.current) {
          if (steamResult.current === 'linked') toast('success', 'Steam привязан');
          else toast('error', 'Не удалось привязать Steam');
          steamResult.current = null;
        }
      }
      if (authed && incomingNotice) toast('info', incomingNotice);
      publish(null, web ? result?.setup ?? null : null, message);
      if (authed) await finishAuthentication(currentAccount);
    }

    void enter();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceEpoch, attempt]);

  // Desktop game-activity reporter (#40): run while authed (re-syncs when the user toggles the switch,
  // since `user` changes), stop on logout. Self-gates to desktop, so it's a no-op on web/mobile.
  useEffect(() => {
    if (user) syncGameActivity();
    else stopGameActivity();
  }, [user]);

  /* Голос на ДРУГОМ инстансе (смотрим дом, а сидим у соседа, 01.10): его события приходят фоновым шлюзом. Пока
     голос на экранном инстансе, их ведёт основной шлюз (`sockets.ts`) — здесь только чужой. */
  useEffect(
    () =>
      onBgVoiceEvent(({ instanceId, msg }) => {
        const s = useStore.getState();
        const v = s.voice;
        if (!v || v.instanceId !== instanceId || voiceIsHere(v)) return;
        if (msg.t === 'server.access_closed') {
          if (!v.serverId || v.serverId === msg.serverId) s.leaveVoice();
          return;
        }
        if (msg.moveTicket && v.channelId !== msg.fromChannelId) return;
        void s
          .moveVoiceTo(msg.channelId, msg.moveTicket)
          .then(() => {
            if (msg.moveTicket && useStore.getState().voice?.channelId !== msg.channelId) return;
            playSound('move', msg.channelId);
            toast('info', 'Вас переместили в другой канал');
          })
          .catch((e) => toastError(e, 'Не удалось переместиться'));
      }),
    [],
  );

  // Выдернули микрофон или наушники — переходим на то, что осталось (#131). Слежение живёт ЗДЕСЬ, а
  // не в голосовом соединении: устройство выдёргивают и когда в канале не сидят, и тогда в
  // настройках просто остаётся ссылка на то, чего больше нет.
  useEffect(() => startDeviceWatch(), []);

  const current = entry?.epoch === instanceEpoch && entry.attempt === attempt ? entry : null;
  const setup = current?.setup;
  const problem = current ? current.problem : 'checking';
  const registry = instances();
  const record = registry.find((instance) => instance.id === activeId);
  const strandedGuest = !!record?.guestOf && !user;
  const recover = problem ?? (strandedGuest ? 'guest' : null);
  const voiceId = voice?.instanceId;
  const voiceOwner = voiceId && registry.find((instance) => instance.id === voiceId && instance.token);
  const voiceTarget = voiceId !== activeId && voiceOwner;
  const targets = savedEntryTargets(registry, activeId);
  const recoveryTargets = voiceTarget ? targets.filter((target) => target.id !== voiceTarget.id) : targets;
  const authNotice = current?.notice && <div className="auth-notice" role="status">{current.notice}</div>;

  function navigate(id: string) {
    if (entryChanged()) return;
    guestNotice.current = null;
    void switchInstance(id);
  }

  function choose(id: string) {
    if (savedEntryTargets(instances(), activeInstanceId()).some((target) => target.id === id)) navigate(id);
  }

  // /i/<код> уже вошедшему откроет окно проверки из bootstrap. Для гостя без сессии пароль не предлагаем.
  const landingCode = !user && !strandedGuest && config.apiUrl === invite.current.origin
    ? inviteCodeFromPath(window.location.pathname)
    : null;
  const recoveryScreen = recover && (
    <InstanceUnreachable
      problem={recover}
      host={serverHost(config.apiUrl)}
      savedSession={!!getToken()}
      notice={current?.notice ?? (guestNotice.current?.epoch === instanceEpoch && guestNotice.current.id === activeId
        ? guestNotice.current.text
        : null)}
      targets={recoveryTargets}
      onSelect={choose}
      onRetry={recover === 'unreachable' || recover === 'refused' ? () => {
        if (!entryChanged()) setAttempt(++requestedAttempt.current);
      } : undefined}
      onReturnToVoice={voiceTarget ? () => {
        if (useStore.getState().voice === voice && instances().some((instance) => instance.id === voiceTarget.id && instance.token)) {
          navigate(voiceTarget.id);
        }
      } : undefined}
      onLeaveVoice={voice ? () => {
        const s = useStore.getState();
        if (!entryChanged() && s.voice === voice) s.leaveVoice();
      } : undefined}
    />
  );
  const pickingServer = needsServerPick();
  const screen = pickingServer ? (
    <ServerPicker />
  ) : recoveryScreen ? recoveryScreen : landingCode ? (
    <InviteLanding
      code={landingCode}
      onHere={() => {
        if (entryChanged()) return;
        rememberInvite(landingCode);
        window.history.replaceState({}, '', '/');
        setLandingDismissed(true);
      }}
    />
  ) : !user ? (
    setup?.needsSetup && web ? (
      <>
        {authNotice}
        <SetupAdminWizard tokenConfigured={setup.tokenConfigured} onAdminCreated={adminCreated} />
      </>
    ) : (
      <>
        {authNotice}
        {targets.length > 0 && (
          <details>
            <summary>Сохранённые входы</summary>
            <div className="unreachable-actions"><EntryChoices targets={targets} onSelect={choose} /></div>
          </details>
        )}
        <Login
          key={instanceEpoch}
          onAuthed={() => {
            if (!entryChanged() && getToken()) return finishAuthentication(authenticatedScope());
          }}
          setupPending={!!setup?.needsSetup}
        />
      </>
    )
  ) : user.superAdmin && setup?.wizardPending && web ? (
    <>
      {authNotice}
      <SetupConfigureWizard
        onFinished={async () => {
          if (entryChanged()) return;
          setEntry((cur) => cur?.setup ? { ...cur, setup: { ...cur.setup, wizardPending: false } } : cur);
          await loadServers();
        }}
      />
    </>
  ) : null;

  // Пока у комнаты есть своя сессия, смена показанного инстанса меняет содержимое того же MainLayout.
  const keepRoom = !!voiceOwner && !!getToken() && !!recoveryScreen && !pickingServer;
  const content = !screen || keepRoom ? (
    <>
      <MainLayout connectionScreen={screen} />
      {/* «Поделиться в GusVoice» (09.10, G79): окно выбора беседы для пришедшего из чужого приложения (только Android). */}
      {!screen && <ShareIncoming />}
      {/* Картинки и GIF из клавиатуры (G50): встают вложением в поле открытой беседы (только Android). */}
      {!screen && <KeyboardContentIncoming />}
    </>
  ) : screen;

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
      {/* Окно набора стикеров (С2, `stickers2`): из ленты ЛС и каналов, из каталога в панели. */}
      <StickerSetModal />
      {/* 🔴 Окно подтверждения — ЗДЕСЬ, а не в `MainLayout`: подтверждать приходится и до того, как
          главный экран собран (выбор инстанса, мастер, «инстанс не отвечает»). Ошибку `ToastHost`,
          который в такие минуты не виден, не повторяем. */}
      <ConfirmHost />
      {/* «Свой срок…» у «Без звука» (`mute2`): выбор даты и времени; меню, из которого его открыли, уже закрыто. */}
      <MuteCustomHost />
      {/* «Поднести к уху» (G67): датчик приближения, пока играет голосовое; только Android. */}
      <RaiseToEarHost />
    </>
  );
}
