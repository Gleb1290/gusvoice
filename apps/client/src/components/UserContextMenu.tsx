import { type CustomStatus, has, Permission, permsFromString, type Role } from '@gusvoice/shared';
import { ConnectionQuality, type Participant, type RemoteTrack } from 'livekit-client';
import { type CSSProperties, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { MAX_VOLUME, useUserAudio } from '../localUserAudio';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { AvatarZoom } from './AvatarZoom';
import { customStatusVisible, type DotStatus, effectiveDot } from '../status';
import { ContextMenu, MenuDivider, MenuHeader, MenuItem, MenuSection, type MenuPos } from './ContextMenu';
import { Icon } from './Icon';
import { PokeComposer } from './PokeModal';
import { ProfileEconomy } from './ProfileEconomy';
import { useAnimatedAvatarUrl } from '../avatarAnimation';
import { StatusDot } from './StatusDot';

export type UserMenuTarget = {
  userId: string; // user id == LiveKit participant identity
  name: string;
  avatarUrl?: string | null;
  participant?: Participant | null; // live participant, if they're in voice with you (enables connection info)
  voiceChannelId?: string | null; // the voice channel the target is currently in → enables moderation
  micMuted?: boolean; // mic-muted hint when there's no live participant (e.g. from the presence list)
  serverMuted?: boolean; // muted by a moderator (from presence) — distinct from self-mute
};

/**
 * Wire a user context menu into any surface: spread `open` onto an element's onContextMenu
 * (and optionally a ••• button), and render `menu` somewhere in the same tree.
 */
export function useUserMenu() {
  const [state, setState] = useState<{ pos: MenuPos; target: UserMenuTarget } | null>(null);
  const open = (e: ReactMouseEvent, target: UserMenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ pos: { x: e.clientX, y: e.clientY }, target });
  };
  const menu = state ? (
    <UserContextMenu target={state.target} pos={state.pos} onClose={() => setState(null)} />
  ) : null;
  return { open, menu };
}

type View = 'menu' | 'connection' | 'profile' | 'roles' | 'move' | 'ban' | 'nickname' | 'poke' | 'mega-poke';

const QUALITY: Record<string, { label: string; cls: string }> = {
  [ConnectionQuality.Excellent]: { label: 'Отличное', cls: 'good' },
  [ConnectionQuality.Good]: { label: 'Хорошее', cls: 'ok' },
  [ConnectionQuality.Poor]: { label: 'Слабое', cls: 'bad' },
  [ConnectionQuality.Lost]: { label: 'Потеряно', cls: 'bad' },
  unknown: { label: '—', cls: 'ok' },
};

/** `0xRRGGBB` role colour → `#rrggbb`; combine with hexRgba() for tinted chip backgrounds. */
export function roleHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}
export function hexRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** "На сервере с" date — short Russian month + year, no trailing dot ("апр 2024"). */
function monthYear(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' }).replace('.', '');
}

