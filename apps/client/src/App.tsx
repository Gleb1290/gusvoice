import { CAP_CONV1, FEATURE_CONV2, type AuthResponse, type SetupStatus } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
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
import { setLoginNotice } from './loginNotice';
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
import { InstanceUnreachable } from './components/InstanceUnreachable';
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
import { setNotifyAlwaysProbe } from './notifications';
import { clearConvCacheWipe, deleteConvCache, finishConvCacheWipes, readConvCache } from './convCache';
import { convCacheKey } from './convCacheRules';
import { onConvCacheFlushed, startConvCacheWriter } from './convCacheWriter';
import { initVoiceTray } from './voiceTray';
import { initUnreadBadge } from './unreadBadge';
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

/**
 * Отказ открыть сервер на старте (намерение после перехода, прошлое место): «закрыт держателем» — окном (#203).
 *
 * 🔴 Гостя закрыли, пока его не было, а старт глотает отказы молча: человек приходил на пустое «Выбери сервер» без
 * единого слова. Окно и замок в рейле — те же, что у клика по серверу (`ServerRail.select`) и у события
 * `server.access_closed`. Отказ летит дальше как был — следующий `.catch` глушит его, как и раньше.
 */
function explainClosedServer(serverId: string): (err: unknown) => never {
  return (err) => {
    const s = useStore.getState();
    const notice = noticeFromRefusal(err, { id: serverId, name: s.servers.find((x) => x.id === serverId)?.name ?? 'сервер' });
    if (notice) s.noteAccessClosed(notice);
    throw err;
  };
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
  async function loadMe(): Promise<'ok' | 'unauthorized' | 'unreachable' | 'stale'> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const me = await api.me();
        setAuth(me);
        // Признаки сервера — отдельно от `user` (ЛС этап 2): другие ручки кладут `User` без них.
        // Предел файла ЛС (`bigfile1`) — до признаков: их смена перерисует беседу уже с новым пределом.
        setDmFileLimit(me.features, me.dmFileMaxBytes);
        useStore.getState().setServerFeatures(me.features ?? []);
        // Снимок для кнопки админки, пока человек будет гостем у соседа (`adminTarget`, 23.09).
        noteActiveSuperAdmin(!!me.superAdmin);
        return 'ok';
      } catch (e) {
        // Пока ходили, человек кликнул в другой инстанс (рейл больше не закрыт экраном загрузки, 01.10): ответ не наш,
        // и повтор ушёл бы уже к новому инстансу — его ведёт следующий заход.
        if ((e as { switched?: boolean }).switched) return 'stale';
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
  /**
   * ЛС этап 2 (`docs/dm/STAGE2.md`): говорить ли с ЛС через беседы. Решается ДО подключения шлюза — от этого зависит
   * `caps` в `identify`. После входа по паролю `loadMe` не звали, признаков нет — узнаём их здесь. Сервер без бесед
   * (`conv1`+`conv2`: коробки ≤ 0.8.17) — ЛС нет, в списке заглушка «нужно обновить сервер» (решение владельца 09.10:
   * старого пути `/api/dm*` у клиента больше нет); каналы и голос работают как раньше.
   */
  async function decideConvMode(stale: () => boolean = () => false): Promise<void> {
    const st = useStore.getState();
    let features = st.serverFeatures;
    if (features === null) {
      features = await api
        .me()
        .then((me) => {
          setDmFileLimit(me.features, me.dmFileMaxBytes);
          return me.features ?? [];
        })
        .catch(() => null);
      if (stale()) return;
      if (features) st.setServerFeatures(features);
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

  /** `stale` — заход устарел: человек уже ушёл в другой инстанс (переход больше не прячет экран, 01.10). */
  async function bootstrap(stale: () => boolean = () => false) {
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
    void import('./geoLiveSharing').then((m) => m.resumeGeoLive(), () => {});
    // Reconnect-grace restore (#11): if we dropped from a voice channel within the grace window
    // (crash / quick restart), rejoin it now — mute/deafen come back from the persisted self state.
    void restoreVoiceSession();
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
    if (fromPath) {
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
    await joinPendingInvite();
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
    const epoch = useStore.getState().instanceEpoch;
    try {
      const boot = await api.acceptInvite(code);
      // Вступили — код потрачен при любом исходе дальше.
      clearPendingInvite();
      await loadServers();
      // Человек уже на другом инстансе — «вы на сервере» про прежний там только сбило бы с толку.
      if (useStore.getState().instanceEpoch !== epoch) return;
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
    // Переписка на диске, чьё стирание при выходе оборвала перезагрузка (ЛС этап 2), — стереть при любом запуске,
    // не дожидаясь входа.
    void finishConvCacheWipes();
    // Desktop tray mirror (mute/deafen/speaking bubble) — self-gates to Tauri builds, no-op on web.
    initVoiceTray();
    // Десктоп: число непрочитанных ЛС на значке панели задач и в трее (Р1, G39); снятие тостов прочитанной беседы.
    initUnreadBadge();
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
    const brokenInvite = isBrokenInvitePath(window.location.pathname);
    if (brokenInvite) window.history.replaceState({}, '', '/');
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
      let state: Awaited<ReturnType<typeof loadMe>> | null = null;
      if (getToken()) {
        state = await loadMe();
        setUnreachable(state === 'unreachable');
        if (state === 'ok') {
          try {
            await bootstrap();
          } catch {
            /* transient — session stays; a reload re-runs bootstrap */
          }
        }
      }
      // «Инстанс не отвечает» — ни тоста, ни экрана входа там нет; ушли в другой инстанс, пока грузились (`stale`), —
      // человек уже занят другим. В обоих случаях объяснение про ссылку было бы не к месту.
      if (brokenInvite && state !== 'unreachable' && state !== 'stale') {
        if (useStore.getState().user) toast('error', BROKEN_INVITE_TITLE, BROKEN_INVITE_HINT);
        else setLoginNotice(`${BROKEN_INVITE_TITLE}. ${BROKEN_INVITE_HINT}`);
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
    /* 🔴 Переход между инстансами больше НЕ показывает экран загрузки (01.10): главный экран остаётся на месте —
       рейл, человек внизу и голос, который принадлежит своему инстансу (`instanceSwitch.ts`), а середина ждёт свой
       сервер. Раньше «Loading…» снимал весь `MainLayout`, вместе с ним и комнату голоса — моргало и выкидывало.
       Экран не закрыт — значит, рейл нажимают и во время захода: каждый шаг проверяет, не устарел ли он. */
    const stale = () => useStore.getState().instanceEpoch !== instanceEpoch;
    // Экран «не отвечает» был про ПРЕЖНИЙ инстанс — без сброса он говорил бы это про новый, пока идёт заход.
    setUnreachable(false);
    (async () => {
      if (!bounceStrandedGuestHome() && getToken()) {
        const state = await loadMe();
        if (stale() || state === 'stale') return;
        setUnreachable(state === 'unreachable');
        // Вход не принят: `switchedInstance` больше не стирает человека, раз у цели был токен, — стираем здесь, иначе
        // на экране остался бы прежний профиль вместо формы входа (или увода гостя домой — он уже запущен).
        if (state === 'unauthorized') useStore.setState({ user: null });
        if (state === 'ok') {
          try {
            await bootstrap(stale);
          } catch {
            /* сеть моргнула — сессия остаётся, перезагрузка добьёт */
          }
        }
      }
      if (!stale()) {
        setLoading(false);
        useStore.setState({ switching: false });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceEpoch]);

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
        playSound('move', msg.channelId);
        void s
          .moveVoiceTo(msg.channelId)
          .then(() => toast('info', 'Вас переместили в другой канал'))
          .catch((e) => toastError(e, 'Не удалось переместиться'));
      }),
    [],
  );

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
  ) : loading || (switching && !user) ? (
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
    <>
      <MainLayout />
      {/* «Поделиться в GusVoice» (09.10, G79): окно выбора беседы для пришедшего из чужого приложения (только Android). */}
      <ShareIncoming />
      {/* Картинки и GIF из клавиатуры (G50): встают вложением в поле открытой беседы (только Android). */}
      <KeyboardContentIncoming />
    </>
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
