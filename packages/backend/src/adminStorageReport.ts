import {
  appearanceObjectScope,
  eventSoundObjectScope,
  soundboardObjectScope,
} from './storageObjectKeys.js';

type ServerBytes = 'soundboardBytes' | 'eventSoundsBytes' | 'channelAttachmentsBytes' | 'appearanceBytes';
type InstanceBytes = 'directMessagesBytes' | 'avatarsBytes' | 'unassignedBytes';

export type StorageReference = {
  url: string;
  serverId: string | null;
  category: ServerBytes | 'directMessagesBytes';
};

export type StorageClip = {
  id: string;
  serverId: string;
  url: string;
  userId: string | null;
  name: string | null;
};

export type StoredObject = { bucket: 'public' | 'private'; key: string; size: number };
export type StorageCatalog = {
  servers: readonly { id: string; name: string }[];
  channels: readonly { id: string; serverId: string }[];
  clips: readonly StorageClip[];
  references: Iterable<StorageReference>;
  privateAttachmentKeys: ReadonlySet<string>;
};

type Author = { userId: string | null; name: string | null; clips: number; bytes: number };
type ServerUsage = Record<ServerBytes, number> & {
  id: string;
  name: string;
  totalBytes: number;
  soundboardClips: number;
  soundboardAuthors: Author[];
};

export type StorageReport = {
  measuredAt: string;
  servers: ServerUsage[];
  instance: Record<InstanceBytes, number> & { totalBytes: number };
  totalBytes: number;
};

type ServerEntry = { usage: ServerUsage; authors: Map<string | null, Author> };

type Allocation =
  | { serverId: string; category: ServerBytes; userId?: string | null }
  | { serverId: null; category: InstanceBytes };

const unassigned: Allocation = { serverId: null, category: 'unassignedBytes' };

