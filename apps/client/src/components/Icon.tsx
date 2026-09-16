/**
 * Line-icon set in the Tabler-outline style (stroke 2, round caps, viewBox 0 0 24 24),
 * faithful to the design handoff. Replaces interface emoji glyphs (🎤🎧🖥️🔊📎💬…).
 * Reaction emoji in messages are content, not icons — keep those as text.
 */
export type IconName =
  | 'mic'
  | 'mic-off'
  | 'headphones'
  | 'headphones-off'
  | 'screen-share'
  | 'camera'
  | 'camera-off'
  | 'leave'
  | 'hash'
  | 'volume'
  | 'plus'
  | 'crown'
  | 'settings'
  | 'users'
  | 'user-plus'
  | 'search'
  | 'paperclip'
  | 'send'
  | 'reaction'
  | 'sticker'
  | 'play'
  | 'pause'
  | 'reply'
  | 'more'
  | 'signal'
  | 'close'
  | 'edit'
  | 'trash'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'mail'
  | 'lock'
  | 'lock-open'
  | 'user'
  | 'eye'
  | 'check'
  | 'volume-off'
  | 'logout'
  | 'ban'
  | 'music'
  | 'star'
  | 'bell'
  | 'bolt'
  | 'gamepad'
  | 'flame'
  | 'heart'
  | 'code'
  | 'megaphone'
  | 'at'
  | 'activity'
  | 'reset'
  | 'pin'
  | 'bell-off'
  | 'link'
  | 'shield'
  | 'copy'
  | 'keyboard'
  | 'download'
  | 'minus'
  | 'maximize'
  | 'camera-flip';

