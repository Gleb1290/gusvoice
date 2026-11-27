import type { Channel } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { ChannelAccessCheck } from './ChannelAccessCheck';
import { OverwriteEditor, type OverwriteSource, TEXT_PERMS, VOICE_PERMS } from './OverwriteEditor';

/**
 * Per-channel permission overwrites. A channel ALWAYS inherits its category's permissions; the
 * overwrites set here OVERRIDE the category on conflict — e.g. marking the channel private wins over a
 * category-wide grant, so access is then only for the roles/members explicitly allowed here. A channel
 * with no overwrites of its own purely follows its category.
 */
export function ChannelPermissionsEditor({ channel }: { channel: Channel; onChanged?: () => void }) {
  const roles = useStore((state) => state.bootstrap?.roles);
  const roleNames = new Map(roles?.map((role) => [role.id, role.isEveryone ? '@everyone' : role.name]));
  const [revision, setRevision] = useState(0);
  const source: OverwriteSource = {
    serverId: channel.serverId,
    list: () => api.listChannelOverwrites(channel.id),
    set: async (o) => {
      await api.setChannelOverwrite(channel.id, o);
      setRevision((current) => current + 1);
    },
    remove: async (t, id) => {
      await api.deleteChannelOverwrite(channel.id, t, id);
      setRevision((current) => current + 1);
    },
  };
  const note = (
    <div className="muted" style={{ fontSize: 13 }}>
      {channel.categoryId
        ? 'Канал наследует права своей категории. Заданные здесь права переопределяют категорию — приватность канала важнее доступа категории.'
        : 'Права этого канала. Приватность ограничивает доступ только явно добавленным ролям и участникам.'}
    </div>
  );
  return (
    <OverwriteEditor
      key={channel.id}
      source={source}
      perms={channel.type === 'voice' ? VOICE_PERMS : TEXT_PERMS}
      header={
        <>
          {note}
          <ChannelAccessCheck channelId={channel.id} serverId={channel.serverId} revision={revision} roleNames={roleNames} />
        </>
      }
    />
  );
}
