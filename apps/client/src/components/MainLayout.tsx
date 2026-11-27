import type { Channel, ServerBootstrap } from '@gusvoice/shared';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { isMobile } from '../hotkeys';
import { useStore, voiceIsHere } from '../store';
import { withoutArchived } from '../dmArchiveRules';
import { AdminPanel } from './AdminPanel';
import { ChannelSidebar } from './ChannelSidebar';
import { MobileCallChip } from './MobileCallChip';
import { MobileProfile } from './MobileProfile';
import { ChatView } from './ChatView';
import { DmChatView } from './DmChatView';
import { DmSidebar } from './DmSidebar';
import { PhoneServerList } from './PhoneServerList';
import { EconomyWelcome } from './EconomyWelcome';
import { ActivitiesHost } from './Activities';
import { RecountNotice } from './RecountNotice';
import { ensureRecaps, recapStorage } from '../gameBoardClient';
import { readRecapSeen, recapAutoQueue } from '../gameBoardRules';
import { FeatherLayer } from './FeatherLayer';
import { BigReactionLayer } from './BigReactionLayer';
import { EffectsBench } from './EffectsBench';
import { GooseBonusHost } from './GooseBonusHost';
import { HotkeyCheatSheet } from './HotkeyCheatSheet';
import { ChatSwitchHost } from './ChatSwitch';
import { ContactEditHost } from './ContactEditModal';
import { DesktopKeysHost } from './DesktopKeys';
import { closeCheatSheet, openCheatSheet, toggleCheatSheet, useCheatSheetOpen } from '../cheatSheet';
import { openDmCompose } from '../dmCompose';
import { DM_SERVER_UPDATE_TEXT, dmEmptyHint, dmNeedsServerUpdate } from '../dmRules';
import { exitSelection, useSelectionOpen } from '../dmSelection';
import { exitChatSearch } from './ChatSearch';
import { backFromSchedView, useSchedViewOpen } from '../schedView';
import { dmBackBadgeCount, dmBackBadgeLabel } from '../dmBackBadge';
import { useSwipeBack } from '../useSwipeBack';
import { isPhoneUiNow, usePhoneLayout } from '../phoneLayout';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { ImageViewerHost } from './ImageViewerHost';
import { MobileNav } from './MobileNav';
import { ServerMembersPanel } from './ServerMembersPanel';
import { ServerRail } from './ServerRail';
import { SidebarResizer } from './SidebarResizer';
import { PokeModal } from './PokeModal';
import { ServerClosedModal } from './ServerClosedModal';
import { ToastHost } from './ToastHost';
import { CallBar, CallLayer } from './CallLayer';
import { UserSettingsModal } from './UserSettingsModal';
import { VoiceChannelView } from './VoiceChannelView';
import { VoiceConnection } from './VoiceConnection';
import { feedNavKey, feedNavTarget } from '../feedNavRules';

/** «Итоги» (этап 6) — ленивый кусок: слайды и их картинки не в основном бандле. */
const RecapScene = lazy(() => import('./RecapScene'));
const GamesLaunchHost = lazy(() => import('./GamesLaunchNotice'));

/** Channels in sidebar order (uncategorized first, then categories by position), text only. */
function orderedTextChannels(b: ServerBootstrap): Channel[] {
  const cats = [...b.categories].sort((a, z) => a.position - z.position);
  const inCat = (catId: string | null) =>
    b.channels
      .filter((c) => c.type === 'text' && (c.categoryId ?? null) === catId)
      .sort((a, z) => a.position - z.position);
  return [...inCat(null), ...cats.flatMap((c) => inCat(c.id))];
}

