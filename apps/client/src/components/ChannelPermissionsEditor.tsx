import type { Channel } from '@gusvoice/shared';
import { api } from '../api';
import { OverwriteEditor, type OverwriteSource, TEXT_PERMS, VOICE_PERMS } from './OverwriteEditor';

/**
 * Per-channel permission overwrites. A channel ALWAYS inherits its category's permissions; the
 * overwrites set here OVERRIDE the category on conflict — e.g. marking the channel private wins over a
 * category-wide grant, so access is then only for the roles/members explicitly allowed here. A channel
 * with no overwrites of its own purely follows its category.
 */
export function ChannelPermissionsEditor({ channel }: { channel: Channel; onChanged?: () => void }) {
  const source: OverwriteSource = {
    serverId: channel.serverId,
    list: () => api.listChannelOverwrites(channel.id),
    set: (o) => api.setChannelOverwrite(channel.id, o),
    remove: (t, id) => api.deleteChannelOverwrite(channel.id, t, id),
  };
  const note = (
    <div className="muted" style={{ fontSize: 13 }}>
      {channel.categoryId
        ? 'Канал наследует права своей категории. Заданные здесь права переопределяют категорию — приватность канала важнее доступа категории.'
        : 'Права этого канала. Приватность ограничивает доступ только явно добавленным ролям и участникам.'}
    </div>
  );
  return <OverwriteEditor source={source} perms={channel.type === 'voice' ? VOICE_PERMS : TEXT_PERMS} header={note} />;
}
