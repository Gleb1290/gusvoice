import { urlBelongsToBucket } from './storageRules.js';

const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${UUID}$`, 'i');
const clipPattern = new RegExp(`^sounds/(${UUID})-sb-(${UUID})-[0-9]+\\.(?:mp3|ogg|wav|webm|m4a|bin)$`, 'i');
const eventPattern = new RegExp(`^sounds/(ch-)?(${UUID})-[a-z][a-z0-9]*-[0-9]+\\.[a-z0-9]+$`, 'i');
const appearancePattern = new RegExp(`^(server-icons|coin-icons|channel-icons)/(${UUID})-[0-9]+\\.[a-z0-9]+$`, 'i');

export function publicStorageKey(url: string, publicUrl: string, bucket: string): string | null {
  if (!urlBelongsToBucket(url, publicUrl, bucket)) return null;
  const target = new URL(url);
  if (target.username || target.password) return null;
  const basePath = new URL(publicUrl).pathname.replace(/\/+$/, '');
  try {
    const key = decodeURIComponent(target.pathname.slice(`${basePath}/${bucket}/`.length));
    return key || null;
  } catch {
    return null;
  }
}

export function soundboardObjectScope(key: string): { serverId: string; clipId: string } | null {
  const match = clipPattern.exec(key);
  return match ? { serverId: match[1]!, clipId: match[2]! } : null;
}

export function ownedSoundboardObjectKey(
  serverId: string, clipId: string, url: string, publicUrl: string, bucket: string,
): string | null {
  if (!uuidPattern.test(serverId) || !uuidPattern.test(clipId)) return null;
  const key = publicStorageKey(url, publicUrl, bucket);
  if (!key) return null;
  const scope = soundboardObjectScope(key);
  return scope?.serverId === serverId && scope.clipId === clipId ? key : null;
}

export function eventSoundObjectScope(key: string): { id: string; channel: boolean } | null {
  const match = eventPattern.exec(key);
  return match ? { id: match[2]!, channel: Boolean(match[1]) } : null;
}

export function appearanceObjectScope(key: string): { id: string; channel: boolean } | null {
  const match = appearancePattern.exec(key);
  return match ? { id: match[2]!, channel: match[1] === 'channel-icons' } : null;
}