export function MainLayout({ connectionScreen }: { connectionScreen?: ReactNode } = {}) {
  const recovering = connectionScreen != null;
  // Выключатель общий (`cheatSheet.ts`): к шпаргалке зовут и клавишей `?`, и кнопкой из шапки.
  const cheatOpen = useCheatSheetOpen();
  // Стенд эффектов (#120): Ctrl+Alt+E, только супер-админу. Ничего не шлёт на сервер.
  const [benchOpen, setBenchOpen] = useState(false);
  const bootstrap = useStore((s) => s.bootstrap);
  const currentChannelId = useStore((s) => s.currentChannelId);
  const voice = useStore((s) => s.voice);
  const view = useStore((s) => s.view);
  const dms = useStore((s) => s.dms);
  // Список бесед ещё не пришёл (беседы без кеша) — пустым его не называем, гусь не мелькает до ответа сервера.
  const dmListKnown = useStore((s) => s.convActive && s.conv.pts !== null);
  // Сервер без бесед (`conv1`+`conv2`) — ЛС там нет: вместо гуся «Бесед пока нет» заглушка про обновление (09.10).
  const dmOff = useStore((s) => dmNeedsServerUpdate(s.serverFeatures));
  const currentDmId = useStore((s) => s.currentDmId);
  const mobilePane = useStore((s) => s.mobilePane);
  const serverListOpen = useStore((s) => s.serverListOpen);
  const currentServerId = useStore((s) => s.currentServerId);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const adminOpen = useStore((s) => s.adminOpen);
  const instanceEpoch = useStore((s) => s.instanceEpoch);
  const switching = useStore((s) => s.switching);
  const setAdminOpen = useStore((s) => s.setAdminOpen);
  const mobileMembersOpen = useStore((s) => s.mobileMembersOpen);
  const setMobileMembersOpen = useStore((s) => s.setMobileMembersOpen);
  const mobileProfileOpen = useStore((s) => s.mobileProfileOpen);
  // Раскладка телефона (≤ 760 px) — и в приложении, и в мобильном браузере: экрану «Профиля» нужна она, а не оболочка.
  const phone = usePhoneLayout();
  const incomingPoke = useStore((s) => s.incomingPoke);
  /**
   * Приветствие экономики (03.09). Само открывается ОДИН РАЗ: экономика на этом сервере включена, а в
   * профиле нет отметки «видел». Отметку ставит само окно при закрытии; на случай, если запрос не
   * дошёл, сессионный `welcomeDismissed` не даёт окну выскочить второй раз до перезапуска.
   * Повторно — по просьбе: кнопка в кошельке и на стенде через `economyWelcomeOpen` в сторе.
   */
  const me = useStore((s) => s.user);
  const economyEnabledHere = useStore((s) => !!(s.bootstrap && s.economy[s.bootstrap.server.id]?.enabled));
  const welcomeRequested = useStore((s) => s.economyWelcomeOpen);
  const setWelcomeRequested = useStore((s) => s.setEconomyWelcomeOpen);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const welcomeOpen =
    welcomeRequested || (economyEnabledHere && !!me && !me.economyWelcomeSeen && !welcomeDismissed);
  /**
   * Карточка перерасчёта сезона (28.10, `RecountNotice.tsx`): снимок экономики текущего сервера несёт
   * `recount` — значит, есть непросмотренная доплата. Закрытие ставит отметку на сервере (сама карточка по
   * `markSeenOn`, `api.markRecountSeen`) и убирает поле из снимка в сторе; `recountDismissed` — страховка на сессию,
   * если запрос не дошёл (как `welcomeDismissed`). Ворота показа — ниже, рядом с гусем.
   */
  const recountServerId = useStore((s) => s.bootstrap?.server.id ?? null);
  const recountView = useStore((s) => (s.bootstrap ? s.economy[s.bootstrap.server.id] : undefined));
  const [recountDismissed, setRecountDismissed] = useState<string[]>([]);
  const recount =
    recountServerId && recountView?.enabled && recountView.recount && !recountDismissed.includes(recountServerId)
      ? recountView.recount
      : null;
  /**
   * «Итоги» месяца игр и сезона экономики (ГусКоины 2, этап 6, `RecapScene.tsx`, ленивая). Последние замороженные грузит
   * `ensureRecaps`; сами всплывают ОДИН раз на период (отметка в `localStorage` — удобство, не данные) и только тому, у кого
   * есть личная часть; по одному — сначала экономика, потом игры. Вручную — `recapOpen` в сторе (кошелёк, «Активности»,
   * черновик управляющего в панели экономики). `recapSkipped` — страховка на сессию, если хранилище недоступно.
   */
  const recapCache = useStore((s) => (recountServerId ? s.recaps[recountServerId] : undefined));
  const recapRequested = useStore((s) => s.recapOpen);
  const activitiesOpen = useStore((s) => !!s.activitiesOpen);
  const openRecap = useStore((s) => s.openRecap);
  const [recapSkipped, setRecapSkipped] = useState<string[]>([]);
  useEffect(() => {
    if (!recovering && recountServerId && economyEnabledHere) ensureRecaps(recountServerId);
  }, [recovering, recountServerId, economyEnabledHere]);
  const recapAutoKind = recountServerId
    ? recapAutoQueue(recapCache, (k) => readRecapSeen(recapStorage(), recountServerId, k), Date.now()).find(
        (k) => !recapSkipped.includes(`${recountServerId}:${k}`),
      )
    : undefined;
  // Сцену открывает событие запуска или кнопка в «Активностях».
  const launchRequested = useStore((s) => s.gamesLaunchNotice);
  const closeRecount = () => {
    if (!recountServerId) return;
    const serverId = recountServerId;
    setRecountDismissed((list) => [...list, serverId]);
    const st = useStore.getState();
    const cur = st.economy[serverId];
    if (cur?.recount) st.setEconomy(serverId, { ...cur, recount: undefined });
  };

  /* Раунд 12: лента ЛС в режиме выделения (`dmSelection.ts`) — «назад» на телефоне становится крестиком «Выйти из
     выделения». Без выделения кнопка прежняя. */
  const selecting = useSelectionOpen();
  // Раунд 12, порция 8: открыт вид «Отложенные» беседы — «назад» ведёт к беседе (`schedView.ts`).
  const schedOpen = useSchedViewOpen();

  // Global keyboard shortcuts (round-7 P8). Voice bindings live in VoiceControls; these are the
  // app-wide nav ones + the `?` cheat sheet. Read live state via getState() so the listener,
  // registered once, never goes stale.
  useEffect(() => {
    if (recovering) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

      // Ctrl+Alt+E → стенд эффектов, только супер-админу (#120). Сочетание с Ctrl+Alt выбрано
      // намеренно: браузеры его почти не занимают, а собственных хоткеев на нём у нас нет.
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === 'KeyE') {
        if (useStore.getState().user?.superAdmin) {
          e.preventDefault();
          setBenchOpen((v) => !v);
        }
        return;
      }
      // `?` → toggle the cheat sheet (Shift+/), never while typing. Ctrl+/ (⌘/) — то же, как Keyboard Shortcuts в Discord,
      // и из поля ввода: сочетание с Ctrl текст не печатает. На телефоне шпаргалки нет (`isPhoneUiNow`): там нет клавиатуры,
      // а внешняя к планшету — не повод открывать окно для ПК (группа «Горячие клавиши» в настройках там тоже скрыта).
      const cheatKey =
        (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) ||
        ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Slash');
      if (cheatKey) {
        if (isPhoneUiNow()) return;
        e.preventDefault();
        toggleCheatSheet();
        return;
      }
      // Ctrl/⌘+F → message search (server view only). В ЛС его берёт поиск беседы ленты (G05, `ChatSearch.tsx`, сервер с
      // `search1`); без него — браузерный.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        const s = useStore.getState();
        if (s.view !== 'dm' && s.bootstrap) {
          e.preventDefault();
          s.setSearchOpen(true);
        }
        return;
      }
      /* Соседняя лента (07.10, G14, Telegram 03·1.7.3; одно правило для ЛС и каналов — решение владельца 07.10): Alt+↑/↓ —
         соседняя беседа или текстовый канал списка, Ctrl+Alt+Home/End — первая и последняя; по кругу не ходит. И из поля
         ввода: курсор почти всегда в нём, а у Telegram эти клавиши глобальные. Окно поверх (подтверждение, лист,
         настройки) — не наше. */
      const navKey = feedNavKey(e);
      if (navKey) {
        const s = useStore.getState();
        if (document.querySelector('[aria-modal="true"]')) return;
        if (s.view === 'dm') {
          const id = feedNavTarget(
            s.dms.map((d) => d.id),
            s.currentDmId,
            navKey,
          );
          if (s.dms.length) e.preventDefault();
          if (id) void s.selectDm(id);
          return;
        }
        if (!s.bootstrap) return;
        const ids = orderedTextChannels(s.bootstrap).map((c) => c.id);
        if (ids.length) e.preventDefault();
        const id = feedNavTarget(ids, s.currentChannelId, navKey);
        if (id) void s.openChannel(id);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recovering]);

  const temporaryChannel: Channel | null =
    voice?.temporary && voiceIsHere(voice) && voice.channelId === currentChannelId && voice.serverId === currentServerId
      ? { id: voice.channelId, serverId: voice.serverId ?? '', categoryId: null, name: voice.channelName, type: 'voice',
        position: 0, topic: null, syncedToCategory: false, icon: null, isPrivate: true, generalUserId: null, sounds: {}, voiceBitrate: null }
      : null;
  const channel = bootstrap?.channels.find((c) => c.id === currentChannelId) ?? temporaryChannel;
  const dm = dms.find((d) => d.id === currentDmId) ?? null;
  const isDm = view === 'dm';
  // Число непрочитанного в ДРУГИХ беседах на «Назад» открытой беседы (телефон, G06): тот же источник, что у строк списка.
  const unreadDms = useStore((s) => s.unreadDms);
  const backBadge = isDm && dm ? dmBackBadgeCount(withoutArchived(dms), unreadDms, dm.id) : 0;
  /* Экран вкладки «Профиль» (design-step8 D3) — в телефонной раскладке, а не только в приложении (05.10): в мобильном
     браузере вкладка раньше лишь подсвечивалась. Нативного в нём нет — статус, настройки, админка, выход идут через
     `api` и стор. Шире 760 px его нет: стили экрана живут только в мобильном блоке CSS. */
  const profileShown = phone && mobileProfileOpen;

  /* Отделы ОДНОГО инстанса пересоздаются на каждом переходе (`instanceEpoch`, 01.10): главный экран больше не
     снимается целиком, и окна прежнего инстанса (настройки сервера, приглашение) иначе пережили бы его. Рейл и
     голос (`VoiceConnection`) не пересоздаются — первый общий для всех инстансов, второй принадлежит своему. */
  /* Телефон, вкладка «Серверы» (#218): СПИСОК серверов — пока сервер не выбран или человек вернулся «Назад» из его каналов
     (`serverListOpen`); иначе каналы открытого сервера. Раньше вместо списка была лента квадратов сверху и пустое «Выбери сервер». */
  const serverListShown = phone && !isDm && (serverListOpen || !currentServerId);
  const sidebar = isDm ? (
    <DmSidebar key={`dm${instanceEpoch}`} />
  ) : serverListShown ? (
    <PhoneServerList key={`sl${instanceEpoch}`} />
  ) : (
    <ChannelSidebar key={`ch${instanceEpoch}`} />
  );
  const showMembers = !isDm && !!bootstrap;

  const content = isDm ? (
    <div className="content" key={`dmc${instanceEpoch}`}>
      {/* Телефон: полоса звонка — одна над всем экраном (`CallBar top` ниже), не в ленте. */}
      {!phone && <CallBar />}
      {dmOff ? (
        <div className="empty-goose">
          <Goose pose="look" size={150} />
          <div className="eg-title">Личные сообщения недоступны</div>
          <div className="eg-sub">{DM_SERVER_UPDATE_TEXT}. Каналы и голос работают как обычно.</div>
        </div>
      ) : dm ? (
        <DmChatView key={dm.id} dm={dm} />
      ) : dmListKnown && dms.length === 0 ? (
        /* Бесед нет (раунд 11, HANDOFF §4): на ПК гусь — в главной области, там есть место; список слева пуст и без
           поиска. На телефоне гусь в самом списке (`DmSidebar`). Гостю писать некому вовсе — его подпись и без кнопки. */
        <div className="empty-goose">
          <Goose pose="wave" size={150} />
          <div className="eg-title">Бесед пока нет</div>
          <div className="eg-sub">
            {me?.homeInstance ? dmEmptyHint(me.homeInstance) : 'Напишите кому-нибудь — беседа появится в списке слева.'}
          </div>
          {!me?.homeInstance && (
            <button type="button" className="dm-start" onClick={() => openDmCompose()}>
              <Icon name="edit" size={18} />
              Написать
            </button>
          )}
        </div>
      ) : (
        <div className="center muted">Выбери диалог</div>
      )}
    </div>
  ) : (
    <div className="content" key={`c${instanceEpoch}`}>
      {!phone && <CallBar />}
      {!channel && (switching && !bootstrap ? <div className="center" /> : <div className="center muted">Выбери канал</div>)}
      {channel?.type === 'text' && <ChatView key={channel.id} channel={channel} />}
      {channel?.type === 'voice' && <VoiceChannelView channel={channel} connected={voice?.channelId === channel.id} />}
    </div>
  );

  /** «Назад» экрана беседы на телефоне: стрелка в шапке и свайп вправо по экрану (G16, `useSwipeBack`) — одно и то же. */
  const goBack = () => {
    if (selecting && exitSelection()) return;
    // Поиск в беседе (G05): «назад» сначала закрывает его, как у Telegram Android.
    if (exitChatSearch()) return;
    if (schedOpen && backFromSchedView()) return;
    setMobilePane('list');
  };
  useSwipeBack(!recovering && phone && mobilePane === 'content' && (isDm ? !!dm : channel?.type === 'text'), goBack);

  const appClass = ['app', `m-${mobilePane}`];
  if (showMembers) appClass.push('has-members');
  if (voice) appClass.push('in-voice');
  if (showMembers && mobileMembersOpen) appClass.push('m-members-open');
  // Mobile: viewing the voice channel you're connected to = a full-screen call (design-step8 B1). The
  // call bar owns the bottom, so hide the tab bar (CSS) — no double bottom bars.
  if (voice && mobilePane === 'content' && currentChannelId === voice.channelId) appClass.push('m-incall');
  // Телефон: открыта переписка — панель вкладок прячется, как у Telegram (#212, CSS `.app.m-chat`).
  if (mobilePane === 'content' && (isDm ? !!dm : channel?.type === 'text')) appClass.push('m-chat');
  // Телефон: лента серверов сверху — только на вкладке «Серверы» (решение 04.10, макет раунда 11 `ListPhone`). На
  // «Сообщениях» и в «Профиле» её нет, место отдаётся списку бесед и профилю (CSS `.app.m-norail`; ПК не трогает).
  if (isDm || profileShown) appClass.push('m-norail');
  // Телефон: список бесед прокручивается под стеклянной капсулой вкладок, как у Telegram Android (#218, CSS `.app.m-dmlist`).
  if (isDm && mobilePane === 'list') appClass.push('m-dmlist');
  // С #218 ленты серверов сверху нет и на «Серверах» — вместо неё список серверов строками (`PhoneServerList`) и «Назад» в каналах:
  // рейл растворяется тем же правилом, что при `m-norail` (CSS `.app.m-list.m-srvlist > .rail`).
  if (!isDm && !profileShown) appClass.push('m-srvlist');
  // Ворота показа: гусь не лезет поверх настроек, админки, шпаргалки и тыка — и только в голосе,
  // потому что предложение выдаётся ровно сидящим в канале.
  // Карточка перерасчёта — не поверх другого окна (настройки, админка, шпаргалка, приветствие, тык, стенд).
  const recountOpen =
    !!recount && !welcomeOpen && !settingsOpen && !adminOpen && !cheatOpen && !benchOpen && !incomingPoke;
  // «Итоги» сами — не поверх другого окна, перерасчёта и открытых «Активностей»; вручную — всегда.
  const recapAutoAllowed =
    !recount && !welcomeOpen && !settingsOpen && !adminOpen && !cheatOpen && !benchOpen && !incomingPoke && !activitiesOpen;
  const recapShown =
    recapRequested ??
    (recapAutoKind && recountServerId && recapAutoAllowed ? { serverId: recountServerId, kind: recapAutoKind, auto: true } : null);
  const closeRecap = () => {
    if (recapShown?.auto) setRecapSkipped((list) => [...list, `${recapShown.serverId}:${recapShown.kind}`]);
    openRecap(null);
  };
  // Карточка запуска игр — не поверх другого окна, перерасчёта, «Итогов» и открытых «Активностей».
  const launchHosted = !!launchRequested && recapAutoAllowed && !recapShown;
  const goosePresentationAllowed =
    !recountOpen &&
    !recapShown &&
    !launchRequested &&
    !!voice &&
    !settingsOpen &&
    !adminOpen &&
    !cheatOpen &&
    !welcomeOpen &&
    !mobileMembersOpen &&
    !mobileProfileOpen &&
    !incomingPoke;

  // Сосед продолжает обслуживать голос, пока мы проверяем другой инстанс.
  // Одинаковые родитель и ключ сохраняют комнату при показе экрана подключения и возврате к каналам.
  if (recovering) {
    if (!voice) return <>{connectionScreen}</>;
    return (
      <div>
        <VoiceConnection key="channel-voice">{connectionScreen}</VoiceConnection>
      </div>
    );
  }

  return (
    <div className={appClass.join(' ')}>
      {phone && <CallBar top />}
      <ServerRail />
      {/* The voice connection persists across channel/DM navigation and provides the LiveKit
          RoomContext to BOTH the sidebar (its VoicePanel) and the content (the voice stage). */}
      {voice ? (
        <VoiceConnection key="channel-voice">
          {sidebar}
          <SidebarResizer />
          {content}
        </VoiceConnection>
      ) : (
        <>
          {sidebar}
          <SidebarResizer />
          {content}
        </>
      )}
      {showMembers && <ServerMembersPanel key={`m${instanceEpoch}`} />}
      {/* Mobile: a back affordance to return from an open chat/voice to the list pane. Раунд 12: в режиме выделения ленты
          ЛС — крестик «Выйти из выделения» на том же месте (макет `Phone`, `.mobile-back` с `close`); в виде «Отложенные»
          (порция 8) — та же стрелка, но «К беседе» (макет `Phone` с `screen=sched`). */}
      <button
        type="button"
        className="mobile-back"
        title={selecting ? 'Выйти из выделения' : schedOpen ? 'К беседе' : 'Назад'}
        aria-label={selecting ? 'Выйти из выделения' : schedOpen ? 'К беседе' : undefined}
        onClick={goBack}
      >
        <Icon name={selecting ? 'close' : 'chevron-left'} size={22} />
        {backBadge > 0 && !selecting && !schedOpen && (
          <span className="mobile-back-badge" title={`Непрочитанных в других беседах: ${backBadge}`}>
            {dmBackBadgeLabel(backBadge)}
          </span>
        )}
      </button>
      {/* Mobile: open the members list as a right-hand slide-over (it's hidden in the grid below 760px). */}
      {showMembers && (
        <button
          type="button"
          className="mobile-members-btn"
          title="Участники"
          onClick={() => setMobileMembersOpen(true)}
        >
          <Icon name="users" size={20} />
        </button>
      )}
      {mobileMembersOpen && <div className="members-backdrop" onClick={() => setMobileMembersOpen(false)} />}
      {/* Mobile B3: the single minimized call surface above the tab bar (replaces VoicePanel + SelfVoiceBar
          on mobile). Only while connected and not already looking at the full call view.
          06.10: и в телефонной раскладке браузера (`phone`, ≤ 760 px — мобильный браузер и узкое окно ПК): мобильные стили
          прячут там `VoicePanel` и `SelfVoiceBar`, а плашка была только в приложении — в звонке на экране списка не
          оставалось ничего о звонке. `isMobile()` остаётся: приложение показывает её, как раньше, при любой ширине. */}
      {(isMobile() || phone) && voice && mobilePane === 'list' && !mobileProfileOpen && <MobileCallChip />}
      {profileShown && <MobileProfile />}
      <MobileNav />
      {settingsOpen && <UserSettingsModal onClose={() => setSettingsOpen(false)} onOpenCheatSheet={openCheatSheet} />}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
      {cheatOpen && <HotkeyCheatSheet onClose={closeCheatSheet} />}
      <ChatSwitchHost />
      <ContactEditHost />
      <DesktopKeysHost />
      {welcomeOpen && (
        <EconomyWelcome
          onClose={() => {
            setWelcomeDismissed(true);
            setWelcomeRequested(false);
          }}
        />
      )}
      {recountOpen && recount && (
        <RecountNotice
          amount={recount.amount}
          currencyName={recountView?.currencyName || 'ГусКоины'}
          iconUrl={recountView?.iconUrl ?? null}
          seasonName={recountView?.season?.id === recount.seasonId ? recountView.season.name : undefined}
          markSeenOn={recountServerId ?? undefined}
          onClose={closeRecount}
        />
      )}
      {recapShown && (
        <Suspense fallback={null}>
          <RecapScene key={`${recapShown.serverId}:${recapShown.kind}:${recapShown.periodId ?? ''}:${recapShown.preview ? 1 : 0}`} open={recapShown} onClose={closeRecap} />
        </Suspense>
      )}
      {launchHosted && (
        <Suspense fallback={null}>
          <GamesLaunchHost />
        </Suspense>
      )}
      {/* Тык — поверх ВСЕГО, включая открытые настройки: его смысл в том, чтобы заметили сразу. */}
      <PokeModal />
      {/* Звонок 1:1 в ЛС (С5, `calls1`): входящий и экран звонка — поверх всего, как тык; медиа звонка живёт здесь же. */}
      <CallLayer />
      <GooseBonusHost presentationAllowed={goosePresentationAllowed} />
      {/* «Активности» голоса и сцена колеса гусей-пиратов (ГусКоины 2): открытое живёт в сторе, кнопки — в доке голоса. */}
      <ActivitiesHost />
      {/* ⚠️ Здесь, а НЕ в оверлее: оверлей висит поверх чужой игры, и осыпание там — оплаченная
          помеха человеку в бою. Оверлей рендерит свой корень, поэтому граница держится структурно. */}
      <FeatherLayer />
      {/* «Большая» реакция в ЛС (G43): крупный эмодзи поверх ленты — та же шина эффектов, что у перьев. */}
      <BigReactionLayer />
      {benchOpen && <EffectsBench onClose={() => setBenchOpen(false)} />}
      {/* «Сервер закрыт держателем» — рядом с тыком и по той же причине: человека только что
          выставили с сервера, и узнать об этом он должен сразу, а не открыв настройки. */}
      <ServerClosedModal />
      <ImageViewerHost />
      <ToastHost />
    </div>
  );
}