export async function measureStorage(
  catalog: StorageCatalog,
  objects: AsyncIterable<StoredObject>,
  publicKey: (url: string) => string | null,
  now = Date.now,
): Promise<StorageReport> {
  const servers = new Map<string, ServerEntry>(catalog.servers.map(({ id, name }) => {
    const usage: ServerUsage = {
      id, name, totalBytes: 0, soundboardBytes: 0, eventSoundsBytes: 0, channelAttachmentsBytes: 0,
      appearanceBytes: 0, soundboardClips: 0, soundboardAuthors: [],
    };
    return [id, { usage, authors: new Map<string | null, Author>() }] as const;
  }));
  const channelOwners = new Map(catalog.channels.map(channel => [channel.id, channel.serverId]));
  const clipById = new Map(catalog.clips.map(clip => [clip.id, clip]));
  const publicReferences = new Map<string, Allocation>();
  const instance = { directMessagesBytes: 0, avatarsBytes: 0, unassignedBytes: 0, totalBytes: 0 };

  function claim(key: string, allocation: Allocation): void {
    const previous = publicReferences.get(key);
    if (!previous) {
      publicReferences.set(key, allocation);
    } else if (previous.serverId !== allocation.serverId || previous.category !== allocation.category) {
      publicReferences.set(key, unassigned);
    } else if ('userId' in previous && 'userId' in allocation && previous.userId !== allocation.userId) {
      publicReferences.set(key, { ...previous, userId: null });
    }
  }

  for (const ref of catalog.references) {
    const key = publicKey(ref.url);
    if (!key) continue;
    // Вложения сообщений могут ссылаться на любой публичный URL нашего бакета.
    // Владение по такой ссылке применимо только к ключам публичных вложений.
    if (ref.category === 'channelAttachmentsBytes' || ref.category === 'directMessagesBytes') {
      if (!key.startsWith('attachments/')) continue;
    }
    if (ref.category === 'directMessagesBytes') {
      claim(key, { serverId: null, category: ref.category });
    } else {
      claim(key, ref.serverId ? { serverId: ref.serverId, category: ref.category } : unassigned);
    }
  }

  function author(
    server: ServerEntry,
    userId: string | null, name: string | null = null,
  ): Author {
    let row = server.authors.get(userId);
    if (!row) {
      row = { userId, name, clips: 0, bytes: 0 };
      server.authors.set(userId, row);
      server.usage.soundboardAuthors.push(row);
    }
    return row;
  }

  for (const clip of catalog.clips) {
    const server = servers.get(clip.serverId);
    if (!server) continue;
    server.usage.soundboardClips++;
    author(server, clip.userId, clip.name).clips++;
    const key = publicKey(clip.url);
    if (key) claim(key, { serverId: clip.serverId, category: 'soundboardBytes', userId: clip.userId });
  }

  function allocate({ bucket, key }: StoredObject): Allocation {
    if (bucket === 'private') {
      return key.startsWith('dm/') || catalog.privateAttachmentKeys.has(key)
        ? { serverId: null, category: 'directMessagesBytes' }
        : unassigned;
    }

    // У ключей с однозначным владельцем учитываем и прошлые версии, даже если ссылки уже удалены.
    const clipScope = soundboardObjectScope(key);
    if (clipScope) {
      const clip = clipById.get(clipScope.clipId);
      return {
        serverId: clipScope.serverId, category: 'soundboardBytes',
        userId: clip?.serverId === clipScope.serverId ? clip.userId : null,
      };
    }

    const event = eventSoundObjectScope(key);
    if (event) {
      const serverId = event.channel ? channelOwners.get(event.id) : event.id;
      return serverId ? { serverId, category: 'eventSoundsBytes' } : unassigned;
    }

    const appearance = appearanceObjectScope(key);
    if (appearance) {
      const serverId = appearance.channel ? channelOwners.get(appearance.id) : appearance.id;
      return serverId ? { serverId, category: 'appearanceBytes' } : unassigned;
    }

    if (key.startsWith('avatars/') || key.startsWith('peer-avatars/') || key.startsWith('group-avatars/')) {
      return { serverId: null, category: 'avatarsBytes' };
    }

    return publicReferences.get(key) ?? unassigned;
  }

  const seen = { public: new Set<string>(), private: new Set<string>() };
  let totalBytes = 0;
  for await (const object of objects) {
    if (seen[object.bucket].has(object.key)) continue;
    seen[object.bucket].add(object.key);
    const { size } = object;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(totalBytes + size)) {
      throw new Error('invalid storage size');
    }
    totalBytes += size;
    const allocation = allocate(object);
    if (allocation.serverId === null) {
      instance[allocation.category] += size;
      instance.totalBytes += size;
      continue;
    }
    const server = servers.get(allocation.serverId);
    if (!server) {
      instance.unassignedBytes += size;
      instance.totalBytes += size;
      continue;
    }
    server.usage[allocation.category] += size;
    server.usage.totalBytes += size;
    if (allocation.category === 'soundboardBytes') author(server, allocation.userId ?? null).bytes += size;
  }

  return {
    measuredAt: new Date(now()).toISOString(),
    servers: [...servers.values()].map(({ usage }) => usage),
    instance,
    totalBytes,
  };
}

/** Все одновременные запросы делят полный снимок. После сбоя даём хранилищу короткую паузу перед повтором. */
export function createStorageReportReader(measure: () => Promise<StorageReport>, now = Date.now) {
  let pending: Promise<StorageReport> | undefined;
  let cached: { until: number; result: Promise<StorageReport> } | undefined;

  return function read(): Promise<StorageReport> {
    if (pending) return pending;
    if (cached && now() < cached.until) return cached.result;

    const measurement = Promise.resolve().then(measure);
    pending = measurement;
    const remember = (ttl: number) => {
      cached = { until: now() + ttl, result: measurement };
      pending = undefined;
    };
    void measurement.then(() => remember(60_000), () => remember(5_000));
    return measurement;
  };
}
