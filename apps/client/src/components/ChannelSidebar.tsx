import type { Channel } from '@gusvoice/shared';
import { has, Permission, permsFromString } from '@gusvoice/shared';
import { Fragment, useRef, useState } from 'react';
import { api } from '../api';
import { toggleCategoryCollapse, useCollapsedCategories, useMutedChannels } from '../channelPrefs';
import { useNameResolver } from '../memberName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { CrownMark, crownGlow, useCrownId } from './Crown';
import { hintsFor } from '../tipHints';
import { useAltHeld, useTip } from '../tipGesture';
import { canTipRow } from '../tipMode';
import { useAnimatedAvatarUrl } from '../avatarAnimation';
import { ChannelGlyph, Icon } from './Icon';
import { ChannelTimer } from './ChannelTimer';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { CoinChip } from './CoinChip';
import { CreateChannelModal } from './CreateChannelModal';
import { MembersRolesModal } from './MembersRolesModal';
import { SearchModal } from './SearchModal';
import { InviteCodeModal } from './ServerActionModals';
import { ServerSettingsModal } from './ServerSettingsModal';
import { config } from '../config';
import { canOpenServerSettings } from '../serverSettingsTabs';
import { SelfVoiceBar } from './SelfVoiceBar';
import { VoicePanel } from './VoicePanel';
import { useChannelContextMenu } from './ChannelContextMenu';
import { useStreamPreview } from './StreamPreviewTip';
import { useUserMenu } from './UserContextMenu';
import { BottomSheet, SheetRow } from './BottomSheet';
import { isMobile } from '../hotkeys';
import type { DropHint } from '../channelSidebarRules';
import { computeReorder, dropHintForRow, rowClickOpensCard } from '../channelSidebarRules';
import { economyVisible } from '../economyVisible';