/** A stable per-user banner gradient (honey for yourself, a hashed hue for everyone else). */
export function bannerStyle(seed: string, self: boolean): string {
  if (self) return 'linear-gradient(120deg, #c9763f, #9c5a2f)';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(120deg, hsl(${hue} 42% 46%), hsl(${hue} 44% 32%))`;
}

// ---- connection info -------------------------------------------------------

interface InboundAudioStat {
  kind?: string;
  bytesReceived?: number;
  packetsLost?: number;
  packetsReceived?: number;
  jitter?: number;
  codecId?: string;
  timestamp: number;
}
interface CandidatePairStat {
  currentRoundTripTime?: number;
  nominated?: boolean;
  state?: string;
}
interface CodecStat {
  id: string;
  mimeType?: string;
  clockRate?: number;
  channels?: number;
}

interface ConnStats {
  quality: string;
  codec?: string;
  clockRate?: number;
  channels?: number;
  bitrate?: number;
  loss?: number;
  jitter?: number;
  rtt?: number;
}

const SPARK_W = 260;
const SPARK_H = 30;

/** Build a sparkline (line + closed area) from an RTT history; null if too few samples. */
function sparkline(vals: number[]): { line: string; area: string } | null {
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * SPARK_W;
    const y = SPARK_H - 3 - ((v - min) / range) * (SPARK_H - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = pts.join(' ');
  return { line, area: `${line} ${SPARK_W},${SPARK_H} 0,${SPARK_H}` };
}

function ConnectionView({
  p,
  name,
  avatarUrl,
}: {
  p: Participant;
  name: string;
  avatarUrl?: string | null;
}) {
  const [s, setS] = useState<ConnStats>({ quality: 'unknown' });
  const [hist, setHist] = useState<number[]>([]);

  useEffect(() => {
    let prevBytes = 0;
    let prevTs = 0;
    let stopped = false;

    const tick = async () => {
      try {
        const pub = [...p.audioTrackPublications.values()][0];
        const track = pub?.track as RemoteTrack | undefined;
        const next: ConnStats = { quality: p.connectionQuality || 'unknown' };
        const report = track ? await track.getRTCStatsReport() : undefined;
        if (report) {
          let codecId: string | undefined;
          report.forEach((raw) => {
            const type = (raw as { type?: string }).type;
            if (type === 'inbound-rtp') {
              const st = raw as unknown as InboundAudioStat;
              if (st.kind !== 'audio') return;
              if (st.bytesReceived != null && prevTs) {
                const dt = (st.timestamp - prevTs) / 1000;
                if (dt > 0) next.bitrate = Math.max(0, ((st.bytesReceived - prevBytes) * 8) / dt / 1000);
              }
              prevBytes = st.bytesReceived ?? prevBytes;
              prevTs = st.timestamp;
              if (st.packetsLost != null && st.packetsReceived != null) {
                const total = st.packetsLost + st.packetsReceived;
                next.loss = total > 0 ? (st.packetsLost / total) * 100 : 0;
              }
              if (st.jitter != null) next.jitter = st.jitter * 1000;
              codecId = st.codecId;
            } else if (type === 'candidate-pair') {
              const st = raw as unknown as CandidatePairStat;
              if (st.currentRoundTripTime != null && (st.nominated || st.state === 'succeeded')) {
                next.rtt = st.currentRoundTripTime * 1000;
              }
            }
          });
          if (codecId) {
            report.forEach((raw) => {
              const st = raw as unknown as CodecStat;
              if (st.id === codecId) {
                if (st.mimeType) next.codec = st.mimeType.split('/')[1];
                if (st.clockRate) next.clockRate = st.clockRate;
                if (st.channels) next.channels = st.channels;
              }
            });
          }
        }
        if (!stopped) {
          setS(next);
          if (next.rtt != null) setHist((h) => [...h.slice(-39), next.rtt as number]);
        }
      } catch {
        /* track may be unsubscribed momentarily */
      }
    };

    void tick();
    const iv = setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [p]);

  const q = QUALITY[s.quality] ?? QUALITY.unknown;
  const codecLine = s.codec
    ? `${s.codec}${s.clockRate ? ` · ${Math.round(s.clockRate / 1000)} кГц` : ''}${
        s.channels === 2 ? ' стерео' : s.channels === 1 ? ' моно' : ''
      }`
    : 'аудио';
  const sp = sparkline(hist);
  const rttColor = s.rtt == null ? undefined : s.rtt < 60 ? 'var(--green)' : s.rtt < 150 ? 'var(--accent)' : 'var(--danger)';
  const lossColor = s.loss == null ? undefined : s.loss < 1 ? 'var(--green)' : s.loss < 5 ? 'var(--accent)' : 'var(--danger)';

  const cell = (label: string, value: string, color?: string) => (
    <div className="ci2-cell">
      <div className="ci2-val" style={color ? { color } : undefined}>
        {value}
      </div>
      <div className="ci2-lbl">{label}</div>
    </div>
  );

  return (
    <div className="ccard">
      <div className="ccard-head">
        <Avatar url={avatarUrl ?? null} name={name} size={34} fallback="icon" />
        <div className="ccard-id">
          <div className="ccard-name">{name}</div>
          <div className="ccard-codec">{codecLine}</div>
        </div>
        <span className={`ci-pill ${q.cls}`}>
          <span className="ci-dot" />
          {q.label.toLowerCase()}
        </span>
      </div>
      {sp && (
        <div className="ccard-spark">
          <svg width="100%" height="30" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id="ccg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polyline points={sp.area} fill="url(#ccg)" opacity="0.18" stroke="none" />
            <polyline points={sp.line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="ccard-spark-lbl">RTT</span>
        </div>
      )}
      <div className="ci2-grid">
        {cell('Пинг / RTT', s.rtt != null ? `${s.rtt.toFixed(0)} мс` : '—', rttColor)}
        {cell('Потери', s.loss != null ? `${s.loss.toFixed(1)}%` : '—', lossColor)}
        {cell('Джиттер', s.jitter != null ? `${s.jitter.toFixed(0)} мс` : '—')}
        {cell('Битрейт ↓', s.bitrate != null ? `${Math.round(s.bitrate)}к` : '—')}
        {cell('Битрейт ↑', '—', 'var(--muted-2)')}
        {cell('Кодек', s.codec ?? '—')}
      </div>
    </div>
  );
}

// ---- profile card ----------------------------------------------------------

function ProfileCard({
  target,
  username,
  isSelf,
  status,
  customStatus,
  roles,
  joinedAt,
  onBack,
  onDm,
  onEdit,
  onReopen,
}: {
  target: UserMenuTarget;
  username?: string;
  isSelf: boolean;
  status: DotStatus;
  customStatus: CustomStatus | null;
  roles: Role[];
  joinedAt?: string;
  onBack: () => void;
  onDm: () => void;
  onEdit: () => void;
  onReopen: () => void;
}) {
  const joined = monthYear(joinedAt);
  // Game activity (#40) — read live from the store so it updates while the card is open.
  const game = useStore((s) => s.userActivities[target.userId]);
  /**
   * Анимация берётся из ОБЩЕГО ростера, а не приходит в `target`.
   *
   * ⚠️ `target` собирают полдюжины мест — плитка сцены, список канала, автор сообщения, — и добавь
   * мы поле туда, где-нибудь его забыли бы передать; анимация тогда исчезала бы при открытии
   * карточки из «неправильного» места, и объяснить это было бы нечем.
   */
  const animatedAvatarUrl = useAnimatedAvatarUrl()(target.userId) ?? null;
  // Кружок обрезает картинку, а прийти в профиль могут именно ради неё. Открываем ровно то, что
  // человек тут видит: анимацию, когда она показана, иначе обычный аватар. Выключивший анимацию
  // не должен получить её через просмотрщик — выключатель бережёт трафик, а не только глаза.
  const fullAvatarUrl = animatedAvatarUrl ?? target.avatarUrl ?? null;
  return (
    <div className="pcard">
      <div className="pcard-banner" style={{ background: bannerStyle(target.userId, isSelf) }}>
        <button type="button" className="pcard-back" title="Назад" onClick={onBack}>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div className="pcard-body">
        <div className="pcard-ava">
          {/* Карточка профиля — одно из двух мест, где анимация вообще показывается: сюда
              приходят СМОТРЕТЬ на человека, а не пробегать список глазами. */}
          <AvatarZoom url={fullAvatarUrl} name={target.name}>
            <Avatar
              url={target.avatarUrl ?? null}
              animatedUrl={animatedAvatarUrl}
              name={target.name}
              size={64}
              fallback="icon"
            />
          </AvatarZoom>
          <span className="pcard-dot-wrap">
            <StatusDot status={status} size={16} ringColor="var(--bg-2)" />
          </span>
        </div>
        <div className="pcard-name-row">
          <span className="pcard-name">{target.name}</span>
          {isSelf && <span className="pcard-badge">это вы</span>}
        </div>
        {username && <div className="pcard-handle">@{username}</div>}
        {customStatus && (
          <div className="pcard-custom">
            {customStatus.emoji && <span className="pcard-custom-emoji">{customStatus.emoji}</span>}
            {customStatus.text}
          </div>
        )}
        {game && (
          <div className="pcard-game" title={`Играет в ${game.name}`}>
            <Icon name="gamepad" size={14} />
            <span className="pcard-game-name">{game.name}</span>
          </div>
        )}

        {roles.length > 0 && (
          <div className="pcard-section">
            <div className="pcard-sec-label">Роли</div>
            <div className="pcard-roles">
              {roles.map((r) => {
                const hex = r.color ? roleHex(r.color) : null;
                return (
                  <span
                    key={r.id}
                    className="pcard-role"
                    style={hex ? { background: hexRgba(hex, 0.16), color: hex } : undefined}
                  >
                    <span className="pcard-role-dot" style={hex ? { background: hex } : undefined} />
                    {r.name}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Экономика — только у ЧУЖОГО профиля: свой баланс и так висит чипом в шапке сервера,
            а «типнуть себе» смысла не имеет (сервер такое и не пропустит). */}
        {!isSelf && <ProfileEconomy userId={target.userId} name={target.name} />}

        {joined && (
          <div className="pcard-joined">
            На сервере с <span className="pcard-mono">{joined}</span>
          </div>
        )}

        <div className="pcard-actions">
          {isSelf ? (
            <button type="button" className="pcard-cta" onClick={onEdit}>
              <Icon name="edit" size={16} /> Изменить профиль
            </button>
          ) : (
            <>
              <button type="button" className="pcard-cta" onClick={onDm}>
                <Icon name="mail" size={16} /> Написать в ЛС
              </button>
              <button type="button" className="pcard-more" title="Ещё" onClick={onReopen}>
                <Icon name="more" size={18} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- the menu --------------------------------------------------------------

export function UserContextMenu({ target, pos, onClose }: { target: UserMenuTarget; pos: MenuPos; onClose: () => void }) {
  const bootstrap = useStore((s) => s.bootstrap);
  const me = useStore((s) => s.user);
  const members = useStore((s) => s.members);
  const loadMembers = useStore((s) => s.loadMembers);
  const applyMemberNickname = useStore((s) => s.applyMemberNickname);
  const onlineUsers = useStore((s) => s.onlineUsers);
  const userStatuses = useStore((s) => s.userStatuses);
  const openDmWith = useStore((s) => s.openDmWith);
  const requestMention = useStore((s) => s.requestMention);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const pushMutedDmUsers = useStore((s) => s.pushMutedDmUsers);
  const setPushMuted = useStore((s) => s.setPushMuted);
  const audio = useUserAudio(target.userId);
  const [view, setView] = useState<View>('menu');
  const [nickDraft, setNickDraft] = useState('');
  // Свой выключатель приёма тычков на этом сервере (#122). Грузим ТОЛЬКО для себя и отдельным
  // запросом: в общем списке участников такому полю не место — иначе видно, кто отключил приём.
  const [pokesOptOut, setPokesOptOut] = useState<boolean | null>(null);
  const [nickBusy, setNickBusy] = useState(false);
  const [banReason, setBanReason] = useState('');

  const isSelf = !!me && me.id === target.userId;
  const online = onlineUsers.includes(target.userId);
  const p = target.participant ?? null;
  /**
   * Аватар в шапке меню — и он же открывается по клику.
   *
   * 🔴 **Было «в меню статичный намеренно, это список действий, а не смотрины» — и это оказалось
   * неверно** (05.09, на первых двух купленных анимациях). Довод рассыпается о факт: у
   * купившего анимацию `avatar_url` и `animated_avatar_url` — РАЗНЫЕ картинки, и статичной там
   * лежит прежняя. То есть шапка показывала не «спокойную версию того же лица», а СТАРОЕ лицо —
   * единственное место в приложении, где человек выглядел иначе, чем везде. Плюс клик по нему
   * открывал анимацию, то есть меню само себе противоречило.
   * ⚠️ Довод «список действий, а не смотрины» не выдерживает и сравнения: строка сайдбара — тоже
   * не смотрины, а анимацию показывает, и она там 22 px.
   */
  const headerAnimatedUrl = useAnimatedAvatarUrl()(target.userId);
  const headerAvatarUrl = headerAnimatedUrl ?? target.avatarUrl ?? null;

  // Presence dot + custom status (self sees their true state; others' invisible reads as offline).
  const st = userStatuses[target.userId];
  const rawStatus = (isSelf ? me?.status : st?.status) ?? st?.status ?? 'online';
  const dot = effectiveDot(rawStatus, online, isSelf);
  const liveCustom = (isSelf ? me?.customStatus : st?.customStatus) ?? st?.customStatus ?? null;
  const customStatus =
    liveCustom && (liveCustom.emoji || liveCustom.text) && customStatusVisible(rawStatus, online, isSelf) ? liveCustom : null;

  // Enrich the target from the cached member roster: @username, roles, join date.
  const member = members.find((m) => m.user.id === target.userId);
  const memberOf = (id: string) => members.find((m) => m.user.id === id);

  async function saveNickname() {
    if (!bootstrap) return;
    setNickBusy(true);
    try {
      // Применяем ОТВЕТ, а не ждём только `member.update` по сокету: если гейтвей в этот момент
      // переподключается, кадр теряется и ник «не сохранился» на глазах у автора (тот же урок, что
      // в #70). Сервер отдаёт уже обрезанный ник — берём его, а не черновик из поля.
      const { nickname } = await api.setNickname(bootstrap.server.id, nickDraft);
      applyMemberNickname(bootstrap.server.id, target.userId, nickname);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setNickBusy(false);
    }
  }
  useEffect(() => {
    if (!isSelf || !bootstrap) return;
    let alive = true;
    api
      .getMyMember(bootstrap.server.id)
      .then((m) => {
        if (alive) setPokesOptOut(m.pokesOptOut);
      })
      .catch(() => {
        // Защита от травли — не украшение, но и не повод рушить меню: просто не показываем строку.
        if (alive) setPokesOptOut(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelf, bootstrap?.server.id]);

  // Roster is best-effort and may be empty (cold open / race) — fetch it on demand so the
  // header's role chips and join date populate even if openServer's load hadn't landed.
  useEffect(() => {
    if (!member && bootstrap) void loadMembers(bootstrap.server.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap?.server.id]);
  const username = member?.user.username ?? (isSelf ? me?.username : undefined);
  const roles = useMemo(() => {
    if (!bootstrap || !member) return [] as Role[];
    const set = new Set(member.roleIds);
    return bootstrap.roles
      .filter((r) => set.has(r.id) && !r.isEveryone)
      .sort((a, b) => b.position - a.position)
      .slice(0, 6);
  }, [bootstrap, member]);

  const perms = bootstrap ? permsFromString(bootstrap.permissions) : 0n;
  const canMute = !isSelf && has(perms, Permission.MUTE_MEMBERS) && !!target.voiceChannelId;
  const canMove = !isSelf && has(perms, Permission.MOVE_MEMBERS) && !!target.voiceChannelId;
  const canPoke = !isSelf && has(perms, Permission.POKE_MEMBERS) && !!target.voiceChannelId;
  /**
   * Цена МЕГА пока и мой баланс — из общего кэша экономики, без своего запроса.
   *
   * `null` = показывать пункт нечего: экономика выключена, позиция снята с продажи, либо витрина
   * ещё не доехала. Показать «Сильно ткнуть» без цены нельзя — это и есть то самое «сломалось».
   */
  const economyView = useStore((s) => (bootstrap ? s.economy[bootstrap.server.id] : undefined));
  const megaEntry = economyView?.enabled ? economyView.shop?.find((e) => e.item === 'mega-poke') : undefined;
  const megaPrice = megaEntry?.enabled && megaEntry.priceCoins > 0 ? megaEntry.priceCoins : null;
  const myBalance = economyView?.wallet.balance ?? 0;
  // ⚠️ Название валюты берём из настроек сервера, а не пишем «монет»: владелец её переименовывает,
  // и вшитое слово рассогласовалось бы с кошельком, где имя подставляется (аудит текстов 03.09).
  const currencyName = economyView?.currencyName ?? 'монет';
  const canKick = !isSelf && has(perms, Permission.KICK_MEMBERS) && !!bootstrap;
  const canBan = !isSelf && has(perms, Permission.BAN_MEMBERS) && !!bootstrap;
  const canManageRoles = !isSelf && has(perms, Permission.MANAGE_ROLES) && !!bootstrap;
  // Ник меняется ТОЛЬКО свой: переименовывать другого человека без спроса — не то, что нужно
  // дружескому серверу, поэтому нет ни пункта, ни права.
  const canRename = !!bootstrap && isSelf;
  // Roles you may assign: below YOUR highest role (admins/owner = no ceiling), @everyone excluded.
  const myTop = useMemo(() => {
    if (!bootstrap) return 0;
    if (has(perms, Permission.ADMINISTRATOR)) return Number.POSITIVE_INFINITY;
    const mine = new Set(bootstrap.member.roleIds);
    return bootstrap.roles.filter((r) => mine.has(r.id)).reduce((m, r) => Math.max(m, r.position), 0);
  }, [bootstrap, perms]);
  const assignableRoles = useMemo(
    () =>
      (bootstrap?.roles ?? [])
        .filter((r) => !r.isEveryone && r.position < myTop)
        .sort((a, b) => b.position - a.position),
    [bootstrap, myTop],
  );
  // Self-service grant: roles the actor HOLDS that are flagged members_can_assign — grantable to
  // others WITHOUT MANAGE_ROLES (add-only). Unioned with the manager-assignable set for the menu.
  const selfAssignableRoles = useMemo(() => {
    if (!bootstrap) return [] as Role[];
    const mine = new Set(bootstrap.member.roleIds);
    return bootstrap.roles.filter((r) => !r.isEveryone && r.membersCanAssign && mine.has(r.id));
  }, [bootstrap]);
  const assignableIds = useMemo(() => new Set(assignableRoles.map((r) => r.id)), [assignableRoles]);
  const grantRoles = useMemo(() => {
    const byId = new Map<string, Role>();
    if (canManageRoles) for (const r of assignableRoles) byId.set(r.id, r);
    for (const r of selfAssignableRoles) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.position - a.position);
  }, [canManageRoles, assignableRoles, selfAssignableRoles]);
  // Removing a role is manager-only within your hierarchy — self-service grant is add-only.
  const canRemoveRole = (r: Role) => canManageRoles && assignableIds.has(r.id);
  const toggleRole = async (roleId: string, add: boolean) => {
    if (!bootstrap) return;
    try {
      if (add) await api.assignRole(bootstrap.server.id, target.userId, roleId);
      else await api.unassignRole(bootstrap.server.id, target.userId, roleId);
      await loadMembers(bootstrap.server.id);
    } catch (e) {
      toastError(e);
    }
  };
  const pushMuted = pushMutedDmUsers.includes(target.userId);
  // PTT idle (mic off between key-presses) is not "muted" — read the ptt attribute like the roster does.
  const micMuted = p ? !p.isMicrophoneEnabled && p.attributes?.ptt !== '1' : (target.micMuted ?? false);
  // Server-mute is reported by presence; fall back to the mic-muted proxy where it's unknown.
  const serverMuted = target.serverMuted ?? micMuted;
  const moveTargets =
    canMove && bootstrap
      ? bootstrap.channels.filter((c) => c.type === 'voice' && c.id !== target.voiceChannelId)
      : [];

  const run = (fn: () => Promise<void> | void) => {
    onClose();
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((e) => toastError(e));
    } catch (e) {
      toastError(e);
    }
  };

  const volPct = Math.round(audio.volume * 100);
  // Fraction of the 0..MAX range (0..1). Drives the CSS fill anchored to the thumb CENTRE (--p),
  // exactly like the stream slider — the 100% neutral point is the separate `.ctx-vol2-detent` tick.
  const volFrac = audio.muted ? 0 : audio.volume / MAX_VOLUME;

  if (view === 'connection' && p) {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={300}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <ConnectionView p={p} name={target.name} avatarUrl={target.avatarUrl} />
      </ContextMenu>
    );
  }

  if (view === 'profile') {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={320} bare>
        <ProfileCard
          target={target}
          username={username}
          isSelf={isSelf}
          status={dot}
          customStatus={customStatus}
          roles={roles}
          joinedAt={member?.joinedAt}
          onBack={() => setView('menu')}
          onDm={() => run(() => openDmWith(target.userId))}
          onEdit={() => run(() => setSettingsOpen(true))}
          onReopen={() => setView('menu')}
        />
      </ContextMenu>
    );
  }

  if (view === 'ban' && bootstrap) {
    const serverId = bootstrap.server.id;
    return (
      <ContextMenu pos={pos} onClose={onClose} width={264}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <div className="ctx-ban">
          <div className="ctx-ban-head">
            <span className="ctx-ban-ico">
              <Icon name="ban" size={18} />
            </span>
            <div>
              <div className="ctx-ban-title">Забанить {target.name}?</div>
              <div className="ctx-ban-sub">Удалит с сервера и заблокирует повторный вход по инвайту.</div>
            </div>
          </div>
          <input
            className="ctx-ban-reason"
            value={banReason}
            onChange={(e) => setBanReason(e.target.value)}
            placeholder="Причина (необязательно)"
            maxLength={512}
            autoFocus
          />
          <div className="ctx-ban-actions">
            <button type="button" className="ctx-ban-cancel" onClick={() => setView('menu')}>
              Отмена
            </button>
            <button
              type="button"
              className="ctx-ban-confirm"
              onClick={() => run(() => api.banMember(serverId, target.userId, banReason.trim() || undefined).then(() => loadMembers(serverId)))}
            >
              Забанить
            </button>
          </div>
        </div>
      </ContextMenu>
    );
  }

  if (view === 'mega-poke' && target.voiceChannelId && megaPrice !== null) {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={248}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <PokeComposer
          channelId={target.voiceChannelId}
          userId={target.userId}
          name={target.name}
          price={megaPrice}
          onClose={onClose}
        />
      </ContextMenu>
    );
  }

  if (view === 'poke' && target.voiceChannelId) {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={248}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <PokeComposer
          channelId={target.voiceChannelId}
          userId={target.userId}
          name={target.name}
          onClose={onClose}
        />
      </ContextMenu>
    );
  }

  if (view === 'move') {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={248}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <div className="pcard-sec-label" style={{ padding: '4px 12px 6px' }}>
          Переместить · {target.name}
        </div>
        <div className="ctx-move-list">
          {moveTargets.length === 0 ? (
            <div className="muted" style={{ padding: '4px 12px 8px', fontSize: 13 }}>
              Нет других голосовых каналов.
            </div>
          ) : (
            moveTargets.map((c) => (
              <MenuItem
                key={c.id}
                icon="volume"
                label={c.name}
                onClick={() => run(() => api.voiceMove(target.voiceChannelId!, target.userId, c.id))}
              />
            ))
          )}
        </div>
      </ContextMenu>
    );
  }

  if (view === 'nickname' && bootstrap) {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={260}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <form
          className="ctx-nick"
          onSubmit={(e) => {
            e.preventDefault();
            void saveNickname();
          }}
        >
          <div className="pcard-sec-label">Ник на сервере · {target.name}</div>
          <input
            autoFocus
            value={nickDraft}
            maxLength={32}
            placeholder={memberOf(target.userId)?.user.displayName ?? 'Обычное имя'}
            onChange={(e) => setNickDraft(e.target.value)}
          />
          <div className="muted ctx-nick-hint">
            Действует только на этом сервере. Пустое поле — вернуть обычное имя.
          </div>
          <div className="ctx-nick-row">
            <button type="button" className="link" onClick={() => setView('menu')}>
              Отмена
            </button>
            <button type="submit" disabled={nickBusy}>
              {nickBusy ? '…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </ContextMenu>
    );
  }

  if (view === 'roles' && bootstrap) {
    return (
      <ContextMenu pos={pos} onClose={onClose} width={260}>
        <button type="button" className="ctx-back" onClick={() => setView('menu')}>
          <Icon name="chevron-right" size={14} /> Назад
        </button>
        <div className="ctx-roles-edit">
          <div className="pcard-sec-label">Роли · {target.name}</div>
          {grantRoles.length === 0 ? (
            <div className="muted" style={{ padding: '4px 12px 8px', fontSize: 13 }}>
              Нет ролей, которыми вы можете управлять.
            </div>
          ) : (
            grantRoles.map((r) => {
              const had = !!member?.roleIds.includes(r.id);
              const locked = had && !canRemoveRole(r); // self-service is add-only → can't remove
              const hex = r.color ? roleHex(r.color) : null;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`ctx-role-toggle ${had ? 'on' : ''}${locked ? ' locked' : ''}`}
                  disabled={locked}
                  title={locked ? 'Снять роль может только модератор' : undefined}
                  onClick={() => void toggleRole(r.id, !had)}
                >
                  <span className="ctx-role-dot" style={hex ? { background: hex } : undefined} />
                  <span className="ctx-role-name">{r.name}</span>
                  {had && <Icon name="check" size={15} />}
                </button>
              );
            })
          )}
        </div>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu pos={pos} onClose={onClose} width={248}>
      <MenuHeader
        avatar={
          /* Клик по аватару в шапке меню открывает картинку — тот же жест, что и в карточке. */
          <AvatarZoom url={headerAvatarUrl} name={target.name}>
            <Avatar
              url={target.avatarUrl ?? null}
              animatedUrl={headerAnimatedUrl}
              name={target.name}
              size={36}
              fallback="icon"
            />
          </AvatarZoom>
        }
        status={dot}
        name={target.name}
        sub={username ? `@${username}` : isSelf ? 'это вы' : online ? 'в сети' : 'не в сети'}
      />

      {customStatus && (
        <div className="ctx-custom-status">
          {customStatus.emoji && <span className="ctx-custom-emoji">{customStatus.emoji}</span>}
          {customStatus.text}
        </div>
      )}

      {roles.length > 0 && (
        <div className="ctx-roles">
          {roles.map((r) => {
            const hex = r.color ? roleHex(r.color) : null;
            return (
              <span
                key={r.id}
                className="ctx-role-chip"
                style={hex ? { background: hexRgba(hex, 0.16), color: hex } : undefined}
              >
                <span className="ctx-role-dot" style={hex ? { background: hex } : undefined} />
                {r.name}
              </span>
            );
          })}
        </div>
      )}

      {!isSelf && (
        <>
          {/* Personal, client-only audio — persisted across sessions, applies in voice. */}
          <div className="ctx-vol2">
            <div className="ctx-vol2-head">
              <button
                type="button"
                className={`ctx-vol2-spk ${audio.muted ? 'on' : ''}`}
                title={audio.muted ? 'Включить звук' : 'Заглушить для себя'}
                onClick={() => audio.toggleMuted()}
              >
                <Icon name={audio.muted ? 'volume-off' : 'volume'} size={16} />
              </button>
              <span className="ctx-vol2-label">Громкость</span>
              <button
                type="button"
                className={`ctx-vol2-pct ${audio.muted ? 'muted' : volPct > 100 ? 'boost' : ''}`}
                title="Сбросить к 100%"
                onClick={() => audio.reset()}
              >
                {audio.muted ? 'выкл' : `${volPct}%`}
              </button>
              <button type="button" className="ctx-vol2-reset" title="Сбросить к 100%" onClick={() => audio.reset()}>
                <Icon name="reset" size={13} />
              </button>
            </div>
            <div className="ctx-vol2-track">
              <input
                className="ctx-vol-range"
                type="range"
                min={0}
                max={MAX_VOLUME}
                step={0.05}
                value={audio.muted ? 0 : audio.volume}
                onChange={(e) => {
                  if (audio.muted) audio.setMuted(false);
                  audio.setVolume(parseFloat(e.target.value));
                }}
                onDoubleClick={() => audio.reset()}
                title="Громкость (только для вас)"
                style={{ ['--p']: volFrac } as CSSProperties}
              />
              <div className="ctx-vol2-detent" />
            </div>
          </div>
          <MenuItem
            icon={audio.muted ? 'volume-off' : 'mic-off'}
            label={audio.muted ? 'Включить звук' : 'Заглушить для себя'}
            sub="только для вас"
            active={audio.muted}
            onClick={() => audio.toggleMuted()}
          />

          <MenuDivider />
          {p && <MenuItem icon="activity" label="Инфо о подключении" onClick={() => setView('connection')} />}
          <MenuItem icon="user" label="Профиль" onClick={() => setView('profile')} />
          <MenuItem icon="mail" label="Написать в ЛС" onClick={() => run(() => openDmWith(target.userId))} />
          {/* Вставляем ИМЯ ПОЛЬЗОВАТЕЛЯ, а не отображаемое: упоминание ловится по username
              (`shared/mentions.ts`), и `@Маша` не разбудил бы никого — пункт меню делал вид, что
              сработал, а человек упоминания не получал. */}
          <MenuItem
            icon="at"
            label="Упомянуть"
            onClick={() => run(() => requestMention(username ?? target.name))}
          />
          <MenuItem
            icon={pushMuted ? 'bell' : 'bell-off'}
            label={pushMuted ? 'Включить пуши от него' : 'Отключить пуши от него'}
            sub={pushMuted ? undefined : 'не будить телефон на его ЛС'}
            active={pushMuted}
            onClick={() => run(() => setPushMuted('dm_user', target.userId, !pushMuted))}
          />
        </>
      )}

      {isSelf && (
        <>
          <MenuItem icon="user" label="Профиль" onClick={() => setView('profile')} />
          {/* Свой ник — ТОЛЬКО в ветке isSelf (#19/#72). Раньше пункт лежал внутри блока `!isSelf`,
              а `canRename` требует `isSelf` — взаимоисключающе, поэтому не показывался вообще. */}
          {canRename && (
            <MenuItem
              icon="edit"
              label="Изменить ник"
              sub="только на этом сервере"
              onClick={() => {
                setNickDraft(member?.nickname ?? '');
                setView('nickname');
              }}
            />
          )}
          {/* 🔴 Решение ЧЕЛОВЕКА, а не владельца: право тыкать выдаёт сервер, а достаётся конкретному
              человеку (#122). Живёт здесь, а не в кошельке: защита не должна зависеть от того,
              включена ли на сервере экономика. */}
          {pokesOptOut !== null && bootstrap && (
            <MenuItem
              icon="bell-off"
              label={pokesOptOut ? 'Принимать тычки и щипки' : 'Не принимать тычки и щипки'}
              // ⚠️ Один выключатель на оба: тот же флаг закрывает и ПЛАТНЫЙ щипок (аудит 03.09).
              sub="и бесплатные, и платные — только на этом сервере"
              onClick={() => {
                const next = !pokesOptOut;
                setPokesOptOut(next);
                api.setPokesOptOut(bootstrap.server.id, next).catch((e: Error) => {
                  setPokesOptOut(!next); // не сложилось — возвращаем переключатель, а не врём
                  toastError(e);
                });
              }}
            />
          )}
        </>
      )}

      {/* Тык — НЕ модерация: он бытовой («зайди в канал»), поэтому стоит отдельно от блока
          «Модерация» ниже и доступен всем, у кого есть право. Показываем только когда человек
          реально сидит в голосе — иначе тыкать некуда, и бэкенд всё равно откажет. */}
      {canPoke && (
        <MenuItem icon="bell" label="Ткнуть" sub="всплывёт окно со звуком" onClick={() => setView('poke')} />
      )}

      {/* 🔴 Цена показывается ВСЕГДА, а не только когда хватает монет. Серый пункт без числа человек
          прочитает как «сломалось», а с ценой он объясняет экономику лучше любой справки: видно, что
          есть, сколько стоит и сколько не хватает.
          ⚠️ Причину недоступности здесь НЕ раскрываем дальше «не хватает монет». Отказы про
          получателя (отключил приём, «не беспокоить», уже натыкали за сутки) приходят с сервера
          текстом при попытке — иначе меню превратилось бы в способ выяснять чужие настройки (#122). */}
      {canPoke && megaPrice !== null && (
        <MenuItem
          icon="bell"
          label="Ущипнуть"
          sub={
            myBalance < megaPrice
              ? `${megaPrice} ${currencyName} · не хватает ${megaPrice - myBalance}`
              : `${megaPrice} ${currencyName} · перья, тряска и звук`
          }
          disabled={myBalance < megaPrice}
          onClick={() => setView('mega-poke')}
        />
      )}

      {(canManageRoles || selfAssignableRoles.length > 0) && (
        <>
          <MenuDivider />
          <MenuItem icon="users" label="Роли" onClick={() => setView('roles')} />
        </>
      )}

      {(canMute || canMove || canKick || canBan) && (
        <>
          <MenuDivider />
          <MenuSection>Модерация</MenuSection>
          {canMute && (
            <MenuItem
              icon={serverMuted ? 'mic' : 'mic-off'}
              label={serverMuted ? 'Снять серверный мьют' : 'Заглушить на сервере'}
              onClick={() => run(() => api.voiceMute(target.voiceChannelId!, target.userId, !serverMuted))}
            />
          )}
          {moveTargets.length > 0 && (
            <MenuItem icon="volume" label="Переместить в…" submenu onClick={() => setView('move')} />
          )}
          {canMove && (
            <MenuItem
              icon="leave"
              label="Отключить от голоса"
              danger
              onClick={() => run(() => api.voiceDisconnect(target.voiceChannelId!, target.userId))}
            />
          )}
          {canKick && bootstrap && (
            <MenuItem
              icon="logout"
              label="Кикнуть с сервера"
              danger
              onClick={() =>
                run(() => {
                  if (window.confirm(`Кикнуть ${target.name} с сервера?`))
                    return api.kickMember(bootstrap.server.id, target.userId);
                })
              }
            />
          )}
          {canBan && bootstrap && (
            <MenuItem
              icon="ban"
              label="Забанить"
              danger
              onClick={() => {
                setBanReason('');
                setView('ban');
              }}
            />
          )}
        </>
      )}
    </ContextMenu>
  );
}
