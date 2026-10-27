/**
 * Профиль собеседника на телефоне (#218, решение владельца — «как Telegram») — экран на всю высоту поверх беседы, как
 * `ProfileActivity` Telegram Android (`TMessagesProj/src/main/java/org/telegram/ui/ProfileActivity.java`; код не копируем,
 * берём устройство и размеры):
 * - шапка цвета профиля (без точки присутствия на аватаре — «в сети» сказано строкой, как у Telegram): аватар 96 по центру (`avatarScale = lerp(42, 96, …) / 100`, `:8694`), имя и «в сети / был(а) …»;
 *   при прокрутке аватар уменьшается и уходит, в полосе сверху появляются маленький аватар 42 и имя (`dp(42)`, `:8911`);
 * - протяжка вниз у верха раскрывает аватар на всю ширину квадратом (`isPulledDown`, порог `expandProgress` 0.33, `:6298`),
 *   тянуть вверх — сворачивает; без фото раскрывать нечего — шапка только тянется. Нажатие на аватар — просмотр (`AvatarZoom`);
 * - кнопки-действия под шапкой (`ProfileActionsView`: высота ряда `dp(74)`, поля 14 / 12, промежуток 7, скругление 16 — в CSS ближайшие шаги шкалы 8 и 18,
 *   значок 24, подпись 11 жирным): «Сообщение» (только если открыт НЕ из этой беседы), звук, звонок (видеозвонков у нас нет);
 * - строки информации (имя пользователя и прочее, что у нас есть), ниже — общие медиа вкладками (`SharedMediaPanel`);
 * - фон шапки — размытый и затемнённый аватар (если он есть; без аватара — цвет `bannerStyle`): у `ProfileGalleryBlurView` тот же приём — аватар
 *   сжимается до ~96 px и размывается `stackBlur` (`:196`, `:272`), цвет сдвигается насыщенностью 0.65 и яркостью 0.5 (`:546`, `:547`); в свёрнутой полосе
 *   тот же слой. Берём СТАТИЧНЫЙ `avatarUrl` (анимированный не гоняем под размытием); в оптимизированном режиме (`gv-lite`) слой скрыт — плоский цвет;
 * - участник сервера (список участников, бывший лист `MemberProfileSheet`) открывает этот же экран: роли — строкой, личная громкость — строкой
 *   (только если человек в голосе, правило `showUserAudio`), модерация и прочее — в «⋮»;
 * - «⋮» — меню прежнего «⋯» карточки (`UserContextMenu` с `fromProfile`), системная «назад» закрывает (`pushBackHandler`).
 * Данные считает `UserContextMenu` (`PhoneProfileProps`), сюда — только вид. ПК — прежняя карточка.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { layerAbove, pushBackHandler } from '../androidBack';
import { useAnimatedAvatarUrl } from '../avatarAnimation';
import { dmBlockText, dmPeerHome, serverFedDm } from '../dmRules';
import { MAX_VOLUME, useUserAudio } from '../localUserAudio';
import { showUserAudio } from '../userAudioRules';
import { lastSeenLabel } from '../lastSeenText';
import { isPhoneUiNow } from '../phoneLayout';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { AvatarZoom } from './AvatarZoom';
import type { MenuPos } from './ContextMenu';
import { GuestLine, useGuestHome } from './GuestMark';
import { Icon, type IconName } from './Icon';
import { ProfileEconomy } from './ProfileEconomy';
import { SharedMediaPanel } from './SharedMedia';
import { bannerStyle, hexRgba, providePhoneProfile, roleHex, type PhoneProfileProps } from './UserContextMenu';

/** Аватар в шапке (Telegram: 96 dp) и в свёрнутой полосе (42 dp). */
const AVATAR = 96;
const AVATAR_SMALL = 42;
/** Доля протяжки, после которой аватар раскрывается на весь экран (Telegram: `expandProgress` 0.33). */
const EXPAND_AT = 0.33;

type Action = { key: string; icon: IconName; label: string; run: () => void };