const PATHS: Record<IconName, string[]> = {
  mic: ['M12 3 a3 3 0 0 1 3 3 v5 a3 3 0 0 1 -6 0 V6 a3 3 0 0 1 3 -3 Z', 'M5 11 a7 7 0 0 0 14 0', 'M12 18 V21 M9 21 H15'],
  'mic-off': ['M12 3 a3 3 0 0 1 3 3 v5 a3 3 0 0 1 -6 0 V6 a3 3 0 0 1 3 -3 Z', 'M5 11 a7 7 0 0 0 14 0', 'M4 4 L20 20'],
  headphones: ['M4 14 v-2 a8 8 0 0 1 16 0 v2', 'M3 14 h4 v6 h-4 z', 'M17 14 h4 v6 h-4 z'],
  'headphones-off': ['M4 14 v-2 a8 8 0 0 1 16 0 v2', 'M3 14 h4 v6 h-4 z', 'M17 14 h4 v6 h-4 z', 'M3 3 L21 21'],
  'screen-share': ['M3 4 h18 v13 h-18 z', 'M8 21 H16 M12 17 V21', 'M12 13 V8 M9.5 10.5 L12 8 L14.5 10.5'],
  camera: ['M3 7 a2 2 0 0 1 2 -2 h8 a2 2 0 0 1 2 2 v10 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z', 'M15 10 L21 7 V17 L15 14'],
  'camera-off': [
    'M3 7 a2 2 0 0 1 2 -2 h8 a2 2 0 0 1 2 2 v10 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z',
    'M15 10 L21 7 V17 L15 14',
    'M3 3 L21 21',
  ],
  // expand-to-fullscreen: four corner brackets
  maximize: ['M9 4 H4 V9', 'M15 4 H20 V9', 'M9 20 H4 V15', 'M15 20 H20 V15'],
  // flip front/rear camera (Claude Design, docs/design/design-step8) — camera body + rotation arrows
  'camera-flip': [
    'M4 8 a2 2 0 0 1 2 -2 h1.5 l1 -1.5 h5 l1 1.5 H18 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 H6 a2 2 0 0 1 -2 -2 Z',
    'M9.6 13.2 a2.6 2.6 0 0 1 4.2 -2',
    'M13.9 8.7 L13.9 11.2 L11.4 11.2',
    'M14.4 12.8 a2.6 2.6 0 0 1 -4.2 2',
    'M10.1 17.3 L10.1 14.8 L12.6 14.8',
  ],
  leave: ['M14 4 H6 a2 2 0 0 0 -2 2 v12 a2 2 0 0 0 2 2 h8', 'M13 12 H21 M18 9 L21 12 L18 15'],
  hash: ['M10 4 L8 20 M16 4 L14 20 M5 9 H19 M4 15 H18'],
  volume: ['M5 9 H8 L12 5 V19 L8 15 H5 Z', 'M16 9 a4 4 0 0 1 0 6', 'M18.5 7 a7 7 0 0 1 0 10'],
  plus: ['M12 5 V19 M5 12 H19'],
  // Плеер голосовых (#20).
  play: ['M8 5 L19 12 L8 19 Z'],
  pause: ['M9 5 V19 M15 5 V19'],
  settings: [
    'M4 7 H20 M4 17 H20',
    'M9 4.4 a2.6 2.6 0 1 0 0 5.2 a2.6 2.6 0 0 0 0 -5.2 Z',
    'M15 14.4 a2.6 2.6 0 1 0 0 5.2 a2.6 2.6 0 0 0 0 -5.2 Z',
  ],
  users: [
    'M9 8 a3.2 3.2 0 1 0 0 6.4 a3.2 3.2 0 0 0 0 -6.4 Z',
    'M3 20 a6 6 0 0 1 12 0',
    'M16 6 a3 3 0 0 1 0 6',
    'M16.5 14 a6 6 0 0 1 4.5 6',
  ],
  'user-plus': ['M9 8 a3.2 3.2 0 1 0 0 6.4 a3.2 3.2 0 0 0 0 -6.4 Z', 'M3 20 a6 6 0 0 1 12 0', 'M18 7 V13 M15 10 H21'],
  search: ['M11 5 a6 6 0 1 0 0 12 a6 6 0 0 0 0 -12 Z', 'M20 20 L16 16'],
  paperclip: ['M20 12 L11.5 20 a4.5 4.5 0 0 1 -6.4 -6.4 L13 5.6 a3 3 0 0 1 4.3 4.2 L9.4 17.4'],
  send: ['M21 4 L3 11 L10 13.2 L12.2 20 Z', 'M21 4 L10 13.2'],
  reaction: ['M12 3.5 a8.5 8.5 0 1 0 0 17 a8.5 8.5 0 0 0 0 -17 Z', 'M9 14.5 a4 4 0 0 0 6 0', 'M9.2 10 v.01 M14.8 10 v.01'],
  // Загнутый уголок — узнаваемая метафора наклейки; смайл в круге уже занят «реакцией».
  sticker: ['M4 5 a1 1 0 0 1 1 -1 h14 a1 1 0 0 1 1 1 v8 l-7 7 H5 a1 1 0 0 1 -1 -1 Z', 'M20 13 h-6 a1 1 0 0 0 -1 1 v6'],
  reply: ['M9 8 L4 13 L9 18', 'M4 13 H15 a4 4 0 0 1 4 4 V19'],
  more: ['M5 12 v.01 M12 12 v.01 M19 12 v.01'],
  signal: ['M5 19 V15 M12 19 V10 M19 19 V5'],
  close: ['M6 6 L18 18 M18 6 L6 18'],
  edit: ['M4 20 h4 L18 10 a2 2 0 0 0 -3 -3 L5 17 Z', 'M13 7 L17 11'],
  trash: ['M4 7 H20', 'M9 7 V5 a1 1 0 0 1 1 -1 h4 a1 1 0 0 1 1 1 V7', 'M6 7 L7 20 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 L18 7'],
  'chevron-down': ['M6 9 L12 15 L18 9'],
  'chevron-right': ['M9 6 L15 12 L9 18'],
  'chevron-left': ['M15 6 L9 12 L15 18'],
  mail: ['M3 5 h18 v14 h-18 z', 'M3 7 L12 13 L21 7'],
  lock: ['M5 11 h14 v9 h-14 z', 'M8 11 V8 a4 4 0 0 1 8 0 v3'],
  'lock-open': ['M5 11 h14 v9 h-14 z', 'M8 11 V7 a4 4 0 0 1 8 0'],
  user: ['M12 7 a3.5 3.5 0 1 0 0 7 a3.5 3.5 0 0 0 0 -7 Z', 'M5 20 a7 7 0 0 1 14 0'],
  eye: ['M2 12 s4 -7 10 -7 s10 7 10 7 s-4 7 -10 7 s-10 -7 -10 -7 Z', 'M12 9 a3 3 0 1 0 0 6 a3 3 0 0 0 0 -6 Z'],
  check: ['M5 12 L10 17 L19 7'],
  'volume-off': ['M5 9 H8 L12 5 V19 L8 15 H5 Z', 'M16 9 L22 15 M22 9 L16 15'],
  logout: ['M14 4 H6 a2 2 0 0 0 -2 2 v12 a2 2 0 0 0 2 2 h8', 'M13 12 H21 M18 9 L21 12 L18 15'],
  ban: ['M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18', 'M5.6 5.6 L18.4 18.4'],
  // --- channel-icon palette extras (see CHANNEL_ICONS in shared) ---
  music: ['M3 17 a3 3 0 1 0 6 0 a3 3 0 0 0 -6 0', 'M13 17 a3 3 0 1 0 6 0 a3 3 0 0 0 -6 0', 'M9 17 V4 H19 v13', 'M9 8 H19'],
  star: ['M12 4 L14.09 8.26 L18.9 8.97 L15.45 12.32 L16.27 17.02 L12 14.81 L7.73 17.02 L8.55 12.32 L5.1 8.97 L9.91 8.26 Z'],
  /**
   * Корона победителя сезона (нарисовал Codex).
   *
   * 🔴 Три опорных зубца и отдельная нижняя грань — не украшательство, а условие читаемости: корона
   * рисуется 12 px в списке канала, где обводка вырождается в пиксель, и узнаётся она только
   * силуэтом. Любой внутренний орнамент на этом размере превращается в кляксу.
   */
  crown: ['M4 18H20', 'M5 16L3 6L9 11L12 4L15 11L21 6L19 16Z'],

  bell: [
    'M10 5 a2 2 0 1 1 4 0 a7 7 0 0 1 4 6 v3 a4 4 0 0 0 2 3 H4 a4 4 0 0 0 2 -3 v-3 a7 7 0 0 1 4 -6',
    'M9 17 v1 a3 3 0 0 0 6 0 v-1',
  ],
  bolt: ['M13 3 L13 10 L19 10 L11 21 L11 14 L5 14 Z'],
  gamepad: [
    'M4 6 H20 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 H4 a2 2 0 0 1 -2 -2 V8 a2 2 0 0 1 2 -2 Z',
    'M6 12 H10 M8 10 V14',
    'M14.5 11.5 v.01',
    'M17.5 13.5 v.01',
  ],
  flame: [
    'M12 12 c2 -2.96 0 -7 -1 -8 c0 3.038 -1.773 4.741 -3 6 c-1.226 1.26 -2 3.24 -2 5 a6 6 0 1 0 12 0 c0 -1.532 -1.056 -3.94 -2 -5 c-1.786 3 -2.791 3 -4 2 Z',
  ],
  heart: ['M19.5 12.572 L12 20 L4.5 12.572 a5 5 0 1 1 7.5 -6.566 a5 5 0 1 1 7.5 6.572'],
  code: ['M7 8 L3 12 L7 16', 'M17 8 L21 12 L17 16', 'M14 4 L10 20'],
  megaphone: [
    'M18 8 a3 3 0 0 1 0 6',
    'M10 8 V19 a1 1 0 0 1 -1 1 H8 a1 1 0 0 1 -1 -1 v-5',
    'M12 8 L16.5 4.2 a0.9 0.9 0 0 1 1.5 0.7 v12.2 a0.9 0.9 0 0 1 -1.5 0.7 L12 14 H4 a1 1 0 0 1 -1 -1 v-3 a1 1 0 0 1 1 -1 Z',
  ],
  pin: ['M15 4.5 L11 8.5 L7 10 L5.5 11.5 L12.5 18.5 L14 17 L15.5 13 L19.5 9', 'M9 15 L4.5 19.5', 'M14.5 4 L20 9.5'],
  at: ['M12 8.5 a3.5 3.5 0 1 0 0 7 a3.5 3.5 0 0 0 0 -7 Z', 'M15.5 12 v1.5 a2.5 2.5 0 0 0 5 0 V12 a8.5 8.5 0 1 0 -3 6.5'],
  // pulse/waveform for "connection info"; matches the design-step6 activity glyph
  activity: ['M3 12 h3 l2 -6 l4 14 l3 -10 l2 4 h4'],
  // circular refresh arrow for "reset volume to 100%"
  reset: ['M4 12 a8 8 0 1 0 2.3 -5.7', 'M4 4 v3 h3'],
  // muted channel — the bell glyph with a diagonal slash
  'bell-off': [
    'M10 5 a2 2 0 1 1 4 0 a7 7 0 0 1 4 6 v3 a4 4 0 0 0 2 3 H4 a4 4 0 0 0 2 -3 v-3 a7 7 0 0 1 4 -6',
    'M9 17 v1 a3 3 0 0 0 6 0 v-1',
    'M3 3 L21 21',
  ],
  link: ['M9 15 L15 9', 'M10 6 l2 -2 a4 4 0 0 1 6 6 l-2 2', 'M14 18 l-2 2 a4 4 0 0 1 -6 -6 l2 -2'],
  /**
   * Щит — он же ЗНАК ГЕНЕРАЛА канала (раньше там стояла звезда).
   *
   * 🔴 Звезда в интерфейсах почти всегда значит «избранное», а генерал — это роль. Разбор Codex, и
   * он прав. Его вариант с двумя лычками я отрисовал в рабочих размерах и отверг по той же причине,
   * только хуже: пара шевронов рядом с ником читается как «развернуть», то есть как ЭЛЕМЕНТ
   * УПРАВЛЕНИЯ, а не как отметка. Щит на 11 px держит силуэт и однозначно говорит про роль.
   * ⚠️ `star` оставлен в наборе — он пригодится там, где «избранное» и имеется в виду.
   */
  shield: ['M12 3 l7 4 v5 c0 4 -3 7 -7 9 c-4 -2 -7 -5 -7 -9 V7 Z'],
  copy: ['M9 9 h11 v11 h-11 z', 'M5 15 H4 V4 h11 v1'],
  keyboard: ['M3 6 h18 v12 h-18 z', 'M7 10 v.01 M11 10 v.01 M15 10 v.01 M7 14 h10'],
  download: ['M12 4 V15', 'M8 11 L12 15 L16 11', 'M5 19 H19'],
  minus: ['M5 12 H19'],
};

