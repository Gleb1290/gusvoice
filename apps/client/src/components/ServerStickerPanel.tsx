import { parseStickerSetName, STICKER_PACKS_PER_SERVER, type StickerPack } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { useStickerPacks, useStickersEnabled } from '../serverStickers';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';
import { StickerView } from './StickerView';

/**
 * Импорт наборов стикеров из Telegram (#68, право `MANAGE_STICKERS`).
 *
 * Файлы копируются к нам в хранилище, а не подтягиваются ссылками с серверов Telegram: ссылки Bot
 * API живут недолго и протухли бы прямо в истории чата, а каждая такая картинка — ещё и обращение
 * читателя к Telegram, то есть утечка того, кто и когда открыл наш чат.
 */
export function ServerStickerPanel({ serverId }: { serverId: string }) {
  const packs = useStickerPacks();
  const enabled = useStickersEnabled();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const parsed = parseStickerSetName(input);
  const problem = input.trim() && !parsed.ok ? parsed.error : null;
  const full = packs.length >= STICKER_PACKS_PER_SERVER;

  async function add() {
    if (!parsed.ok) return;
    setBusy(true);
    try {
      const res = await api.importStickerPack(serverId, parsed.name);
      await useStore.getState().refreshBootstrap(serverId);
      setInput('');
      // Пропущенные не прячем: молча импортировать 90 из 100 и отрапортовать успех — это враньё.
      toast(
        'success',
        res.skipped
          ? `«${res.title}»: ${res.count} шт., пропущено ${res.skipped}`
          : `«${res.title}»: ${res.count} стикеров`,
      );
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: StickerPack) {
    if (!confirm(`Удалить набор «${p.title}»?\n\nУже отправленные стикеры в истории останутся.`)) return;
    setRemoving(p.id);
    try {
      await api.deleteStickerPack(serverId, p.id);
      await useStore.getState().refreshBootstrap(serverId);
    } catch (e) {
      toastError(e);
    } finally {
      setRemoving(null);
    }
  }

  if (!enabled) {
    return (
      <div className="settings-pane">
        <div className="muted" style={{ fontSize: 13 }}>
          Импорт стикеров не настроен на этом сервере. Нужен токен бота Telegram: получите его у{' '}
          <code>@BotFather</code> и пропишите в <code>.env</code> как <code>TELEGRAM_BOT_TOKEN</code>, затем
          перезапустите бэкенд. Бот подойдёт любой — набор он читает публичным методом, состоять где-либо
          ему не нужно.
        </div>
      </div>
    );
  }

  return (
    <div className="settings-pane">
      <div className="muted" style={{ fontSize: 12 }}>
        Наборы стикеров из Telegram: вставьте ссылку вида <code>t.me/addstickers/…</code> или имя набора.
        Картинки копируются на этот сервер, поэтому работают и после того, как ссылка Telegram протухнет.
        До {STICKER_PACKS_PER_SERVER} наборов. Анимированные (<code>.tgs</code>) и видео (<code>.webm</code>)
        поддерживаются.
      </div>

      <div className="emoji-manage-count">
        {packs.length} из {STICKER_PACKS_PER_SERVER}
      </div>

      {packs.length > 0 ? (
        <div className="pack-list">
          {packs.map((p) => (
            <div className="pack-row" key={p.id}>
              <div className="pack-preview">
                {p.stickers.slice(0, 5).map((s) => (
                  <StickerView key={s.id} url={s.url} format={s.format} emoji={s.emoji} size={32} animate={false} />
                ))}
              </div>
              <span className="pack-title" title={p.name}>
                {p.title}
                <span className="muted"> · {p.stickers.length} шт.</span>
              </span>
              <button
                type="button"
                className="sound-icon-btn danger"
                title="Удалить набор"
                disabled={removing === p.id}
                onClick={() => void remove(p)}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted emoji-manage-empty">Пока ни одного набора.</div>
      )}

      <div className="row-field" style={{ marginTop: 12 }}>
        <input
          value={input}
          placeholder="https://t.me/addstickers/HotCherry"
          disabled={busy || full}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <button type="button" disabled={busy || full || !parsed.ok} onClick={() => void add()}>
          {busy ? 'Импорт…' : 'Импортировать'}
        </button>
      </div>
      {busy && (
        <div className="muted" style={{ fontSize: 12 }}>
          Скачиваем набор — до сотни файлов, это может занять минуту.
        </div>
      )}

      {full && <div className="muted">Достигнут предел — удалите лишние наборы.</div>}
      {problem && <div className="error">{problem}</div>}
    </div>
  );
}
