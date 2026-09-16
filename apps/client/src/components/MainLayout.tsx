import type { Channel, ServerBootstrap } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { isMobile } from '../hotkeys';
import { useStore } from '../store';
import { AdminPanel } from './AdminPanel';
import { ChannelSidebar } from './ChannelSidebar';
import { MobileCallChip } from './MobileCallChip';
import { MobileProfile } from './MobileProfile';
import { ChatView } from './ChatView';
import { DmChatView } from './DmChatView';
import { DmSidebar } from './DmSidebar';
import { EconomyWelcome } from './EconomyWelcome';
import { FeatherLayer } from './FeatherLayer';
import { EffectsBench } from './EffectsBench';
import { GooseBonusHost } from './GooseBonusHost';
import { HotkeyCheatSheet } from './HotkeyCheatSheet';
import { Icon } from './Icon';
import { ImageViewerHost } from './ImageViewerHost';
import { MobileNav } from './MobileNav';
import { ServerMembersPanel } from './ServerMembersPanel';
import { ServerRail } from './ServerRail';
import { SidebarResizer } from './SidebarResizer';
import { PokeModal } from './PokeModal';
import { ToastHost } from './ToastHost';
import { UserSettingsModal } from './UserSettingsModal';
import { VoiceChannelView } from './VoiceChannelView';
import { VoiceConnection } from './VoiceConnection';

/** Channels in sidebar order (uncategorized first, then categories by position), text only. */
function orderedTextChannels(b: ServerBootstrap): Channel[] {
  const cats = [...b.categories].sort((a, z) => a.position - z.position);
  const inCat = (catId: string | null) =>
    b.channels
      .filter((c) => c.type === 'text' && (c.categoryId ?? null) === catId)
      .sort((a, z) => a.position - z.position);
  return [...inCat(null), ...cats.flatMap((c) => inCat(c.id))];
}

