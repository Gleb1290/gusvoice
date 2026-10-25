import type { Channel, Webhook } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { Select } from './Select';

const EMPTY_CHANNELS: Channel[] = [];

/**
 * Настройки канала → Вебхуки (#24, как «Интеграции → Вебхуки» у Discord): список вебхуков канала, создание, имя, канал,
 * аватар, новый адрес, удаление. Право — `MANAGE_WEBHOOKS` (дверь считает `ChannelSettingsModal`).
 *
 * 🔴 Отличие от Discord: полный адрес показывается ОДИН раз — после создания и «Новый адрес». Токен хранится хешем,
 * поэтому достать его заново нельзя; потерял — генерируй новый (старый адрес при этом умирает).
 */
export function ChannelWebhooksPanel({ channel }: { channel: Channel }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Свежий адрес: только что создан или сгенерирован заново — показывается, пока окно открыто. */
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listWebhooks(channel.id)
      .then((list) => !cancelled && setHooks(list))
      .catch((e) => {
        if (!cancelled) setHooks([]);
        toastError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const w = await api.createWebhook(channel.id, 'Вебхук');
      const { token, ...rest } = w;
      setHooks((hs) => [...(hs ?? []), rest]);
      setFresh({ id: w.id, url: api.webhookUrl(w.id, token) });
      setOpenId(w.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const replace = (w: Webhook) => setHooks((hs) => (hs ?? []).map((x) => (x.id === w.id ? w : x)));

  return (
    <div className="settings-pane webhooks-panel">
      <WebhooksHelp />


      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" onClick={() => void create()} disabled={busy || channel.type !== 'text'}>
          {busy ? '…' : 'Новый вебхук'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {hooks === null ? (
        <div className="muted" style={{ padding: 12 }}>
          Загрузка…
        </div>
      ) : hooks.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          Вебхуков пока нет.
        </div>
      ) : (
        <ul className="bans-list webhook-list">
          {hooks.map((w) => (
            <li key={w.id} className="webhook-item">
              <button
                type="button"
                className="ban-row webhook-row"
                aria-expanded={openId === w.id}
                onClick={() => setOpenId((o) => (o === w.id ? null : w.id))}
              >
                <Avatar url={w.avatarUrl} name={w.name} size={32} />
                <span className="ban-meta">
                  <span className="ban-name">{w.name}</span>
                  <span className="ban-sub">
                    {w.createdBy ? `создал ${w.createdBy.displayName}` : 'создатель удалён'} ·{' '}
                    {w.lastUsedAt ? `писал ${fmtDate(w.lastUsedAt)}` : 'ещё не писал'}
                  </span>
                </span>
              </button>
              {openId === w.id && (
                <WebhookEditor
                  hook={w}
                  freshUrl={fresh?.id === w.id ? fresh.url : null}
                  onChanged={(nw, url) => {
                    if (nw.channelId !== channel.id) {
                      setHooks((hs) => (hs ?? []).filter((x) => x.id !== nw.id));
                      setOpenId(null);
                    } else replace(nw);
                    if (url) setFresh({ id: nw.id, url });
                  }}
                  onDeleted={() => {
                    setHooks((hs) => (hs ?? []).filter((x) => x.id !== w.id));
                    setOpenId(null);
                    if (fresh?.id === w.id) setFresh(null);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Что такое вебхук и что он умеет — одна подсказка для раздела канала и «Интеграций» сервера. */
function WebhooksHelp() {
  return (
    <div className="muted" style={{ fontSize: 12 }}>
      Вебхук — адрес, по которому внешняя программа (сборка, мониторинг, бот) пишет в канал без входа. Тело — как у
      Discord: <code>content</code>, <code>username</code>, <code>avatar_url</code>, <code>embeds</code> (карточки), файлы —
      <code>multipart/form-data</code> с <code>payload_json</code> и <code>files[n]</code>. Сообщения помечаются «ВЕБХУК».
      Упоминания — как у Discord: без <code>allowed_mentions</code> вебхук зовёт <code>@everyone</code>, роли и людей, поле
      сужает.
    </div>
  );
}

/**
 * Настройки сервера → Интеграции (#24, как «Интеграции → Вебхуки» у Discord): все вебхуки сервера в каналах, где у меня
 * `MANAGE_WEBHOOKS` (сервер отбирает сам, `/servers/:id/webhooks`), создание с выбором канала, тот же редактор, что в
 * настройках канала. Адрес — по-прежнему ОДИН раз (решение владельца 19.10).
 */
export function ServerWebhooksPanel({ serverId }: { serverId: string }) {
  const channels = useStore((s) => s.bootstrap?.channels ?? EMPTY_CHANNELS);
  const textChannels = channels.filter((c) => c.type === 'text' && c.serverId === serverId);
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? '?';
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ id: string; url: string } | null>(null);
  const [target, setTarget] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetId = target || textChannels[0]?.id || '';

  useEffect(() => {
    let cancelled = false;
    api
      .listServerWebhooks(serverId)
      .then((list) => !cancelled && setHooks(list))
      .catch((e) => {
        if (!cancelled) setHooks([]);
        toastError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  async function create() {
    if (!targetId) return;
    setBusy(true);
    setError(null);
    try {
      const w = await api.createWebhook(targetId, 'Вебхук');
      const { token, ...rest } = w;
      setHooks((hs) => [...(hs ?? []), rest]);
      setFresh({ id: w.id, url: api.webhookUrl(w.id, token) });
      setOpenId(w.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-pane webhooks-panel">
      <WebhooksHelp />

      <div className="modal-actions webhook-create" style={{ justifyContent: 'flex-start' }}>
        <Select
          value={targetId}
          onChange={setTarget}
          ariaLabel="Канал нового вебхука"
          title="Канал нового вебхука"
          options={textChannels.map((c) => ({ value: c.id, label: `# ${c.name}` }))}
        />
        <button type="button" onClick={() => void create()} disabled={busy || !targetId}>
          {busy ? '…' : 'Новый вебхук'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {hooks === null ? (
        <div className="muted" style={{ padding: 12 }}>
          Загрузка…
        </div>
      ) : hooks.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          Вебхуков на сервере пока нет.
        </div>
      ) : (
        <ul className="bans-list webhook-list">
          {hooks.map((w) => (
            <li key={w.id} className="webhook-item">
              <button
                type="button"
                className="ban-row webhook-row"
                aria-expanded={openId === w.id}
                onClick={() => setOpenId((o) => (o === w.id ? null : w.id))}
              >
                <Avatar url={w.avatarUrl} name={w.name} size={32} />
                <span className="ban-meta">
                  <span className="ban-name">
                    {w.name} <span className="muted"># {channelName(w.channelId)}</span>
                  </span>
                  <span className="ban-sub">
                    {w.createdBy ? `создал ${w.createdBy.displayName}` : 'создатель удалён'} {fmtDate(w.createdAt)} ·{' '}
                    {w.lastUsedAt ? `писал ${fmtDate(w.lastUsedAt)}` : 'ещё не писал'}
                  </span>
                </span>
              </button>
              {openId === w.id && (
                <WebhookEditor
                  hook={w}
                  freshUrl={fresh?.id === w.id ? fresh.url : null}
                  onChanged={(nw, url) => {
                    setHooks((hs) => (hs ?? []).map((x) => (x.id === nw.id ? nw : x)));
                    if (url) setFresh({ id: nw.id, url });
                  }}
                  onDeleted={() => {
                    setHooks((hs) => (hs ?? []).filter((x) => x.id !== w.id));
                    setOpenId(null);
                    if (fresh?.id === w.id) setFresh(null);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function WebhookEditor({
  hook,
  freshUrl,
  onChanged,
  onDeleted,
}: {
  hook: Webhook;
  freshUrl: string | null;
  onChanged: (w: Webhook, url?: string) => void;
  onDeleted: () => void;
}) {
  const channels = useStore((s) => s.bootstrap?.channels ?? EMPTY_CHANNELS);
  const textChannels = channels.filter((c) => c.type === 'text');
  const [name, setName] = useState(hook.name);
  const [channelId, setChannelId] = useState(hook.channelId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const dirty = name.trim() !== hook.name || channelId !== hook.channelId;
  const save = () =>
    run(async () => {
      const body: { name?: string; channelId?: string } = {};
      if (name.trim() !== hook.name) body.name = name.trim();
      if (channelId !== hook.channelId) body.channelId = channelId;
      onChanged(await api.updateWebhook(hook.id, body));
      toast('success', 'Вебхук сохранён');
    });

  const regenerate = async () => {
    const ok = await confirmAction({
      title: `Новый адрес для «${hook.name}»?`,
      body: 'Старый адрес перестанет работать сразу — программы, которые по нему пишут, придётся перенастроить.',
      tone: 'danger',
      confirmLabel: 'Сгенерировать заново',
    });
    if (!ok) return;
    await run(async () => {
      const w = await api.regenerateWebhookToken(hook.id);
      const { token, ...rest } = w;
      onChanged(rest, api.webhookUrl(w.id, token));
    });
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: `Удалить вебхук «${hook.name}»?`,
      body: 'Адрес перестанет работать. Сообщения, которые вебхук уже написал, останутся в канале.',
      tone: 'danger',
      confirmLabel: 'Удалить вебхук',
    });
    if (!ok) return;
    await run(async () => {
      await api.deleteWebhook(hook.id);
      onDeleted();
    });
  };

  const upload = (file: File) =>
    run(async () => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Нужен PNG, JPEG, WEBP или GIF');
      if (file.size > 512 * 1024) throw new Error('Файл больше 512 КБ');
      onChanged(await api.uploadWebhookAvatar(hook.id, file));
    });

  const copy = (url: string) =>
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast('success', 'Адрес скопирован'))
      .catch(() => setError('Не удалось скопировать — выделите адрес и скопируйте вручную'));

  return (
    <div className="webhook-editor">
      <div className="webhook-ava">
        <Avatar url={hook.avatarUrl} name={hook.name} size={64} />
        <div className="webhook-ava-actions">
          <button type="button" className="link" disabled={busy} onClick={() => fileRef.current?.click()}>
            Загрузить аватар
          </button>
          {hook.avatarUrl && (
            <button
              type="button"
              className="danger-text"
              disabled={busy}
              onClick={() => void run(async () => onChanged(await api.updateWebhook(hook.id, { avatarUrl: null })))}
            >
              Убрать
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
      </div>

      <label className="field">
        Имя
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Канал
        <Select
          value={channelId}
          onChange={setChannelId}
          ariaLabel="Канал вебхука"
          title="Канал вебхука"
          options={textChannels.map((c) => ({ value: c.id, label: `# ${c.name}` }))}
        />
      </label>

      <div className="field">
        Адрес
        {freshUrl ? (
          <>
            <div className="webhook-url">
              <input readOnly value={freshUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Адрес вебхука" />
              <button type="button" onClick={() => copy(freshUrl)}>
                Скопировать
              </button>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              Скопируйте сейчас: адрес показывается один раз — на сервере хранится только его отпечаток. Потеряли —
              «Новый адрес».
            </span>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            Адрес показывается только сразу после создания. Нужен снова — «Новый адрес» (старый перестанет работать).
          </span>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="modal-actions">
        <button type="button" className="danger-text" onClick={() => void remove()} disabled={busy}>
          Удалить вебхук
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="link" onClick={() => void regenerate()} disabled={busy}>
          Новый адрес
        </button>
        <button type="button" onClick={() => void save()} disabled={busy || !dirty || !name.trim()}>
          {busy ? '…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
