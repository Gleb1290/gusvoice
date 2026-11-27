import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Permission, type Channel, type ServerBootstrap } from '@gusvoice/shared';
import type { ChatView as ChatViewType } from './ChatView';
import type { useStore as StoreType } from '../store';
import { setupHarness } from './MessagePane.behavior.harness';

const h = setupHarness(import.meta.url, { tinyEmojiFixture: true });
let ChatView: typeof ChatViewType;
let useStore: typeof StoreType;

const channel: Channel = {
  id: 'c',
  serverId: 'server',
  categoryId: null,
  name: 'объявления',
  type: 'text',
  position: 0,
  topic: null,
  syncedToCategory: false,
  icon: null,
  isPrivate: false,
  generalUserId: null,
  sounds: {},
  voiceBitrate: null,
};

const read = Permission.VIEW_CHANNEL | Permission.READ_HISTORY;
const write = read | Permission.SEND_MESSAGES;
const date = '2026-11-24T00:00:00.000Z';

function bootstrap(activeChannel: Channel, permissions: bigint): ServerBootstrap {
  return {
    server: { id: channel.serverId, name: 'Сервер', iconUrl: null, ownerId: 'owner', createdAt: date },
    member: { userId: 'me', serverId: channel.serverId, nickname: null, roleIds: [], joinedAt: date },
    channels: [activeChannel],
    permissions: permissions.toString(),
    categories: [],
    roles: [],
    sounds: {},
    emojis: [],
    stickerPacks: [],
    stickersEnabled: false,
    reads: {},
  };
}

async function render(activeChannel: Channel) {
  await act(async () => {
    h.root!.render(createElement(ChatView, { channel: activeChannel }));
  });
}

async function setupChannelStore(activeChannel: Channel, permissions: bigint) {
  ({ ChatView } = await h.server.ssrLoadModule('/src/components/ChatView.tsx'));
  ({ useStore } = await h.server.ssrLoadModule('/src/store.ts'));
  const initialState = useStore.getState();
  h.resetStore = () => useStore.setState(initialState, true);
  useStore.setState({
    currentServerId: activeChannel.serverId,
    bootstrap: bootstrap(activeChannel, permissions),
    messagesByChannel: { [channel.id]: [{ ...h.msg('history', 'peer'), content: 'Сообщение в истории' }] },
  });
  h.host = document.createElement('div');
  document.body.append(h.host);
  h.root = createRoot(h.host);
}

async function mount(activeChannel: Channel, permissions: bigint) {
  await setupChannelStore(activeChannel, permissions);
  await render(activeChannel);
}

function assertComposer(expected: 'поле' | 'плашка') {
  assert.match(h.host.textContent ?? '', /Сообщение в истории/, 'история канала остаётся доступна');
  const field = h.host.querySelector<HTMLTextAreaElement>('textarea');
  if (expected === 'поле') {
    assert.ok(field && !field.disabled && !field.readOnly, 'доступно поле ввода сообщения');
    assert.doesNotMatch(h.host.textContent ?? '', /Только для чтения/);
  } else {
    assert.match(h.host.textContent ?? '', /Только для чтения/, 'показана плашка ограничения');
    assert.equal(field, null, 'поле ввода убрано из ленты');
  }
}

it('запрет канала заменяет поле плашкой при серверном праве отправки', async () => {
  await mount({ ...channel, canSend: false }, write);
  assertComposer('плашка');
});

it('разрешение канала открывает поле при отсутствии серверного права отправки', async () => {
  await mount({ ...channel, canSend: true }, read);
  assertComposer('поле');
});

it('без canSend серверное право отправки открывает поле', async () => {
  await mount(channel, write);
  assertComposer('поле');
});

it('без canSend отсутствие серверного права отправки показывает плашку', async () => {
  await mount(channel, read);
  assertComposer('плашка');
});

it('смена права канала закрывает и снова открывает композер в той же ленте', async () => {
  const allowed = { ...channel, canSend: true };
  const denied = { ...channel, canSend: false };
  await mount(allowed, write);
  assertComposer('поле');

  await render(denied);
  assertComposer('плашка');

  await render(allowed);
  assertComposer('поле');
});

it('без canSend композер реагирует на изменение серверного права в открытом канале', async () => {
  await mount(channel, write);
  assertComposer('поле');

  await act(async () => {
    useStore.setState({ bootstrap: bootstrap(channel, read) });
  });
  assertComposer('плашка');

  await act(async () => {
    useStore.setState({ bootstrap: bootstrap(channel, write) });
  });
  assertComposer('поле');
});

function StoredChannelView({ id }: { id: string }) {
  const storedChannel = useStore((state) => state.bootstrap?.channels.find((item) => item.id === id));
  return storedChannel ? createElement(ChatView, { key: id, channel: storedChannel }) : null;
}

async function showStoredChannel(id: string) {
  await act(async () => {
    h.root!.render(createElement(StoredChannelView, { id }));
  });
}

it('переименование общим событием сохраняет персональный запрет отправки', async () => {
  await setupChannelStore({ ...channel, canSend: false }, write);
  await showStoredChannel(channel.id);

  const renamed = { ...channel, name: 'новое название' };
  await act(async () => {
    useStore.getState().upsertChannel(renamed);
  });

  const updated = useStore.getState().bootstrap?.channels.find((item) => item.id === channel.id);
  assert.equal(updated?.name, renamed.name);
  assert.equal(updated?.canSend, false, 'событие без canSend сохраняет персональный запрет');
  assert.match(h.host.textContent ?? '', /новое название/);
  assertComposer('плашка');
});

it('новый текстовый канал ждёт персональные права перед показом поля', async () => {
  const existing = { ...channel, id: 'existing', canSend: true };
  await setupChannelStore(existing, write);
  await showStoredChannel(channel.id);

  const refreshes: string[] = [];
  let finishRefresh!: (result: ServerBootstrap) => void;
  const response = new Promise<ServerBootstrap>((resolve) => {
    finishRefresh = resolve;
  });
  useStore.setState({
    refreshBootstrap: async (serverId) => {
      refreshes.push(serverId);
      useStore.setState({ bootstrap: await response });
    },
  });

  await act(async () => {
    useStore.getState().upsertChannel(channel);
  });

  assert.deepEqual(refreshes, [channel.serverId], 'новый канал запрашивает персональные права');
  assert.equal(h.host.querySelector('textarea'), null, 'до ответа сервера поле недоступно');

  await act(async () => {
    const refreshed = bootstrap({ ...channel, canSend: true }, write);
    finishRefresh({ ...refreshed, channels: [existing, ...refreshed.channels] });
  });
  assertComposer('поле');
});

