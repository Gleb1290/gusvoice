import { useNameResolver } from '../memberName';
import { useStore } from '../store';
import { toggleSelfMute } from '../voiceSelf';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * Mobile minimized call chip (design-step8 B3): the single persistent voice surface shown above the tab
 * bar while connected to voice. Replaces the desktop VoicePanel + SelfVoiceBar stack so mobile never has
 * three stacked bottom bars. Tap it to open the call view; quick mic toggle + red hang-up.
 *
 * Reads everything from the store (presence + liveVoice), so it works over ANY sidebar (channels or DMs)
 * without needing a LiveKit RoomContext. Rendered by MainLayout on the mobile build while `voice` is set.
 */
export function MobileCallChip() {
  const voice = useStore((s) => s.voice);
  const bootstrap = useStore((s) => s.bootstrap);
  const presence = useStore((s) => s.presence);
  const liveVoice = useStore((s) => s.liveVoice);
  const selfMuted = useStore((s) => s.selfMuted);
  const openChannel = useStore((s) => s.openChannel);
  const leaveVoice = useStore((s) => s.leaveVoice);
  const nameOf = useNameResolver();
  if (!voice) return null;

  const channel = bootstrap?.channels.find((c) => c.id === voice.channelId);
  const here = presence[voice.channelId] ?? [];
  const speaker = here.find((p) => liveVoice[p.userId]?.speaking);
  // Presence про ники не знает — подставляем из ростера (#73).
  const sub = speaker
    ? `${nameOf(speaker.userId, speaker.displayName)} говорит`
    : here.length
      ? `${here.length} в канале`
      : 'В канале';

  return (
    <div className="call-chip" role="button" tabIndex={0} onClick={() => openChannel(voice.channelId)}>
      <div className="cc-avas">
        {here.slice(0, 3).map((p) => (
          <span key={p.userId} className={`cc-ava ${liveVoice[p.userId]?.speaking ? 'speaking' : ''}`}>
            <Avatar url={p.avatarUrl} name={nameOf(p.userId, p.displayName)} size={32} fallback="icon" />
          </span>
        ))}
      </div>
      <div className="cc-info">
        <div className="cc-title">
          <span className="cc-dot" />
          {channel?.name ?? 'Голос'}
        </div>
        <div className="cc-sub">{sub}</div>
      </div>
      <button
        type="button"
        className={`cc-btn ${selfMuted ? 'off' : ''}`}
        title={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        onClick={(e) => {
          e.stopPropagation();
          toggleSelfMute();
        }}
      >
        <Icon name={selfMuted ? 'mic-off' : 'mic'} size={20} />
      </button>
      <button
        type="button"
        className="cc-btn leave"
        title="Отключиться"
        onClick={(e) => {
          e.stopPropagation();
          leaveVoice();
        }}
      >
        <Icon name="leave" size={20} />
      </button>
    </div>
  );
}