function PhoneProfile(p: PhoneProfileProps) {
  const { target, isSelf } = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;
  const [menuAt, setMenuAt] = useState<MenuPos | null>(null);

  const animatedUrl = useAnimatedAvatarUrl()(target.userId) ?? null;
  const fullUrl = animatedUrl ?? target.avatarUrl ?? null;
  const guestHome = useGuestHome()(target.userId);
  const dmHome = useStore((s) => dmPeerHome(s.dms, target.userId));
  const lineHome = guestHome ?? dmHome; // Э4: у человека из ЛС инстанс — из записи беседы
  // Личная громкость — строкой, как в бывшем листе участника; только у того, кто сейчас в голосе (C3, `userAudioRules.ts`).
  const audio = useUserAudio(target.userId);
  const inVoicePresence = useStore((s) => Object.values(s.presence).some((l) => l.some((v) => v.userId === target.userId)));
  const showVolume = showUserAudio({
    isSelf,
    hasParticipant: !!target.participant,
    voiceChannelId: target.voiceChannelId,
    inPresence: inVoicePresence,
  });
  const volPct = Math.round(audio.volume * 100);
  const volFill = audio.muted ? 0 : (audio.volume / MAX_VOLUME) * 100;
  // Фон шапки из аватара: только статичный кадр (анимация — `animatedUrl` — сюда не идёт).
  const bgUrl = target.avatarUrl ?? null;
  const dmBlocked = dmBlockText(useStore((s) => s.user?.homeInstance), guestHome, useStore((s) => serverFedDm(s.serverFeatures)));
  const game = useStore((s) => s.userActivities[target.userId]);
  // Беседа 1:1 для общих медиа: из шапки беседы она передана, из ленты группы или сервера — найденная в списке бесед.
  const mediaConv = useStore((s) =>
    isSelf ? null : (target.convId ?? s.dms.find((d) => !d.group && d.otherUser.id === target.userId)?.id ?? null),
  );
  // «Сообщение» — только если профиль открыт не из этой же беседы (Telegram прячет кнопку, когда пришли из чата с человеком).
  const fromThisChat = useStore((s) => !!target.convId && s.view === 'dm' && s.currentDmId === target.convId);
  const seen = isSelf ? 'в сети' : p.lastSeen ? lastSeenLabel(p.lastSeen, new Date(), true) : null;
  const online = isSelf || !!p.lastSeen?.online;

  const closeRef = useRef(p.onClose);
  closeRef.current = p.onClose;
  // Системная «назад» и Esc закрывают экран; слой над ним (меню «⋮», просмотр фото) закрывается первым (`stepBack`/`layerAbove`).
  useEffect(() => {
    const off = pushBackHandler(() => {
      closeRef.current();
      return true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || layerAbove(rootRef.current)) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => setScroller(scrollRef.current), []);

  // Прокрутка: аватар шапки уменьшается и гаснет (`--tgp-p` 0…1), имя ушло под полосу — в полосе маленький аватар и имя.
  const onScroll = () => {
    const el = scrollRef.current;
    const name = nameRef.current;
    if (!el || !name) return;
    const range = Math.max(1, name.offsetTop + name.offsetHeight);
    const t = Math.min(1, el.scrollTop / range);
    rootRef.current?.style.setProperty('--tgp-p', t.toFixed(3));
    setCollapsed(t >= 1);
    if (expandedRef.current && el.scrollTop > 8) setExpanded(false);
  };

  // Протяжка вниз у верха: шапка тянется, за порогом аватар раскрывается; протяжка вверх в раскрытом — сворачивает.
  const canExpand = !!fullUrl;
  useEffect(() => {
    const el = scrollRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    let y0: number | null = null;
    const setPull = (v: number) => {
      root.style.setProperty('--tgp-pull', `${Math.round(v)}px`);
      // Рост аватара 96 → 138 по ходу протяжки (Telegram `lerp(96 / 42f, 138 / 42f, …)`, `:8430`).
      root.style.setProperty('--tgp-grow', canExpand ? Math.min(1, v / Math.max(1, el.clientWidth - AVATAR) / EXPAND_AT).toFixed(3) : '0');
    };
    const start = (e: TouchEvent) => {
      y0 = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null;
      if (y0 !== null) root.classList.add('pulling');
    };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      const dy = e.touches[0]!.clientY - y0;
      if (expandedRef.current) {
        if (dy < -24) {
          setExpanded(false);
          y0 = null;
        }
        return;
      }
      if (dy <= 0 || el.scrollTop > 0) {
        setPull(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      setPull(Math.min(dy, el.clientWidth));
      if (canExpand && dy / Math.max(1, el.clientWidth - AVATAR) >= EXPAND_AT) {
        y0 = null;
        root.classList.remove('pulling');
        setPull(0);
        setExpanded(true);
      }
    };
    const end = () => {
      y0 = null;
      root.classList.remove('pulling');
      setPull(0);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [canExpand]);

  const actions: Action[] = [];
  if (isSelf) {
    actions.push({ key: 'edit', icon: 'edit', label: 'Изменить', run: p.onEdit });
  } else {
    if (!fromThisChat && !dmBlocked) actions.push({ key: 'msg', icon: 'mail', label: 'Сообщение', run: p.onDm });
    actions.push({
      key: 'mute',
      icon: p.pushMuted ? 'bell' : 'bell-off',
      label: p.pushMuted ? 'Вкл. звук' : 'Выкл. звук',
      run: p.onMute,
    });
    if (p.onCall) actions.push({ key: 'call', icon: 'phone', label: 'Звонок', run: p.onCall });
  }

  const avatar = (size: number) => (
    <Avatar url={target.avatarUrl ?? null} animatedUrl={animatedUrl} name={target.name} size={size} fallback="icon" />
  );

  return createPortal(
    <div
      ref={rootRef}
      className={`tgp${collapsed ? ' collapsed' : ''}${expanded ? ' expanded' : ''}${bgUrl ? ' has-bg' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Профиль: ${target.name}`}
      style={{ ['--tgp-bg']: bannerStyle(target.userId, isSelf) } as CSSProperties}
    >
      <div className="tgp-bar">
        {bgUrl && (
          <span className="tgp-bar-bg" aria-hidden="true">
            <img className="tgp-bgimg" src={bgUrl} alt="" draggable={false} />
          </span>
        )}
        <button type="button" className="tgp-bar-btn" title="Назад" aria-label="Назад" onClick={p.onClose}>
          <Icon name="chevron-left" size={22} />
        </button>
        <div className="tgp-bar-title" aria-hidden={!collapsed}>
          <span className="tgp-bar-ava">{avatar(AVATAR_SMALL)}</span>
          <span className="tgp-bar-text">
            <span className="tgp-bar-name">{target.name}</span>
            {seen && <span className={`tgp-bar-seen${online ? ' online' : ''}`}>{seen}</span>}
          </span>
        </div>
        <button
          type="button"
          className="tgp-bar-btn tgp-more"
          title="Ещё"
          aria-label="Ещё"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt((cur) => (cur ? null : { x: r.right, y: r.bottom + 4 }));
          }}
        >
          <Icon name="more" size={22} />
        </button>
      </div>
      <div className="tgp-scroll" ref={scrollRef} onScroll={onScroll}>
        <header className="tgp-head">
          {bgUrl && <img className="tgp-bgimg" src={bgUrl} alt="" aria-hidden="true" draggable={false} />}
          {expanded && fullUrl ? (
            <AvatarZoom url={fullUrl} name={target.name}>
              <div className="tgp-hero">
                <img className="tgp-hero-img" src={fullUrl} alt="" draggable={false} />
                <div className="tgp-hero-text">
                  <div className="tgp-name">{target.name}</div>
                  {seen && <div className="tgp-seen">{seen}</div>}
                </div>
              </div>
            </AvatarZoom>
          ) : (
            <div className="tgp-head-main">
              <div className="tgp-ava">
                <AvatarZoom url={fullUrl} name={target.name}>
                  {avatar(AVATAR)}
                </AvatarZoom>
              </div>
              <div className="tgp-name" ref={nameRef}>
                {target.name}
              </div>
              {seen && <div className={`tgp-seen${online ? ' online' : ''}`}>{seen}</div>}
            </div>
          )}
          {actions.length > 0 && (
            <div className="tgp-actions">
              {actions.map((a) => (
                <button key={a.key} type="button" className="tgp-action" onClick={a.run}>
                  <Icon name={a.icon} size={24} />
                  <span className="tgp-action-label">{a.label}</span>
                </button>
              ))}
            </div>
          )}
        </header>

        <section className="tgp-info">
          {p.username && (
            <div className="tgp-row">
              <div className="tgp-row-value">@{p.username}</div>
              <div className="tgp-row-label">Имя пользователя</div>
            </div>
          )}
          {p.customStatus && (
            <div className="tgp-row">
              <div className="tgp-row-value">
                {p.customStatus.emoji && <span className="tgp-row-emoji">{p.customStatus.emoji}</span>}
                {p.customStatus.text}
              </div>
              <div className="tgp-row-label">Статус</div>
            </div>
          )}
          {game && (
            <div className="tgp-row">
              <div className="tgp-row-value">{game.name}</div>
              <div className="tgp-row-label">Играет</div>
            </div>
          )}
          {showVolume && (
            <div className="tgp-row tgp-vol">
              <div className="mps-vol-head">
                <button
                  type="button"
                  className={`mps-vol-spk ${audio.muted ? 'on' : ''}`}
                  title={audio.muted ? 'Включить звук' : 'Заглушить для себя'}
                  onClick={() => audio.toggleMuted()}
                >
                  <Icon name={audio.muted || volPct === 0 ? 'volume-off' : 'volume'} size={18} />
                </button>
                <span className="mps-vol-label">ГРОМКОСТЬ</span>
                <button type="button" className={`mps-vol-pct ${audio.muted ? 'muted' : volPct > 100 ? 'boost' : ''}`} onClick={() => audio.reset()}>
                  {audio.muted ? 'выкл' : `${volPct}%`}
                </button>
              </div>
              <input
                className="mps-vol-range"
                type="range"
                min={0}
                max={MAX_VOLUME}
                step={0.05}
                value={audio.muted ? 0 : audio.volume}
                onChange={(e) => {
                  if (audio.muted) audio.setMuted(false);
                  audio.setVolume(parseFloat(e.target.value));
                }}
                title="Громкость (только для вас)"
                style={{ background: `linear-gradient(90deg, var(--accent) ${volFill}%, var(--bg-3) ${volFill}%)` }}
              />
            </div>
          )}
          {p.roles.length > 0 && (
            <div className="tgp-row">
              <div className="tgp-roles">
                {p.roles.map((r) => {
                  const hex = r.color ? roleHex(r.color) : null;
                  return (
                    <span key={r.id} className="pcard-role" style={hex ? { background: hexRgba(hex, 0.16), color: hex } : undefined}>
                      <span className="pcard-role-dot" style={hex ? { background: hex } : undefined} />
                      {r.name}
                    </span>
                  );
                })}
              </div>
              <div className="tgp-row-label">Роли</div>
            </div>
          )}
          {lineHome && (
            <div className="tgp-row">
              <GuestLine home={lineHome} />
            </div>
          )}
          {!isSelf && dmBlocked && (
            <div className="tgp-row">
              <div className="tgp-row-label">{dmBlocked}</div>
            </div>
          )}
          {!isSelf && !target.bot && <ProfileEconomy userId={target.userId} name={target.name} />}
        </section>

        {mediaConv && <SharedMediaPanel convId={mediaConv} scroller={scroller} onLeave={p.onClose} />}
      </div>
      {menuAt && p.renderMenu(menuAt, () => setMenuAt(null))}
    </div>,
    document.body,
  );
}

providePhoneProfile({ isPhone: isPhoneUiNow, render: (props) => <PhoneProfile {...props} /> });
