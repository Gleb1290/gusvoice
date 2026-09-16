import { useParticipants } from '@livekit/components-react';
import { ParticipantEvent, type Participant } from 'livekit-client';
import { useEffect, useState } from 'react';
import { useUserAudio } from '../localUserAudio';
import { useNameResolver } from '../memberName';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { useUserMenu, type UserMenuTarget } from './UserContextMenu';

export function avatarFromMetadata(metadata?: string): string | null {
  if (!metadata) return null;
  try {
    return (JSON.parse(metadata) as { avatarUrl?: string | null }).avatarUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Reactive mic-muted / deafened / screen-share state for a participant. `isMicrophoneEnabled`
 * etc. are plain properties, so we re-render on the relevant participant events (otherwise a
 * remote member muting their mic wouldn't update). Deafen is carried in a participant attribute
 * we publish from VoiceConnection (LiveKit has no native deafen concept).
 */
export function useParticipantFlags(p: Participant) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const rerender = () => setTick((t) => t + 1);
    p.on(ParticipantEvent.TrackMuted, rerender)
      .on(ParticipantEvent.TrackUnmuted, rerender)
      .on(ParticipantEvent.TrackPublished, rerender)
      .on(ParticipantEvent.TrackUnpublished, rerender)
      .on(ParticipantEvent.AttributesChanged, rerender);
    return () => {
      p.off(ParticipantEvent.TrackMuted, rerender)
        .off(ParticipantEvent.TrackUnmuted, rerender)
        .off(ParticipantEvent.TrackPublished, rerender)
        .off(ParticipantEvent.TrackUnpublished, rerender)
        .off(ParticipantEvent.AttributesChanged, rerender);
    };
  }, [p]);

  return {
    // A push-to-talk user's mic is off between key-presses — idle, not muted. Don't flag it (peers read
    // the `ptt` attribute VoiceConnection broadcasts). Server-mute is shown separately via presence.
    micMuted: !p.isMicrophoneEnabled && p.attributes?.ptt !== '1',
    deafened: p.attributes?.deafened === '1',
    screenSharing: p.isScreenShareEnabled,
  };
}

/**
 * Speaking state for the green ring — read from our LOCAL audio-level VAD, which VoiceConnection writes
 * into the store's `liveVoice` for every participant in the joined channel. We deliberately do NOT use
 * LiveKit's `useIsSpeaking` / `participant.isSpeaking`: that's the SFU's server-side flag (round-trip
 * lag on your own ring + flicker in word gaps). Falls back to false when no live state is present.
 */
export function useLiveSpeaking(identity: string): boolean {
  return useStore((s) => s.liveVoice[identity]?.speaking ?? false);
}

function ParticipantRow({
  p,
  channelId,
  openMenu,
}: {
  p: Participant;
  channelId: string | null;
  openMenu: (e: React.MouseEvent, target: UserMenuTarget) => void;
}) {
  const speaking = useLiveSpeaking(p.identity);
  const { micMuted, deafened, screenSharing } = useParticipantFlags(p);
  const { muted: locallyMuted } = useUserAudio(p.identity);
  const serverMuted = useStore(
    (s) => (channelId ? s.presence[channelId]?.find((x) => x.userId === p.identity)?.serverMuted : false) ?? false,
  );
  const nameOf = useNameResolver();

  // Имя в токене LiveKit вшито на 4 часа, поэтому ник подставляем из ростера на отрисовке (#73).
  const name = nameOf(p.identity, p.name || p.identity);
  const target: UserMenuTarget = {
    userId: p.identity,
    name,
    avatarUrl: avatarFromMetadata(p.metadata),
    participant: p,
    voiceChannelId: channelId,
    serverMuted,
  };

  // A deafened member also has their mic off, so show just the deafen badge (it implies muted).
  return (
    <li
      className={`vp-row ${speaking ? 'speaking' : ''}`}
      onContextMenu={p.isLocal ? undefined : (e) => openMenu(e, target)}
    >
      <Avatar url={avatarFromMetadata(p.metadata)} name={name} size={30} />
      <span className="vp-name">
        {name}
        {p.isLocal ? ' (вы)' : ''}
      </span>
      <span className="vp-icons">
        {screenSharing ? (
          <span className="vp-flag" title="Показывает экран">
            <Icon name="screen-share" size={15} />
          </span>
        ) : null}
        {deafened ? (
          <span className="vp-flag off" title="Звук выключен (деафен)">
            <Icon name="headphones-off" size={15} />
          </span>
        ) : micMuted ? (
          <span className="vp-flag off" title="Микрофон выключен">
            <Icon name="mic-off" size={15} />
          </span>
        ) : null}
        {!p.isLocal && locallyMuted ? (
          <span className="vp-flag off" title="Заглушён только для вас">
            <Icon name="volume-off" size={15} />
          </span>
        ) : null}
      </span>
      {!p.isLocal && (
        <button type="button" className="vp-menu-btn" title="Действия" onClick={(e) => openMenu(e, target)}>
          <Icon name="more" size={16} />
        </button>
      )}
    </li>
  );
}

export function VoiceParticipants() {
  const participants = useParticipants();
  const channelId = useStore((s) => s.voice?.channelId ?? null);
  const { open, menu } = useUserMenu();
  return (
    <>
      <ul className="voice-participants">
        {/* Native screen-share companions ("<id>#screen") are publish-only ghosts — keep them out of
            the participant list (their stream still renders on the stage under the owner's name). */}
        {participants
          .filter((p) => !p.identity.endsWith('#screen'))
          .map((p) => (
            <ParticipantRow key={p.sid || p.identity} p={p} channelId={channelId} openMenu={open} />
          ))}
      </ul>
      {menu}
    </>
  );
}
