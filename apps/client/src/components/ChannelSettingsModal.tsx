import type { Category, Channel } from '@gusvoice/shared';
import {
  CHANNEL_ICONS,
  DEFAULT_VOICE_BITRATE,
  has,
  listenerKbps,
  Permission,
  permsFromString,
  VOICE_BITRATES,
  voiceBitrateOf,
} from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { pushBackHandler } from '../androidBack';
import { api } from '../api';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { confirmAction } from '../confirm';
import { ChannelPermissionsEditor } from './ChannelPermissionsEditor';
import { ChannelSoundsPanel } from './ChannelSoundsPanel';
import { ChannelGlyph, Icon, isCustomIcon, type IconName } from './Icon';
import { Select } from './Select';
import { RailItem, SettingsHead, SettingsRail, SettingsWindow } from './SettingsShell';

type ChannelTab = 'main' | 'access' | 'general';

export function ChannelSettingsModal({
  channel,
  categories,
  onClose,
  initialTab = 'main',
}: {
  channel: Channel;
  categories: Category[];
  onClose: () => void;
  initialTab?: 'main' | 'access';
}) {
  const serverPerms = permsFromString(useStore((s) => s.bootstrap?.permissions));
  const canManageServer = has(serverPerms, Permission.MANAGE_SERVER);
  const canManageSounds = has(serverPerms, Permission.MANAGE_SOUNDS);
  const canManageChannels = has(serverPerms, Permission.MANAGE_CHANNELS);
  // ⚠️ Вкладка «Доступ» правит ОВЕРРАЙДЫ, а их роуты требуют MANAGE_ROLES, не MANAGE_CHANNELS.
  // Пока вкладка висела на MANAGE_CHANNELS, ломалось в обе стороны: у одного она была и отвечала
  // 403 на загрузку, у другого право было, а вкладки не было.
  const canEditOverwrites = has(serverPerms, Permission.MANAGE_ROLES);
  const meId = useStore((s) => s.user?.id);
  const isGeneral = !!channel.generalUserId && channel.generalUserId === meId;
  // "Генерал"/channel-sounds are voice-only (all channel sounds are voice events) — a text channel
  // has no use for a general or a sound pack, so the tab (and its entry points) hide for text.
  const showGeneralTab = channel.type === 'voice' && (canManageServer || canManageSounds || isGeneral);

  // A channel general without MANAGE_CHANNELS only has the "Генерал" tab — land there directly.
  // Стартовая вкладка — первая ДОСТУПНАЯ, иначе можно приземлиться на скрытую и увидеть пустоту.
  // Разделы рельса (23.09 — вместо вкладок сверху, как у настроек сервера). Подпись под заголовком
  // говорит, что внутри: «Генерал» без неё читается как звание, а не как раздел со звуками.
  const sections: { key: ChannelTab; label: string; sub: string; icon: IconName }[] = [
    ...(canManageChannels
      ? [
          {
            key: 'main' as const,
            label: 'Основное',
            sub:
              channel.type === 'voice'
                ? 'Название, качество звука, категория и иконка'
                : 'Название, тема, категория и иконка',
            icon: 'settings' as const,
          },
        ]
      : []),
    ...(canEditOverwrites
      ? [{ key: 'access' as const, label: 'Доступ', sub: 'Кто видит канал и что в нём можно', icon: 'lock' as const }]
      : []),
    ...(showGeneralTab
      ? [
          canManageServer
            ? { key: 'general' as const, label: 'Генерал', sub: 'Генерал канала и звуки только этого канала', icon: 'crown' as const }
            : { key: 'general' as const, label: 'Звуки', sub: 'Звуки событий только этого канала', icon: 'bell' as const },
        ]
      : []),
  ];
  const [tab, setTab] = useState<ChannelTab>(
    canManageChannels && initialTab === 'main'
      ? 'main'
      : canEditOverwrites && initialTab === 'access'
        ? 'access'
        : canManageChannels
          ? 'main'
          : canEditOverwrites
            ? 'access'
            : 'general',
  );
  // Телефон: список разделов, потом раздел. Раздел один или его попросили явно («Доступ» из меню
  // канала) — список пропускаем, он был бы лишним касанием.
  const [picked, setPicked] = useState(sections.length === 1 || initialTab === 'access');
  const current = sections.find((x) => x.key === tab);
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  const onTabsKey = tabListKeyDown(
    sections.map((x) => x.key),
    tab,
    setTab,
    (k) => `ch-tab-${k}`,
  );
  useEffect(() => {
    if (!picked) return;
    return pushBackHandler(() => {
      setPicked(false);
      return true;
    });
  }, [picked]);
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [categoryId, setCategoryId] = useState(channel.categoryId ?? '');
  const [icon, setIcon] = useState<string | null>(channel.icon ?? null);
  // Качество звука канала (#101). Храним в кбит/с; `voiceBitrateOf` подставляет умолчание, чтобы в
  // списке всегда было что-то выбрано, а не пустой select у каналов, созданных до этой настройки.
  const [voiceBitrate, setVoiceBitrate] = useState<number>(voiceBitrateOf(channel.voiceBitrate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconFileRef = useRef<HTMLInputElement>(null);

  const refresh = () => useStore.getState().openServer(channel.serverId);

  async function uploadIcon(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      toast('error', 'Нужен PNG, JPEG, WEBP или GIF');
      return;
    }
    if (file.size > 512 * 1024) {
      toast('error', 'Файл больше 512 КБ');
      return;
    }
    // Compatibility check + annotation: recommend a square image ≥ 64×64.
    const dim = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = URL.createObjectURL(file);
    });
    if (dim && (dim.w < 64 || dim.h < 64)) {
      toast('warn', `Маловато: ${dim.w}×${dim.h}. Лучше от 64×64`);
    } else if (dim && Math.abs(dim.w - dim.h) / Math.max(dim.w, dim.h) > 0.15) {
      toast('warn', 'Лучше квадратное изображение — иначе обрежется по центру');
    }
    setBusy(true);
    try {
      const updated = await api.uploadChannelIcon(channel.id, file);
      setIcon(updated.icon);
      await refresh();
      toast('success', 'Иконка загружена');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateChannel(channel.id, {
        name: name.trim(),
        topic: channel.type === 'text' ? topic || null : null,
        categoryId: categoryId || null,
        icon,
        ...(channel.type === 'voice' ? { voiceBitrate } : {}),
      });
      await refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirmAction({
      title: `Удалить канал «${channel.name}»?`,
      body: 'Сообщения канала исчезнут вместе с ним. Отменить это нельзя.',
      tone: 'danger',
      confirmLabel: 'Удалить канал',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteChannel(channel.id);
      await refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <SettingsWindow
      variant="channel"
      picked={picked}
      onClose={onClose}
      titleId="ch-title"
      dialogRef={dialogRef}
      rail={
        <SettingsRail
          title={channel.name}
          glyph={<ChannelGlyph c={{ type: channel.type, icon }} size={16} />}
          label="Разделы настроек канала"
          onClose={onClose}
          onListKeyDown={onTabsKey}
        >
          {sections.map((x) => (
            <RailItem
              key={x.key}
              id={`ch-tab-${x.key}`}
              aria-controls="ch-panel-body"
              tabIndex={tab === x.key ? 0 : -1}
              icon={x.icon}
              label={x.label}
              active={tab === x.key}
              onClick={() => {
                setTab(x.key);
                setPicked(true);
              }}
            />
          ))}
        </SettingsRail>
      }
    >
        <SettingsHead
          title={current?.label ?? 'Настройки канала'}
          titleId="ch-title"
          sub={current?.sub}
          onBack={() => setPicked(false)}
          onClose={onClose}
        />

        <div className="admin-scroll" id="ch-panel-body" role="tabpanel" aria-labelledby={`ch-tab-${tab}`}>
        {tab === 'main' ? (
          <form onSubmit={save}>
            <label className="field">
              Название
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            {channel.type === 'text' && (
              <label className="field">
                Тема
                <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="о чём канал" />
              </label>
            )}

            {channel.type === 'voice' && (
              <label className="field">
                Качество звука
                <Select
                  value={String(voiceBitrate)}
                  onChange={(v) => setVoiceBitrate(Number(v))}
                  ariaLabel="Битрейт голоса"
                  title="Битрейт голоса"
                  options={VOICE_BITRATES.map((b) => ({
                    value: String(b),
                    label: `${b} кбит/с`,
                    hint: b === DEFAULT_VOICE_BITRATE ? 'обычное' : undefined,
                  }))}
                />
                {/* Цифра, а не «низкое/высокое»: решение принимается по трафику того, у кого узкий
                    канал, и без числа его принять нельзя. Считаем на СЛУШАТЕЛЯ — платит он, а не тот,
                    кто говорит: SFU шлёт ему каждый голос отдельным потоком. */}
                <span className="muted" style={{ fontSize: 12 }}>
                  Вчетвером собеседник качает ≈{Math.round(listenerKbps(voiceBitrate, 3) / 100) / 10} Мбит/с, вшестером ≈
                  {Math.round(listenerKbps(voiceBitrate, 5) / 100) / 10} Мбит/с. Ставь пониже, если у кого-то мобильный
                  интернет. Применится при следующем заходе в канал.
                </span>
              </label>
            )}

            {categories.length > 0 && (
              <label className="field">
                Категория
                <Select
                  value={categoryId}
                  onChange={setCategoryId}
                  ariaLabel="Категория"
                  title="Категория"
                  options={[
                    { value: '', label: '— без категории —' },
                    ...categories.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </label>
            )}

            <div className="field">
              Иконка
              <div className="icon-pick">
                <button
                  type="button"
                  className={`icon-opt ${icon === null ? 'sel' : ''}`}
                  title="По умолчанию"
                  onClick={() => setIcon(null)}
                >
                  <Icon name={channel.type === 'voice' ? 'volume' : 'hash'} size={20} />
                </button>
                {isCustomIcon(icon) ? (
                  <button type="button" className="icon-opt sel" title="Своя иконка">
                    <img src={icon as string} alt="" width={22} height={22} className="ch-glyph" />
                  </button>
                ) : null}
                {CHANNEL_ICONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`icon-opt ${icon === n ? 'sel' : ''}`}
                    title={n}
                    onClick={() => setIcon(n)}
                  >
                    <Icon name={n as IconName} size={20} />
                  </button>
                ))}
                <button
                  type="button"
                  className="icon-opt upload"
                  title="Загрузить свою"
                  disabled={busy}
                  onClick={() => iconFileRef.current?.click()}
                >
                  <Icon name="plus" size={18} />
                </button>
                <input
                  ref={iconFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadIcon(f);
                    e.target.value = '';
                  }}
                />
              </div>
              <div className="muted icon-hint">Своя иконка: PNG, WEBP или GIF, квадрат от 64×64, до 512 КБ.</div>
            </div>

            {error && <div className="error">{error}</div>}

            <div className="modal-actions">
              <button type="button" className="danger-text" onClick={remove} disabled={busy}>
                Удалить канал
              </button>
              <div style={{ flex: 1 }} />
              <button type="button" className="link" onClick={onClose}>
                Отмена
              </button>
              <button type="submit" disabled={busy || !name.trim()}>
                {busy ? '…' : 'Сохранить'}
              </button>
            </div>
          </form>
        ) : tab === 'general' ? (
          <ChannelGeneralTab
            channel={channel}
            canManageServer={canManageServer}
            canManageSounds={canManageSounds}
            isGeneral={isGeneral}
            onChanged={refresh}
          />
        ) : (
          <ChannelPermissionsEditor channel={channel} onChanged={refresh} />
        )}
        </div>
    </SettingsWindow>
  );
}

