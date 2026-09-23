import type { GuestPlacesView } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { endGuestSession, fetchGuestPlaces, leaveAllOn } from '../guestJoin';
import { toast, toastError } from '../toast';
import { confirmAction } from '../confirm';
import { Icon } from './Icon';

type Place = GuestPlacesView['places'][number];

/**
 * «Где я гость» (#139, F4, план §5.7) — вкладка настроек профиля.
 *
 * 🔴 Список берётся у СВОЕГО инстанса (индекс членств), а не опросом хостов. Поэтому он полон и
 * тогда, когда половина хостов лежит, и на устройстве, которое этот аккаунт видит впервые. Экран
 * отвечает на вопрос «куда я вообще вхож и как оттуда уйти» — а его задают как раз в тот момент,
 * когда что-то пошло не так.
 *
 * 🔴 Две кнопки — РАЗНЫЕ вещи, и подписи это говорят прямо:
 *  - **выйти со всех серверов** — решение про участие: членства снимаются, сообщения остаются;
 *  - **завершить сессию** — решение про безопасность: гасятся токены на всех устройствах, а
 *    членства не трогаются, и по ссылке можно зайти снова.
 * Свести их в одну «выйти» значило бы, что человек, потерявший телефон, заодно теряет и все свои
 * серверы у соседей.
 */