export function MainLayout() {
  const [cheatOpen, setCheatOpen] = useState(false);
  // Стенд эффектов (#120): Ctrl+Alt+E, только супер-админу. Ничего не шлёт на сервер.
  const [benchOpen, setBenchOpen] = useState(false);
  const bootstrap = useStore((s) => s.bootstrap);
  const currentChannelId = useStore((s) => s.currentChannelId);
  const voice = useStore((s) => s.voice);
  const view = useStore((s) => s.view);
  const dms = useStore((s) => s.dms);
  const currentDmId = useStore((s) => s.currentDmId);
  const mobilePane = useStore((s) => s.mobilePane);
  const setMobilePane = useStore((s) => s.setMobilePane);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const adminOpen = useStore((s) => s.adminOpen);
  const setAdminOpen = useStore((s) => s.setAdminOpen);
  const mobileMembersOpen = useStore((s) => s.mobileMembersOpen);
  const setMobileMembersOpen = useStore((s) => s.setMobileMembersOpen);
  const mobileProfileOpen = useStore((s) => s.mobileProfileOpen);
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

  // Global keyboard shortcuts (round-7 P8). Voice bindings live in VoiceControls; these are the
  // app-wide nav ones + the `?` cheat sheet. Read live state via getState() so the listener,
  // registered once, never goes stale.
  useEffect(() => {
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
      // `?` → toggle the cheat sheet (Shift+/), never while typing.
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setCheatOpen((v) => !v);
        return;
      }
      // Ctrl/⌘+F → message search (server view only; lets the browser keep find on DMs).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        const s = useStore.getState();
        if (s.view !== 'dm' && s.bootstrap) {
          e.preventDefault();
          s.setSearchOpen(true);
        }
        return;
      }
      // Alt+↑/↓ → previous / next text channel (no wrap), never while typing.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !typing && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
        const s = useStore.getState();
        if (s.view === 'dm' || !s.bootstrap) return;
        const list = orderedTextChannels(s.bootstrap);
        if (list.length === 0) return;
        const idx = list.findIndex((c) => c.id === s.currentChannelId);
        const next = list[Math.max(0, Math.min(list.length - 1, (idx < 0 ? 0 : idx) + (e.code === 'ArrowDown' ? 1 : -1)))];
        if (next && next.id !== s.currentChannelId) {
          e.preventDefault();
          void s.openChannel(next.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const channel = bootstrap?.channels.find((c) => c.id === currentChannelId) ?? null;
  const dm = dms.find((d) => d.id === currentDmId) ?? null;
  const isDm = view === 'dm';

  const sidebar = isDm ? <DmSidebar /> : <ChannelSidebar />;
  const showMembers = !isDm && !!bootstrap;

  const content = isDm ? (
    <div className="content">
      {dm ? <DmChatView key={dm.id} dm={dm} /> : <div className="center muted">Выбери диалог</div>}
    </div>
  ) : (
    <div className="content">
      {!channel && <div className="center muted">Select a channel</div>}
      {channel?.type === 'text' && <ChatView key={channel.id} channel={channel} />}
      {channel?.type === 'voice' && <VoiceChannelView channel={channel} connected={voice?.channelId === channel.id} />}
    </div>
  );

  const appClass = ['app', `m-${mobilePane}`];
  if (showMembers) appClass.push('has-members');
  if (voice) appClass.push('in-voice');
  if (showMembers && mobileMembersOpen) appClass.push('m-members-open');
  // Mobile: viewing the voice channel you're connected to = a full-screen call (design-step8 B1). The
  // call bar owns the bottom, so hide the tab bar (CSS) — no double bottom bars.
  if (voice && mobilePane === 'content' && currentChannelId === voice.channelId) appClass.push('m-incall');
  // Ворота показа: гусь не лезет поверх настроек, админки, шпаргалки и тыка — и только в голосе,
  // потому что предложение выдаётся ровно сидящим в канале.
  const goosePresentationAllowed =
    !!voice &&
    !settingsOpen &&
    !adminOpen &&
    !cheatOpen &&
    !welcomeOpen &&
    !mobileMembersOpen &&
    !mobileProfileOpen &&
    !incomingPoke;

  return (
    <div className={appClass.join(' ')}>
      <ServerRail />
      {/* The voice connection persists across channel/DM navigation and provides the LiveKit
          RoomContext to BOTH the sidebar (its VoicePanel) and the content (the voice stage). */}
      {voice ? (
        <VoiceConnection>
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
      {showMembers && <ServerMembersPanel />}
      {/* Mobile: a back affordance to return from an open chat/voice to the list pane. */}
      <button type="button" className="mobile-back" title="Назад" onClick={() => setMobilePane('list')}>
        <Icon name="chevron-left" size={22} />
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
          on mobile). Only while connected and not already looking at the full call view. */}
      {isMobile() && voice && mobilePane === 'list' && !mobileProfileOpen && <MobileCallChip />}
      {isMobile() && mobileProfileOpen && <MobileProfile />}
      <MobileNav />
      {settingsOpen && <UserSettingsModal onClose={() => setSettingsOpen(false)} />}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
      {cheatOpen && <HotkeyCheatSheet onClose={() => setCheatOpen(false)} />}
      {welcomeOpen && (
        <EconomyWelcome
          onClose={() => {
            setWelcomeDismissed(true);
            setWelcomeRequested(false);
          }}
        />
      )}
      {/* Тык — поверх ВСЕГО, включая открытые настройки: его смысл в том, чтобы заметили сразу. */}
      <PokeModal />
      <GooseBonusHost presentationAllowed={goosePresentationAllowed} />
      {/* ⚠️ Здесь, а НЕ в оверлее: оверлей висит поверх чужой игры, и осыпание там — оплаченная
          помеха человеку в бою. Оверлей рендерит свой корень, поэтому граница держится структурно. */}
      <FeatherLayer />
      {benchOpen && <EffectsBench onClose={() => setBenchOpen(false)} />}
      <ImageViewerHost />
      <ToastHost />
    </div>
  );
}
