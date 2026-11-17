import { useEffect, useState } from 'react';
import { GAME_TITLE_NAME_MAX, type GameTitleDto } from '@gusvoice/shared';
import { api } from '../api';
import { isMockEconomy } from '../benchMock';
import { ensureGameTitles } from '../gameBoardClient';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { GameTitleMark } from './GameTitleChip';

/**
 * Карточка «Звания» в панели экономики (ГусКоины 2, этап 6, раздел «Игры»): 27 званий месяца — переименовать под мемы
 * сервера или вернуть «по умолчанию»; и «Итоги» черновиком (сухой прогон на текущих данных, видит только управляющий).
 *
 * Сохраняется по уходу из поля или Enter; пустое поле — то же, что «по умолчанию». Звук звания — этап 7.
 */
function TitleNameRow({ serverId, t, canManage }: { serverId: string; t: GameTitleDto; canManage: boolean }) {
  const setTitles = useStore((s) => s.setGameTitles);
  const [draft, setDraft] = useState(t.renamed ? t.name : '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(t.renamed ? t.name : ''), [t.name, t.renamed]);

  async function save(name: string | null) {
    const next = name?.replace(/\s+/g, ' ').trim() || null;
    if ((next ?? '') === (t.renamed ? t.name : '')) return;
    if (next && next.length > GAME_TITLE_NAME_MAX) {
      toast('error', 'Слишком длинно', `Название звания — не длиннее ${GAME_TITLE_NAME_MAX} символов.`);
      return;
    }
    setBusy(true);
    try {
      setTitles(serverId, await api.renameGameTitle(serverId, t.key, next));
    } catch (e) {
      // Стенд без сервера: правка ложится в макет локально.
      const cur = useStore.getState().gameTitles[serverId];
      if (isMockEconomy() && cur) {
        setTitles(serverId, {
          ...cur,
          titles: cur.titles.map((x) => (x.key === t.key ? { ...x, name: next ?? x.defaultName, renamed: next !== null && next !== x.defaultName } : x)),
        });
      } else {
        const reason = (e as Error & { reason?: string }).reason;
        if (reason === 'bad_name') toast('error', 'Не сохранилось', `Название звания — не длиннее ${GAME_TITLE_NAME_MAX} символов.`);
        else toastError(e);
        setDraft(t.renamed ? t.name : '');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gt-edit-row">
      <GameTitleMark titleKey={t.key} name={t.name} size={32} />
      <span className="gt-edit-body">
        <input
          className="gt-edit-input"
          value={draft}
          placeholder={t.defaultName}
          maxLength={GAME_TITLE_NAME_MAX}
          disabled={!canManage || busy}
          aria-label={`Название звания «${t.defaultName}»`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <small className="eco-slider-hint">{t.about}</small>
      </span>
      {t.renamed && canManage && (
        <button type="button" className="seg-mini" disabled={busy} onClick={() => void save(null)}>
          По умолчанию
        </button>
      )}
    </div>
  );
}

export function GameTitlesCard({ serverId, gamesEnabled }: { serverId: string; gamesEnabled: boolean }) {
  const dto = useStore((s) => s.gameTitles[serverId]);
  const openRecap = useStore((s) => s.openRecap);
  const [open, setOpen] = useState(false);
  useEffect(() => ensureGameTitles(serverId, true), [serverId]);

  return (
    <>
      <h4 className="eco-head">Звания месяца</h4>
      <div className="eco-slider-hint">
        Каждый месяц 1-го числа игры раздают 27 шуточных званий — они видны значком у имени в таблице игр и в «Итогах».
        Переименуй любое под мемы сервера; пустое поле — название по умолчанию.
      </div>
      {dto ? (
        <details className="gt-edit" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary>
            Названия званий
            {dto.titles.some((t) => t.renamed) && <small> · своих: {dto.titles.filter((t) => t.renamed).length}</small>}
          </summary>
          {open && dto.titles.map((t) => <TitleNameRow key={t.key} serverId={serverId} t={t} canManage={dto.canManage} />)}
        </details>
      ) : (
        <div className="eco-slider-hint">Загружаем звания…</div>
      )}
      {/* Черновик «Итогов» на текущих данных: посмотреть, что увидят люди, до закрытия месяца или сезона. Ничего не пишет. */}
      <div className="eco-actions gt-preview">
        <button type="button" className="seg-mini" disabled={!gamesEnabled} onClick={() => openRecap({ serverId, kind: 'games', preview: true })}>
          Итоги месяца игр (черновик)
        </button>
        <button type="button" className="seg-mini" onClick={() => openRecap({ serverId, kind: 'economy', preview: true })}>
          Итоги сезона (черновик)
        </button>
      </div>
    </>
  );
}
