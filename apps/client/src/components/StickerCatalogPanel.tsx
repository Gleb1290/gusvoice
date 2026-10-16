import { parseStickerSetName, type StickerCatalog, type StickerCatalogPack } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { stickerCountLabel } from '../dmStickerRules';
import { useDmStickers } from '../dmStickers';
import { toastError } from '../toast';
import { Icon } from './Icon';
import { StickerView } from './StickerView';

/**
 * «Наборы стикеров» внутри панели стикеров ЛС (С2, #211, признак `stickers2`) — как «Популярные» и «Мои наборы» у
 * Telegram: свои наборы (порядок ↑/↓, убрать), каталог всего, что загружено на инстанс (поиск, «Добавить» одним
 * нажатием, название открывает окно набора), и загрузка набора из Telegram по ссылке (не больше 40 на человека).
 * Разметка — классы вкладки «Стикеры» настроек сервера (`.pack-row`, `.pack-preview`, `.row-field`).
 */
export function StickerCatalogPanel() {
  const mine = useDmStickers((s) => s.mine);
  const { add, remove, move, putFirst, openSet } = useDmStickers.getState();
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<StickerCatalog | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(
      () =>
        void api
          .stickersCatalog(query.trim())
          .then((c) => live && setCatalog(c))
          .catch(toastError),
      query ? 250 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const mineIds = new Set((mine ?? []).map((p) => p.id));
  const parsed = parseStickerSetName(link);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    if (!parsed.ok) return;
    setBusy('upload');
    setProblem(null);
    try {
      const pack = await api.stickerImport(link);
      putFirst(pack);
      setLink('');
      setCatalog(await api.stickersCatalog(query.trim()));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const row = (p: StickerCatalogPack, actions: React.ReactNode) => (
    <div className="pack-row" key={p.id}>
      <button
        type="button"
        className="pack-preview"
        title="Открыть набор"
        // B7 (приёмка 13.10): панель живёт только в поле беседы — окно набора отсюда шлёт стикер тапом в эту беседу и закрывается
        // (Telegram Android `StickersAlert` с делегатом `onStickerSelected`); без открытой беседы (`sender` пуст) — только смотреть.
        onClick={() => openSet({ packId: p.id, send: useDmStickers.getState().sender ?? undefined })}
      >
        {p.stickers.slice(0, 5).map((s) => (
          <StickerView key={s.id} url={s.url} format={s.format} emoji={s.emoji} size={32} animate={false} />
        ))}
      </button>
      <span className="pack-title" title={p.name}>
        {p.title}
        <span className="muted">{stickerCountLabel(p.count)}</span>
      </span>
      {actions}
    </div>
  );

  return (
    <div className="sticker-catalog">
      <div className="emoji-search">
        <input
          value={query}
          placeholder="Поиск наборов"
          aria-label="Поиск наборов стикеров"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="sticker-catalog-body">
        {!query && !!mine?.length && (
          <>
            <div className="sticker-catalog-head muted">Мои наборы</div>
            <div className="pack-list">
              {mine.map((p, i) =>
                row(
                  p,
                  <span className="sticker-catalog-actions">
                    <button
                      type="button"
                      className="sound-icon-btn"
                      title="Выше"
                      disabled={i === 0 || !!busy}
                      onClick={() => void run(p.id, () => move(p.id, -1))}
                    >
                      <Icon name="chevron-up" size={15} />
                    </button>
                    <button
                      type="button"
                      className="sound-icon-btn"
                      title="Ниже"
                      disabled={i === mine.length - 1 || !!busy}
                      onClick={() => void run(p.id, () => move(p.id, 1))}
                    >
                      <Icon name="chevron-down" size={15} />
                    </button>
                    <button
                      type="button"
                      className="sound-icon-btn danger"
                      title="Убрать из моих"
                      disabled={!!busy}
                      onClick={() => void run(p.id, () => remove(p.id))}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </span>,
                ),
              )}
            </div>
          </>
        )}
        <div className="sticker-catalog-head muted">{query ? 'Результаты поиска' : 'Все наборы инстанса'}</div>
        {catalog === null ? (
          <div className="emoji-empty muted">Загрузка…</div>
        ) : catalog.packs.length === 0 ? (
          <div className="emoji-empty muted">{query ? 'Наборы не найдены' : 'На инстансе пока нет наборов'}</div>
        ) : (
          <div className="pack-list">
            {catalog.packs.map((p) =>
              row(
                p,
                mineIds.has(p.id) ? (
                  <span className="sticker-catalog-added muted">Добавлен</span>
                ) : (
                  <button
                    type="button"
                    className="sticker-catalog-add"
                    disabled={!!busy}
                    onClick={() => void run(p.id, () => add(p.id))}
                  >
                    Добавить
                  </button>
                ),
              ),
            )}
          </div>
        )}
        {catalog?.importEnabled && !query && (
          <>
            <div className="sticker-catalog-head muted">
              Загрузить из Telegram · ваших {catalog.uploaded} из {catalog.uploadLimit}
            </div>
            <div className="row-field">
              <input
                value={link}
                placeholder="https://t.me/addstickers/…"
                aria-label="Ссылка на набор в Telegram"
                disabled={busy === 'upload'}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void upload();
                }}
              />
              <button type="button" disabled={!!busy || !parsed.ok} onClick={() => void upload()}>
                {busy === 'upload' ? 'Загрузка…' : 'Загрузить'}
              </button>
            </div>
            {problem && <div className="error">{problem}</div>}
          </>
        )}
      </div>
    </div>
  );
}