export function ChannelSidebar() {
  const bootstrap = useStore((s) => s.bootstrap);
  // Корону берём ОДИН раз на компонент: хук нельзя звать внутри списка участников.
  const crownId = useCrownId(bootstrap?.server.id);
  // Подсказки «кто кого типнул» — живут в сторе и гаснут сами (#117).
  const tipHints = useStore((s) => s.tipHints);
  // Анимация аватара: одна подписка на компонент, годная внутри `map` (хук туда нельзя).
  const animatedOf = useAnimatedAvatarUrl();
  const currentChannelId = useStore((s) => s.currentChannelId);
  const openChannel = useStore((s) => s.openChannel);
  const enterVoiceChannel = useStore((s) => s.enterVoiceChannel);
  const voice = useStore((s) => s.voice);
  const presence = useStore((s) => s.presence);
  const nameOf = useNameResolver();
  const liveVoice = useStore((s) => s.liveVoice);
  const occupancy = useStore((s) => s.occupancy);
  const selfMuted = useStore((s) => s.selfMuted);
  const selfDeafened = useStore((s) => s.selfDeafened);
  const unreadCounts = useStore((s) => s.unreadCounts);
  const mentionCounts = useStore((s) => s.mentionCounts);
  const user = useStore((s) => s.user);
  const patchChannels = useStore((s) => s.patchChannels);
  const pushMutedServers = useStore((s) => s.pushMutedServers);
  const setPushMuted = useStore((s) => s.setPushMuted);
  const { open: openUserMenu, menu: userMenu } = useUserMenu();
  // Превью показа по наведению (#115) — работает и когда ты не в этом канале.
  const { enter: previewEnter, leave: previewLeave, open: previewOpen, node: previewTip } = useStreamPreview();
  const { openChannelMenu, openCategoryMenu, menus: channelMenus } = useChannelContextMenu();
  const collapsedCats = useCollapsedCategories();
  const mutedChannels = useMutedChannels();
  const refreshBootstrap = useStore((s) => s.refreshBootstrap);
  // Pointer-events drag-and-drop (more reliable than native HTML5 DnD in WebView, and
  // touch-ready). `drag` drives the visuals; the refs hold the live values the
  // pointer handlers read without waiting for a re-render.
  const [drag, setDrag] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  // Channel drag is LOCKED by default — a manager taps the lock to arm it, so channels never reorder by
  // accident. Resets to locked on unmount / server switch (state lives with the sidebar).
  const [dragUnlocked, setDragUnlocked] = useState(false);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const pending = useRef<{ id: string; name: string; x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const dropHintRef = useRef<DropHint | null>(null);
  const suppressClick = useRef(false);
  // Separate pointer-DnD for dragging a voice participant from one voice channel to another
  // (MOVE_MEMBERS). Drop targets are voice-channel blocks tagged with data-vc.
  const [pdrag, setPdrag] = useState<{ userId: string; name: string; from: string; x: number; y: number } | null>(null);
  const [pDrop, setPDrop] = useState<string | null>(null);
  const pPending = useRef<{ userId: string; name: string; from: string; x: number; y: number } | null>(null);
  const pDragging = useRef(false);
  const pDropRef = useRef<string | null>(null);
  /** Только что тащили участника — следующий `click` по строке не наш (см. `onPpUp`). */
  const pClickAfterDrag = useRef(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const showSearch = useStore((s) => s.searchOpen);
  const setShowSearch = useStore((s) => s.setSearchOpen);
  const [showInvite, setShowInvite] = useState(false);
  const [showMore, setShowMore] = useState(false); // mobile "⋯ More" bottom-sheet (design-step8 A3)
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  // 🔴 Жест «тип» в САЙДБАРЕ (решение 03.09): зажатый Alt обводит ники рамкой, Alt+ЛКМ по нику
  // отправляет. Сцена остаётся как была — там кнопка на плитке. Состояние Alt и отправка общие
  // (`tipGesture.ts`): два независимых слушателя разъехались бы на Alt+Tab.
  const economyHere = useStore((s) => (s.bootstrap ? s.economy[s.bootstrap.server.id] : undefined));
  // ⚠️ Мобильная раскладка Alt не знает вовсе — там жест живёт удержанием плитки на сцене.
  const tipAlt = useAltHeld(economyHere?.enabled === true && !isMobile());
  const { tip: sendTip, busyId: tipBusyId } = useTip();

  if (!bootstrap) {
    return (
      <div className="channels">
        <div className="center muted">Выбери сервер</div>
        {voice && <VoicePanel />}
        <SelfVoiceBar />
      </div>
    );
  }

  const perms = permsFromString(bootstrap.permissions);
  const canManage = has(perms, Permission.MANAGE_CHANNELS);
  const canManageSounds = has(perms, Permission.MANAGE_SOUNDS);
  // Назначать «генерала» канала — действие владельца/MANAGE_SERVER, и вкладка «Генерал» внутри
  // настроек канала открыта ему же. Без этого условия вход был УЖЕ содержимого: право есть,
  // а кнопки настроек канала нет.
  const canManageServer = has(perms, Permission.MANAGE_SERVER);
  // Оверрайды канала («Доступ») требуют MANAGE_ROLES — значит и вход в настройки канала.
  const canEditOverwrites = has(perms, Permission.MANAGE_ROLES);
  const canMoveMembers = has(perms, Permission.MOVE_MEMBERS);
  const canInvite = has(perms, Permission.CREATE_INVITE);
  // 🔴 Пункт «Настройки сервера» показываем, если доступна ХОТЬ ОДНА вкладка внутри, а не по
  // MANAGE_SERVER: иначе участник с правом только на эмодзи/стикеры/звуки/баны видит вкладку,
  // до которой не может добраться — пункта меню у него просто нет.
  // Флаги ИНСТАНСА, а не права: экономика выключена на инстансе — вкладки «Монеты» нет ни у кого,
  // и пункт меню не должен из-за неё открываться (#117).
  const canServerSettings = canOpenServerSettings(perms, {
    economy: economyVisible(user?.economyPreview, config.economyEnabled === true),
  });
  const canManageRoles = has(perms, Permission.MANAGE_ROLES);
  const canKick = has(perms, Permission.KICK_MEMBERS);
  const canDeleteServer = !!user && (user.superAdmin || bootstrap.server.ownerId === user.id);
  // Personal push-mute for this server's @mentions (account-wide, any member) — see #117.
  const serverPushMuted = pushMutedServers.includes(bootstrap.server.id);
  const toggleServerPush = () =>
    setPushMuted('server', bootstrap.server.id, !serverPushMuted).catch(toastError);

  const channelsByCat = (catId: string | null): Channel[] =>
    bootstrap.channels.filter((c) => c.categoryId === catId).sort((a, b) => a.position - b.position);

  // --- drag-and-drop channel reorder / re-parent (MANAGE_CHANNELS only) ---
  const serverId = bootstrap.server.id;

  function setHint(next: DropHint | null) {
    const cur = dropHintRef.current;
    if (cur === next) return; // обе null
    if (cur && next && cur.cat === next.cat && cur.before === next.before) return; // no-op → no re-render
    dropHintRef.current = next;
    setDropHint(next);
  }

  function endDrag() {
    pending.current = null;
    dragging.current = false;
    dropHintRef.current = null;
    setDrag(null);
    setDropHint(null);
  }

  // Resolve the drop target under the pointer: a channel row (top/bottom half → before/
  // after it), a group's empty space (→ end of group), or a category header (→ its top).
  function resolveHint(x: number, y: number, draggedId: string) {
    const at = document.elementFromPoint(x, y);
    if (!at) return;
    const row = at.closest('[data-ch]') as HTMLElement | null;
    if (row) {
      const catId = row.dataset.cat === '' ? null : (row.dataset.cat ?? null);
      const rect = row.getBoundingClientRect();
      // Над собственной строкой `dropHintForRow` вернёт null — и подсказку надо ПОГАСИТЬ, а не
      // просто выйти: иначе отпускание применит цель от предыдущей строки (#94).
      setHint(
        dropHintForRow({
          draggedId,
          targetId: row.dataset.ch!,
          targetCat: catId,
          after: y > rect.top + rect.height / 2,
          orderedIds: channelsByCat(catId).map((c) => c.id),
        }),
      );
      return;
    }
    const header = at.closest('[data-catheader]') as HTMLElement | null;
    if (header) {
      const catId = header.dataset.catheader === '' ? null : (header.dataset.catheader ?? null);
      setHint({ cat: catId, before: channelsByCat(catId)[0]?.id ?? null });
      return;
    }
    const zone = at.closest('[data-catzone]') as HTMLElement | null;
    if (zone) {
      const catId = zone.dataset.catzone === '' ? null : (zone.dataset.catzone ?? null);
      setHint({ cat: catId, before: null });
    }
  }

  function onRowPointerDown(e: React.PointerEvent, c: Channel) {
    if (!canManage || !dragUnlocked || e.button !== 0) return;
    if (e.pointerType === 'touch') return; // touch = scroll/tap; touch-drag is a mobile (#26) follow-up
    if ((e.target as Element).closest('.ch-edit')) return; // let the settings button work
    pending.current = { id: c.id, name: c.name, x: e.clientX, y: e.clientY };
    dragging.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onRowPointerMove(e: React.PointerEvent) {
    const p = pending.current;
    if (!p) return;
    if (!dragging.current) {
      if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 6) return; // not a drag yet
      dragging.current = true;
    }
    setDrag({ id: p.id, name: p.name, x: e.clientX, y: e.clientY });
    resolveHint(e.clientX, e.clientY, p.id);
  }

  function onRowPointerUp(e: React.PointerEvent) {
    const p = pending.current;
    const wasDragging = dragging.current;
    const hint = dropHintRef.current;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    endDrag();
    if (!p || !wasDragging) return;
    suppressClick.current = true; // the trailing click must not open the channel
    if (!hint) return;
    const updates = computeReorder(bootstrap!.channels, p.id, hint.cat, hint.before);
    if (!updates.length) return;
    patchChannels(updates); // instant feedback; server.invalidate reconciles
    api
      .reorderChannels(
        serverId,
        updates.map((u) => ({ channelId: u.id, categoryId: u.categoryId, position: u.position })),
      )
      .catch((err) => {
        toastError(err);
        void refreshBootstrap(serverId);
      });
  }

  function setPDropTarget(id: string | null) {
    if (pDropRef.current === id) return; // dedupe → no re-render
    pDropRef.current = id;
    setPDrop(id);
  }

  function onPpDown(e: React.PointerEvent, userId: string, name: string, from: string) {
    if (!canMoveMembers || e.button !== 0) return;
    // 🔴 С зажатым Alt строка НЕ начинает перетаскивание. Дело не только в том, что жест занят
    // типом: `setPointerCapture` ниже уводит последующий `click` на саму строку, и клик по нику
    // просто не дошёл бы до рамки. У кого нет MOVE_MEMBERS, захвата и так нет — баг был бы виден
    // только у модераторов.
    if (e.altKey) return;
    if (e.pointerType === 'touch') return; // touch-drag is a mobile follow-up (#26)
    pPending.current = { userId, name, from, x: e.clientX, y: e.clientY };
    pDragging.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPpMove(e: React.PointerEvent) {
    const p = pPending.current;
    if (!p) return;
    if (!pDragging.current) {
      if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 6) return;
      pDragging.current = true;
    }
    setPdrag({ ...p, x: e.clientX, y: e.clientY });
    const at = document.elementFromPoint(e.clientX, e.clientY);
    const vc = (at?.closest('[data-vc]') as HTMLElement | null)?.dataset.vc ?? null;
    setPDropTarget(vc && vc !== p.from ? vc : null);
  }

  function onPpUp(e: React.PointerEvent) {
    const p = pPending.current;
    const wasDragging = pDragging.current;
    const target = pDropRef.current;
    // 🔴 Замерено на стенде: строка держит `setPointerCapture`, поэтому браузер шлёт ей `click` и
    // ПОСЛЕ перетаскивания — палец отпущен над другим каналом, а целью осталась она. Без этой
    // отметки карточка человека открывалась бы на каждый перенос участника модератором.
    pClickAfterDrag.current = wasDragging;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    pPending.current = null;
    pDragging.current = false;
    pDropRef.current = null;
    setPdrag(null);
    setPDrop(null);
    if (!p || !wasDragging || !target || target === p.from) return;
    // Optimism is handled by presence gateway events; just fire the move.
    api.voiceMove(p.from, p.userId, target).catch((err) => toastError(err));
  }

  function clickChannel(c: Channel) {
    if (c.type !== 'voice') {
      openChannel(c.id);
      return;
    }
    // «Зайти, если ещё не там, и показать канал» живёт в сторе одной функцией: тем же путём ходит
    // клик «зайти и смотреть» в карточке наведения, и двум копиям тут разъезжаться незачем.
    enterVoiceChannel(c.id).catch((e: Error) => toastError(e));
  }

  const renderChannel = (c: Channel) => {
    const here = presence[c.id] ?? [];
    const isVoice = c.type === 'voice';
    return (
      <div
        key={c.id}
        className={`${isVoice ? 'vc-block' : ''}${isVoice && pDrop === c.id ? ' vc-droptarget' : ''}`.trim() || undefined}
        data-vc={isVoice ? c.id : undefined}
      >
        <div
          className={`channel ${c.id === currentChannelId ? 'active' : ''} ${
            (unreadCounts[c.id] ?? 0) > 0 && !mutedChannels.has(c.id) && c.id !== currentChannelId ? 'unread' : ''
          } ${mutedChannels.has(c.id) ? 'muted' : ''} ${canManage && dragUnlocked ? 'draggable' : ''} ${
            drag?.id === c.id ? 'dragging' : ''
          }`}
          data-ch={c.id}
          data-cat={c.categoryId ?? ''}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            clickChannel(c);
          }}
          onContextMenu={(e) => openChannelMenu(e, c)}
          onPointerDown={(e) => onRowPointerDown(e, c)}
          onPointerMove={onRowPointerMove}
          onPointerUp={onRowPointerUp}
        >
          <span className="ch-icon">
            <ChannelGlyph c={c} size={18} />
          </span>
          <span className="ch-name">{c.name}</span>
          {/* 🔴 Показываем по ВСЕМ занятым каналам, а не только по своему (требование 02.09).
              Поэтому источник — присутствие: оно приходит по всем каналам, которые человеку видно,
              даже когда он не в голосе вовсе. Зелёные обводки для этого не годятся принципиально —
              `liveVoice` существует только для канала, в котором ты сидишь. */}
          {isVoice && occupancy[c.id] ? <ChannelTimer occupancy={occupancy[c.id]} /> : null}
          {/* Mobile (design-step8 A): an explicit honey "Войти" button on voice channels you're not in. */}
          {isVoice && isMobile() && voice?.channelId !== c.id && (
            <button
              className="ch-join"
              title="Войти в голосовой канал"
              onClick={(e) => {
                e.stopPropagation();
                clickChannel(c);
              }}
            >
              Войти
            </button>
          )}
          {/* Приоритет за упоминаниями: красный бейдж с их числом. Иначе — число непрочитанных
              медовым (#78; сервер его и так присылает, раньше клиент схлопывал в точку).
              Заглушённый канал не показывает ничего — иначе «заглушить» теряет смысл. */}
          {c.id !== currentChannelId && (mentionCounts[c.id] ?? 0) > 0 ? (
            <span className="ch-mention">{(mentionCounts[c.id] ?? 0) > 99 ? '99+' : mentionCounts[c.id]}</span>
          ) : (unreadCounts[c.id] ?? 0) > 0 && !mutedChannels.has(c.id) && c.id !== currentChannelId ? (
            <span className="ch-unread">{(unreadCounts[c.id] ?? 0) > 99 ? '99+' : unreadCounts[c.id]}</span>
          ) : null}
          {(canManage || canEditOverwrites || (isVoice && (canManageServer || canManageSounds || c.generalUserId === user?.id))) && (
            <button
              className="ch-edit"
              title="Настройки канала"
              onClick={(e) => {
                e.stopPropagation();
                setEditingChannel(c);
              }}
            >
              <Icon name="edit" size={14} />
            </button>
          )}
        </div>
        {c.type === 'voice' && here.length > 0 && (
          <ul className="ch-presence">
            {here.map((p) => {
              // Live state (instant) for the channel you're in; else the presence snapshot.
              // For our OWN row use the stable store self-state — presence/live flicker to "muted"
              // for a moment while the room reconnects on a channel switch (the #5 flash).
              const live = liveVoice[p.userId];
              const isMe = p.userId === user?.id;
              // Presence приходит от отдельного сервиса и про ники не знает — подставляем из
              // ростера здесь же, иначе сайдбар остаётся с обычным именем (#73).
              const pname = nameOf(p.userId, p.displayName);
              const speaking = live?.speaking ?? false;
              const muted = isMe ? selfMuted : live ? live.muted : p.muted;
              const deafened = isMe ? selfDeafened : live ? live.deafened : p.deafened;
              const screensharing = live ? live.screensharing : p.screensharing;
              // 🔴 Рамку даём только тем, кого ДЕЙСТВИТЕЛЬНО можно типнуть: сервер требует, чтобы
              // оба сидели в ЭТОМ канале (`tipRules`), поэтому обводка на человеке из соседнего
              // канала или на себе была бы обещанием отказа. Рамка = «сюда попадёшь».
              const canTip = canTipRow(tipAlt, isMe, voice?.channelId ?? null, c.id);
              return (
                <li
                  key={p.userId}
                  // Метка для карточки: по ней слушатель «нажали мимо» узнаёт строку того же
                  // человека и не гасит закреплённую карточку раньше её собственного onClick.
                  data-pp={p.userId}
                  className={`${canMoveMembers ? 'pp-draggable' : ''} ${pdrag?.userId === p.userId ? 'pp-dragging' : ''}`}
                  onContextMenu={(e) =>
                    openUserMenu(e, {
                      userId: p.userId,
                      name: pname,
                      avatarUrl: p.avatarUrl,
                      voiceChannelId: c.id,
                      micMuted: muted,
                      serverMuted: p.serverMuted,
                    })
                  }
                  onPointerDown={(e) => onPpDown(e, p.userId, pname, c.id)}
                  onPointerMove={onPpMove}
                  onPointerUp={onPpUp}
                  // Превью показа (#115). Вешаем на ВСЮ строку, а не на иконку: попасть мышкой в
                  // значок 14 px труднее, чем навести на человека, а смысл наводки тот же.
                  onMouseEnter={
                    screensharing
                      ? (e) =>
                          previewEnter(e.currentTarget, {
                            channelId: c.id,
                            userId: p.userId,
                            name: pname,
                            avatarUrl: p.avatarUrl,
                            streaming: true,
                          })
                      : undefined
                  }
                  onMouseLeave={screensharing ? previewLeave : undefined}
                  // ЛКМ открывает ту же карточку закреплённой — и у показывающего, и у обычного
                  // человека (наведением она по-прежнему всплывает только у показывающих: иначе
                  // карточка выскакивала бы на каждого, мимо кого провели мышкой).
                  onClick={(e) => {
                    const afterDrag = pClickAfterDrag.current;
                    pClickAfterDrag.current = false;
                    if (!rowClickOpensCard({ altKey: e.altKey, afterDrag })) return;
                    previewOpen(e.currentTarget, {
                      channelId: c.id,
                      userId: p.userId,
                      name: pname,
                      avatarUrl: p.avatarUrl,
                      streaming: screensharing,
                    });
                  }}
                >
                  <span className={`pava ${speaking ? 'speaking' : ''}`}>
                    <Avatar url={p.avatarUrl} animatedUrl={animatedOf(p.userId)} name={pname} size={22} fallback="icon" />
                    {p.userId === crownId && <CrownMark size={12} />}
                  </span>
                  {/* 🔴 Рамка живёт на ВНУТРЕННЕМ спане, а не на `.pname`. Тот растянут (`flex: 1`)
                      до самых значков, и обводка по нему обвела бы половину пустой строки, а не
                      ник. Внутренний спан обнимает ровно текст — и рамка совпадает с тем, куда
                      можно попасть мышью. ⚠️ `outline`, а не `border`: рамка не занимает места,
                      поэтому нажатие Alt не дёргает строку. */}
                  <span className={`pname${crownGlow(p.userId === crownId)}`}>
                    {canTip ? (
                      <span
                        className={`pname-tip${tipBusyId === p.userId ? ' pname-tip-busy' : ''}`}
                        title={`Alt + клик — типнуть ${pname}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Alt мог отпуститься между отрисовкой и кликом — тогда это обычный клик.
                          if (!e.altKey) return;
                          void sendTip(c.id, p.userId, pname);
                        }}
                      >
                        {pname}
                      </span>
                    ) : (
                      pname
                    )}
                  </span>
                  {/* 🔴 Слот нулевой ширины СРАЗУ после ника: `.pname` растягивается, поэтому слот
                      всегда стоит там, где ник кончается и начинаются значки — «справа от ника, до
                      генерала канала». Нулевая ширина обязательна: подсказка приходит и уходит, а
                      строка от этого дёргаться не должна. */}
                  <span className="tip-hint-slot">
                    {hintsFor(tipHints, p.userId).map((h, i) => (
                      <span
                        key={h.id}
                        className="tip-hint"
                        style={{ ['--i' as string]: i } as React.CSSProperties}
                        title={`${nameOf(h.fromUserId, h.fromName)} типнул ${pname}`}
                      >
                        +{h.amount} {nameOf(h.fromUserId, h.fromName)}
                      </span>
                    ))}
                  </span>
                  {/* 🔴 СЛОВО, а не значок (решение 02.09 после четырёх забракованных листов
                      контуров у Codex). Причина не в качестве рисунков: «генерал» — наше локальное
                      название назначенной роли, и общепринятого знака для него нет. Ресёрч Codex по
                      чужим продуктам показал то же самое — Telegram пишет Owner/Admin текстом,
                      Discourse и Reddit отдали щит модератору, корону Discord держит за владельцем.
                      ⚠️ И корона у нас УЖЕ занята победителем сезона, на этих же строках. */}
                  {c.generalUserId === p.userId ? <span className="vp-general">Генерал</span> : null}
                  {screensharing ? (
                    <span className="vp-flag" title="Показывает экран">
                      <Icon name="screen-share" size={14} />
                    </span>
                  ) : null}
                  {deafened ? (
                    <span className="vp-flag off" title="Звук выключен (деафен)">
                      <Icon name="headphones-off" size={14} />
                    </span>
                  ) : muted ? (
                    <span className="vp-flag off" title="Микрофон выключен">
                      <Icon name="mic-off" size={14} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  // Render a group's channels with drop-line indicators (and an empty drop placeholder
  // while dragging, so a channel can be pulled out into an empty group / "no category").
  const renderList = (catId: string | null) => {
    const list = channelsByCat(catId);
    const line = (beforeId: string | null) =>
      drag && dropHint && dropHint.cat === catId && dropHint.before === beforeId ? <div className="drop-line" /> : null;
    return (
      <>
        {list.map((c) => (
          <Fragment key={c.id}>
            {line(c.id)}
            {renderChannel(c)}
          </Fragment>
        ))}
        {line(null)}
        {drag && list.length === 0 ? <div className="drop-empty">Перетащите канал сюда</div> : null}
      </>
    );
  };

  return (
    <div className="channels">
      <div className="server-head">
        <strong>{bootstrap.server.name}</strong>
        <CoinChip serverId={bootstrap.server.id} />
        {/* Mobile (design-step8 A): a single primary + (create) and a ⋯ that opens the "More" sheet with
            the rare actions — no cramped 6-icon row. Desktop keeps the full compact row below. */}
        {isMobile() ? (
          <div className="head-actions mobile">
            {canManage && (
              <button className="head-icon primary" title="Новый канал" onClick={() => setShowCreate(true)}>
                <Icon name="plus" size={24} />
              </button>
            )}
            <button className="head-icon" title="Ещё" onClick={() => setShowMore(true)}>
              <Icon name="more" size={22} />
            </button>
          </div>
        ) : (
          <div className="head-actions">
          <button className="head-icon" title="Поиск" onClick={() => setShowSearch(true)}>
            <Icon name="search" size={18} />
          </button>
          {canInvite && (
            <button className="head-icon" title="Пригласить" onClick={() => setShowInvite(true)}>
              <Icon name="user-plus" size={18} />
            </button>
          )}
          {canManage && (
            <button
              className={`head-icon ${dragUnlocked ? 'armed' : ''}`}
              title={
                dragUnlocked
                  ? 'Перемещение каналов разблокировано — нажмите, чтобы заблокировать'
                  : 'Разблокировать перемещение каналов'
              }
              onClick={() => setDragUnlocked((v) => !v)}
            >
              <Icon name={dragUnlocked ? 'lock-open' : 'lock'} size={18} />
            </button>
          )}
          {canManage && (
            <button className="head-icon" title="Новый канал" onClick={() => setShowCreate(true)}>
              <Icon name="plus" size={18} />
            </button>
          )}
          {(canManageRoles || canKick) && (
            <button className="head-icon" title="Роли и участники" onClick={() => setShowMembers(true)}>
              <Icon name="users" size={18} />
            </button>
          )}
          <button
            className={`head-icon ${serverPushMuted ? 'armed' : ''}`}
            title={serverPushMuted ? 'Пуши сервера отключены — включить' : 'Отключить пуши этого сервера'}
            onClick={toggleServerPush}
          >
            <Icon name={serverPushMuted ? 'bell-off' : 'bell'} size={18} />
          </button>
          {canServerSettings && (
            <button className="head-icon" title="Настройки сервера" onClick={() => setShowServerSettings(true)}>
              <Icon name="settings" size={18} />
            </button>
          )}
          </div>
        )}
      </div>
      <div className="channel-list">
        <div className="cat-zone" data-catzone="">
          {renderList(null)}
        </div>
        {bootstrap.categories
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((cat) => (
            <div
              key={cat.id}
              data-catzone={cat.id}
              className={`category ${drag && dropHint?.cat === cat.id ? 'drag-over' : ''} ${
                collapsedCats.has(cat.id) && !drag ? 'collapsed' : ''
              }`}
            >
              <div
                className="cat-name"
                data-catheader={cat.id}
                onClick={() => toggleCategoryCollapse(cat.id)}
                onContextMenu={(e) => openCategoryMenu(e, cat)}
              >
                <Icon
                  name={collapsedCats.has(cat.id) ? 'chevron-right' : 'chevron-down'}
                  size={13}
                  className="cat-caret"
                />
                {cat.name}
              </div>
              {(!collapsedCats.has(cat.id) || !!drag) && renderList(cat.id)}
            </div>
          ))}
      </div>
      {voice && <VoicePanel />}
      <SelfVoiceBar />
      {drag && (
        <div className="drag-chip" style={{ left: drag.x + 14, top: drag.y + 8 }}>
          {drag.name}
        </div>
      )}
      {pdrag && (
        <div className="drag-chip pp-chip" style={{ left: pdrag.x + 14, top: pdrag.y + 8 }}>
          <Icon name="leave" size={13} /> {pdrag.name}
        </div>
      )}

      {showCreate && (
        <CreateChannelModal
          serverId={bootstrap.server.id}
          categories={bootstrap.categories}
          onClose={() => setShowCreate(false)}
        />
      )}
      {showServerSettings && (
        <ServerSettingsModal
          server={bootstrap.server}
          categories={bootstrap.categories}
          canDelete={canDeleteServer}
          onClose={() => setShowServerSettings(false)}
        />
      )}
      {editingChannel && (
        <ChannelSettingsModal
          channel={editingChannel}
          categories={bootstrap.categories}
          onClose={() => setEditingChannel(null)}
        />
      )}
      {showMembers && user && (
        <MembersRolesModal
          serverId={bootstrap.server.id}
          ownerId={bootstrap.server.ownerId}
          selfId={user.id}
          canManageRoles={canManageRoles}
          canKick={canKick}
          onClose={() => setShowMembers(false)}
        />
      )}
      {showSearch && <SearchModal serverId={bootstrap.server.id} onClose={() => setShowSearch(false)} />}
      {showInvite && <InviteCodeModal serverId={bootstrap.server.id} onClose={() => setShowInvite(false)} />}
      {showMore && (
        <BottomSheet title={bootstrap.server.name} onClose={() => setShowMore(false)}>
          <SheetRow icon="search" label="Поиск сообщений" onClick={() => { setShowMore(false); setShowSearch(true); }} />
          <SheetRow
            icon={serverPushMuted ? 'bell-off' : 'bell'}
            label={serverPushMuted ? 'Включить пуши сервера' : 'Отключить пуши сервера'}
            onClick={() => { setShowMore(false); toggleServerPush(); }}
          />
          {canInvite && (
            <SheetRow icon="user-plus" label="Пригласить друзей" onClick={() => { setShowMore(false); setShowInvite(true); }} />
          )}
          {(canManageRoles || canKick) && (
            <SheetRow icon="users" label="Роли и участники" onClick={() => { setShowMore(false); setShowMembers(true); }} />
          )}
          {canManage && (
            <SheetRow
              icon={dragUnlocked ? 'lock-open' : 'lock'}
              label={dragUnlocked ? 'Заблокировать перемещение каналов' : 'Разблокировать перемещение каналов'}
              onClick={() => { setShowMore(false); setDragUnlocked((v) => !v); }}
            />
          )}
          {canServerSettings && (
            <SheetRow icon="settings" label="Настройки сервера" onClick={() => { setShowMore(false); setShowServerSettings(true); }} />
          )}
        </BottomSheet>
      )}
      {userMenu}
      {previewTip}
      {channelMenus}
    </div>
  );
}
