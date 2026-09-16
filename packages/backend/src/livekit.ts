import { AccessToken, ParticipantPermission, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { env } from './env.js';
import { publishGrant, voiceTokenMetadata } from './livekitRules.js';

const roomService = new RoomServiceClient(env.livekit.urlInternal, env.livekit.apiKey, env.livekit.apiSecret);

/**
 * Server-mute (or unmute) a participant's microphone. We enforce it by REVOKING the
 * MICROPHONE publish grant rather than soft-muting the live track: a plain
 * `mutePublishedTrack` is a mute the client can immediately toggle back on, and its unmute
 * direction needs LiveKit's `enable_remote_unmute` which our self-hosted SFU doesn't set
 * (it errors "remote unmute not enabled"). Updating the grant both stops the current mic
 * and blocks re-publishing it until a moderator unmutes. No-op if they aren't in the room.
 *
 * `permissions` are the target's resolved channel permissions — needed to restore the
 * correct set of allowed sources on unmute (and to keep camera/screen rights intact while muted).
 */
export async function serverMute(room: string, identity: string, muted: boolean, permissions: bigint): Promise<void> {
  const parts = await roomService.listParticipants(room);
  if (!parts.some((x) => x.identity === identity)) return;
  await roomService.updateParticipant(room, identity, {
    permission: new ParticipantPermission({
      canSubscribe: true,
      ...publishGrant(permissions, muted),
      canUpdateMetadata: true,
    }),
  });
}

/** Move a participant from one voice room to another. */
export async function moveUser(fromRoom: string, identity: string, toRoom: string): Promise<void> {
  await roomService.moveParticipant(fromRoom, identity, toRoom);
}

/** Disconnect a participant from a voice room (they leave the call, not the server). */
export async function disconnectUser(room: string, identity: string): Promise<void> {
  await roomService.removeParticipant(room, identity);
}

/**
 * Enforce single-channel voice presence: remove `identity` from every active voice room EXCEPT
 * `keepRoom`. Called when a user joins/switches channels — a quick move→switch can leave a stale
 * (ghost) participant in the previous room (its leave didn't propagate before the new join), so the
 * user shows up in two channels at once. Best-effort: removeParticipant 404s for rooms they aren't in.
 */
export async function removeFromOtherRooms(identity: string, keepRoom: string): Promise<void> {
  let rooms: { name: string; numParticipants: number }[];
  try {
    rooms = await roomService.listRooms();
  } catch {
    return;
  }
  await Promise.all(
    rooms
      .filter((r) => r.name !== keepRoom && r.numParticipants > 0)
      .map((r) =>
        roomService.removeParticipant(r.name, identity).catch(() => {
          /* not in that room — ignore */
        }),
      ),
  );
}

/**
 * Mint a LiveKit access token for a voice channel. Publish rights are gated at the
 * SFU per the member's permissions: SPEAK -> microphone, VIDEO -> camera,
 * SHARE_SCREEN -> screen (the legacy STREAM bit grants both). Enforced by LiveKit itself.
 */
export async function createVoiceToken(opts: {
  identity: string;
  name: string;
  room: string;
  permissions: bigint;
  avatarUrl?: string | null;
  /** If they're currently server-muted, mint the token WITHOUT mic so the mute survives (re)joins. */
  serverMuted?: boolean;
}): Promise<string> {
  const at = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
    identity: opts.identity,
    name: opts.name,
    ttl: '4h',
    // Carried through to LiveKit webhooks: avatar for presence, priority for speaker ordering.
    metadata: voiceTokenMetadata(opts.permissions, opts.avatarUrl),
  });
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canSubscribe: true,
    ...publishGrant(opts.permissions, opts.serverMuted),
    canUpdateOwnMetadata: true, // lets the client publish its own deafen state via participant attributes
  });
  return at.toJwt();
}

/**
 * Токен для проверки голоса из браузера (мастер установки, шаг «Готово»). Служебная комната
 * `setup-voice-test-*`: presence такие не трогает (не `channel_*`), публиковать нельзя — подключения
 * хватает, чтобы проверить, доходят ли до сервера медиа-порты 7881/tcp и 7882/udp. Живёт 10 минут.
 */
export async function createVoiceTestToken(identity: string, room: string): Promise<string> {
  const at = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, { identity, ttl: '10m' });
  at.addGrant({ roomJoin: true, room, canSubscribe: true, canPublish: false, canPublishData: false });
  return at.toJwt();
}

/**
 * Mint a token for the COMPANION "#screen" participant that publishes a native (desktop) screen
 * share. The desktop app connects this as a second participant alongside the user's voice
 * participant and publishes the natively-captured screen — bypassing WebView2's getDisplayMedia
 * picker. Publish-only (no subscribe); the `screenOwner` metadata lets clients merge its video onto
 * the owner's tile. Caller must have already verified SHARE_SCREEN permission for the channel.
 */
export async function createScreenShareToken(opts: {
  userId: string;
  name: string;
  room: string;
}): Promise<string> {
  const at = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
    identity: `${opts.userId}#screen`,
    name: opts.name,
    ttl: '4h',
    metadata: JSON.stringify({ screenOwner: opts.userId }),
  });
  at.addGrant({
    roomJoin: true,
    room: opts.room,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}