/**
 * Resolve a channel's display icon: its custom `icon` if it names a known glyph, else the
 * channel-type default (# for text, volume for voice). Used everywhere a channel is shown.
 */
export function channelIcon(c: { type: 'text' | 'voice'; icon?: string | null }): IconName {
  if (c.icon && c.icon in PATHS) return c.icon as IconName;
  return c.type === 'voice' ? 'volume' : 'hash';
}

/** True when a channel's icon is a custom uploaded image (a URL) rather than a palette glyph. */
export function isCustomIcon(icon?: string | null): boolean {
  return !!icon && /^https?:\/\//.test(icon);
}

/** Render a channel's icon: a custom uploaded image, else a palette/type-default glyph. */
export function ChannelGlyph({ c, size = 18 }: { c: { type: 'text' | 'voice'; icon?: string | null }; size?: number }) {
  if (isCustomIcon(c.icon)) {
    return <img className="ch-glyph" src={c.icon as string} alt="" width={size} height={size} />;
  }
  return <Icon name={channelIcon(c)} size={size} />;
}

export function Icon({
  name,
  size = 18,
  stroke = 2,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      // gv-icon pins flex-shrink:0 — without it an SVG icon collapses horizontally inside a
      // flex button (the 13px quality gear was rendering 0px wide → invisible).
      className={className ? `gv-icon ${className}` : 'gv-icon'}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
