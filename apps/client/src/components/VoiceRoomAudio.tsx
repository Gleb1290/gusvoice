import { AudioTrack, useTracks, type TrackReference } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useSyncExternalStore } from 'react';
import { subscribeUserAudio, userPlaybackGain } from '../localUserAudio';
import { useStore } from '../store';
import { streamAudioVolume } from '../streamAudioRules';
import { streamsInView } from '../streamPipRules';

function ParticipantAudio({ trackRef, instanceId }: { trackRef: TrackReference; instanceId?: string | null }) {
  const audible = useSyncExternalStore(subscribeUserAudio, () => userPlaybackGain(trackRef.participant.identity, instanceId) > 0);
  return audible ? <AudioTrack trackRef={trackRef} /> : null;
}

function ScreenAudio({ trackRef }: { trackRef: TrackReference }) {
  const audible = useStore((s) => streamAudioVolume(
    trackRef.participant.identity, streamsInView(s.watchedStreams, s.pipStreams), s.mutedStreams, (id) => s.streamVolumes[id] ?? 1,
  ) > 0);
  return audible ? <AudioTrack trackRef={trackRef} /> : null;
}

/** LiveKit 2.20 skips a cached volume of zero on attach. Keep silent tracks off the output entirely. */
export function VoiceRoomAudio({ deafened, instanceId }: { deafened: boolean; instanceId?: string | null }) {
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown], {
    updateOnlyOn: [], onlySubscribed: true,
  });
  if (deafened) return null;
  return (
    <div hidden>
      {tracks.map((ref) => {
        if (ref.participant.isLocal || ref.publication.kind !== Track.Kind.Audio) return null;
        const key = ref.publication.trackSid;
        return ref.source === Track.Source.ScreenShareAudio
          ? <ScreenAudio key={key} trackRef={ref} />
          : <ParticipantAudio key={key} trackRef={ref} instanceId={instanceId} />;
      })}
    </div>
  );
}