/** "Генерал" tab: owner/admin appoints (or clears) the channel general; the general (or a MANAGE_SOUNDS
 *  holder) edits this channel's sound overrides. */
function ChannelGeneralTab({
  channel,
  canManageServer,
  canManageSounds,
  isGeneral,
  onChanged,
}: {
  channel: Channel;
  canManageServer: boolean;
  canManageSounds: boolean;
  isGeneral: boolean;
  onChanged: () => Promise<void>;
}) {
  const members = useStore((s) => s.members);
  const [busy, setBusy] = useState(false);
  const canEditSounds = isGeneral || canManageSounds;

  async function setGeneral(userId: string | null) {
    setBusy(true);
    try {
      await api.setChannelGeneral(channel.id, userId);
      await onChanged();
      toast('success', userId ? 'Генерал назначен' : 'Генерал снят');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-pane">
      {/* Appointing the channel general is an owner/admin action — moderators (MANAGE_SOUNDS) only
          get the sound overrides below, so the appointment section is hidden from them entirely. */}
      {canManageServer && (
        <>
          <div className="muted" style={{ fontSize: 12 }}>
            Генерал канала — один назначенный пользователь. Он получает подпись{' '}
            <span className="vp-general">Генерал</span> у ника и задаёт свои звуки именно для этого канала.
            Назначает владелец / админ сервера.
          </div>
          <div className="cat-name" style={{ marginTop: 12 }}>
            Генерал
          </div>
          <Select
            value={channel.generalUserId ?? ''}
            onChange={(v) => void setGeneral(v || null)}
            disabled={busy}
            ariaLabel="Генерал канала"
            title="Генерал канала"
            searchPlaceholder="Поиск участника"
            options={[
              { value: '', label: '— не назначен —' },
              ...members.map((m) => ({
                value: m.user.id,
                label: m.nickname || m.user.displayName,
                hint: `@${m.user.username}`,
              })),
            ]}
          />
        </>
      )}

      {canEditSounds && (
        <>
          <div className="cat-name" style={{ marginTop: 16 }}>
            Звуки канала
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Переопределяют серверные для событий в этом канале. ≤512 КБ; MP3 / OGG / WAV / WEBM / M4A.
          </div>
          <ChannelSoundsPanel channelId={channel.id} />
        </>
      )}
    </div>
  );
}