export function GuestPlacesPanel() {
  const [view, setView] = useState<GuestPlacesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Что мы уже сделали в этом окне. 🔴 Нужно потому, что индекс на доме обновляется СОБЫТИЕМ от
  // хоста, а оно приходит через очередь: перечитай мы список сразу, человек увидел бы те же серверы
  // и решил, что кнопка не сработала.
  const [leftIds, setLeftIds] = useState<string[]>([]);
  const [endedIds, setEndedIds] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    // Спрашиваем ДОМ, а не активный инстанс: стоя гостем у соседа, человек иначе читал бы
    // «вы пока нигде не гость» — сосед про его членства не знает (§5.7).
    fetchGuestPlaces()
      .then((v) => alive && setView(v))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  async function leaveAll(place: Place) {
    const ok = await confirmAction({
      title: `Выйти со всех серверов инстанса «${label(place)}»?`,
      body: 'Сообщения останутся там, где были. Вернуться можно по новому приглашению.',
      // Серверы списком: человек должен видеть, с чего именно уходит, а не считать их в строке.
      items: place.servers.map((s) => s.name || 'Сервер'),
      tone: 'danger',
      confirmLabel: 'Выйти со всех',
    });
    if (!ok) return;
    setBusy(place.instanceId);
    try {
      await leaveAllOn(place, place.servers.map((s) => s.serverId));
      setLeftIds((l) => [...l, place.instanceId]);
      toast('info', 'Вы вышли со всех серверов этого инстанса');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  async function endSession(place: Place) {
    const ok = await confirmAction({
      title: `Завершить сессию на «${label(place)}»?`,
      body: 'Вы выйдете там на всех устройствах. Членства останутся — войти снова можно по ссылке.',
      confirmLabel: 'Завершить сессию',
    });
    if (!ok) return;
    setBusy(place.instanceId);
    try {
      await endGuestSession(place);
      setEndedIds((l) => [...l, place.instanceId]);
      toast('info', 'Сессия на этом инстансе завершена');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="settings-pane">Не удалось спросить свой инстанс: {error}</div>;
  if (!view) return <div className="settings-pane muted">Загружаем…</div>;
  if (view.places.length === 0) {
    return (
      <div className="settings-pane">
        <div className="muted">
          Вы пока не ходили в гости. Это происходит, когда вы входите по ссылке на сервер другого инстанса: аккаунт
          остаётся здесь, а там вы появляетесь гостем.
        </div>
      </div>
    );
  }

  return (
    <div className="settings-pane">
      <div className="muted" style={{ fontSize: 13 }}>
        Здесь вы вошли по ссылке со своим аккаунтом. Переписку и голос этих серверов хранит тот инстанс, а не ваш.
      </div>
      {view.places.map((place) => {
        const left = leftIds.includes(place.instanceId);
        const ended = endedIds.includes(place.instanceId);
        const trouble = linkTrouble(place.linkState);
        return (
          <div key={place.instanceId} className="gp-place">
            <div className="gp-head">
              <Icon name="globe" size={16} />
              <span className="gp-name">{label(place)}</span>
              {/* Домен подписью — ТОЛЬКО когда он не повторяет название. Инстанс без имени и так
                  назван доменом, и второй раз тот же адрес рядом читается как две разные штуки. */}
              {place.domain && label(place) !== place.domain && <span className="gp-domain">{place.domain}</span>}
            </div>
            {trouble && <div className="gp-trouble">{trouble}</div>}
            {/* 🔴 Запрет на весь инстанс (§5.11) человек иначе не узнаёт НИКАК: окно уходит в шлюз
                хоста, а запретить могут, пока он стоит дома — тогда серверы просто исчезают, и
                объяснения нет нигде. Эта строка и есть то место, где он его прочтёт. */}
            {banned(place) && (
              <div className="gp-trouble">
                Вход на этот инстанс вам закрыт его держателем. Серверы оттуда больше не доступны;
                снимут запрет — входить заново по ссылке-приглашению, прежние членства не вернутся.
              </div>
            )}
            {left ? (
              <div className="gp-done">Вы вышли со всех серверов этого инстанса.</div>
            ) : (
              <ul className="gp-servers">
                {place.servers
                  .filter((s) => s.state !== 'removed')
                  .map((s) => (
                  <li key={s.serverId}>
                    <span className="gp-srv-name">{s.name || 'Сервер'}</span>
                    {s.state === 'closed_by_host' && <span className="gp-srv-closed">закрыт держателем</span>}
                  </li>
                ))}
              </ul>
            )}
            {ended && <div className="gp-done">Сессия завершена. Войти снова можно по ссылке-приглашению.</div>}
            {/* Обе кнопки — про то, что там ещё есть: выйти с серверов и погасить сессию. После
                запрета нет ни того, ни другого, и кнопка, которая ничего не делает, только сбивает. */}
            {!banned(place) && (
            <div className="gp-actions">
              <button
                type="button"
                className="link danger"
                disabled={busy === place.instanceId || left || place.servers.length === 0}
                onClick={() => void leaveAll(place)}
              >
                Выйти со всех серверов
              </button>
              <button
                type="button"
                className="link"
                disabled={busy === place.instanceId || ended}
                onClick={() => void endSession(place)}
              >
                Завершить сессию на этом инстансе
              </button>
            </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Закрыт ли человеку вход на весь этот инстанс (§5.11).
 *
 * ⚠️ Признак — надгробие в индексе членств: хост, запрещая вход, снимает все членства с причиной
 * `banned_by_instance`, и дом эти строки НЕ удаляет (`guestMembership.ts`). Живых серверов рядом с
 * ними не бывает: запрет снимает все разом.
 */
function banned(p: Place): boolean {
  return p.servers.some((s) => s.state === 'removed' && s.reason === 'banned_by_instance');
}

function label(p: Place): string {
  return p.name?.trim() || p.domain || 'другой инстанс';
}

/**
 * Что сказать, когда связка не работает.
 *
 * ⚠️ Членство переживает разрыв (§5.6.2, заморозка), поэтому сервер остаётся в списке — и без этой
 * строки человек видел бы сервер, в который не пускает, без единого слова почему.
 */
function linkTrouble(state: string): string | null {
  switch (state) {
    case 'active':
      return null;
    case 'paused':
      return 'Федерация с этим инстансом приостановлена — зайти сейчас нельзя.';
    case 'trust-lost':
      return 'Связь с этим инстансом разорвана. Ваши серверы там сохранены, но войти нельзя, пока админы не свяжут инстансы заново.';
    case 'unknown':
      return 'Связки с этим инстансом у вашего больше нет. Записи о серверах остались.';
    default:
      return 'Связка с этим инстансом сейчас не работает — зайти нельзя.';
  }
}
