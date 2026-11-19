import type { GuestPlacesView } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { dismissGuestGroup, endGuestSession, fetchGuestPlaces, GuestJoinError, hostSilent, leaveAllOn, prepareGuestAccess } from '../guestJoin';
import type { PreparedGuestAccess } from '../guestPreparationRules';
import { WebBackupStatus } from './WebBackupStatus';
import { refusalOrMessage, refusalText } from '../inviteCheckRules';
import { toast, toastError } from '../toast';
import { confirmAction } from '../confirm';
import { Icon } from './Icon';
import { JoinServerModal } from './ServerActionModals';

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
  const [backupInviteOpen, setBackupInviteOpen] = useState(false);
  const [viewRevision, setViewRevision] = useState(0);
  const [prepared, setPrepared] = useState<PreparedGuestAccess | null>(null);
  const [preparationError, setPreparationError] = useState<{ instanceId: string; message: string } | null>(null);
  // Что мы уже сделали в этом окне. 🔴 Нужно потому, что индекс на доме обновляется СОБЫТИЕМ от
  // хоста, а оно приходит через очередь: перечитай мы список сразу, человек увидел бы те же серверы
  // и решил, что кнопка не сработала.
  const [leftIds, setLeftIds] = useState<string[]>([]);
  const [endedIds, setEndedIds] = useState<string[]>([]);
  /** Убрано с этого устройства без ответа хоста (15.10). */
  const [droppedIds, setDroppedIds] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    // Спрашиваем ДОМ, а не активный инстанс: стоя гостем у соседа, человек иначе читал бы
    // «вы пока нигде не гость» — сосед про его членства не знает (§5.7).
    fetchGuestPlaces()
      .then((v) => {
        if (!alive) return;
        setView(v);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [viewRevision]);

  /**
   * Хост НЕ ОТВЕТИЛ на «выйти»/«завершить» (15.10): мёртвый сосед держал выход — кнопка падала ошибкой, и всё. Теперь
   * предлагаем убрать его с устройства без хоста — тот же путь, что «Убрать из списка» в рейле (`dismissGuestGroup`).
   * Отказ словами (хост ответил) — обычная ошибка, как раньше.
   */
  async function offerDrop(place: Place, e: unknown): Promise<void> {
    if (!hostSilent(e)) {
      toastError(e);
      return;
    }
    const ok = await confirmAction({
      title: `«${label(place)}» не отвечает`,
      body:
        'Убрать его серверы из списка на этом устройстве? Сессия там закончится сама по сроку, членства останутся — ' +
        'вернуться можно по ссылке-приглашению.',
      tone: 'danger',
      confirmLabel: 'Убрать из списка',
    });
    if (!ok) return;
    await dismissGuestGroup({ instanceId: null, place });
    setDroppedIds((l) => [...l, place.instanceId]);
    forgetPreparation(place.instanceId);
    toast('info', 'Убрано с этого устройства');
  }

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
      forgetPreparation(place.instanceId);
      toast('info', 'Вы вышли со всех серверов этого инстанса');
    } catch (e) {
      await offerDrop(place, e);
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
      forgetPreparation(place.instanceId);
      toast('info', 'Сессия на этом инстансе завершена');
    } catch (e) {
      await offerDrop(place, e);
    } finally {
      setBusy(null);
    }
  }

  function forgetPreparation(instanceId: string) {
    setPrepared((last) => last?.instanceId === instanceId ? null : last);
    setPreparationError((last) => last?.instanceId === instanceId ? null : last);
  }

  function recordPreparation(access: PreparedGuestAccess) {
    setEndedIds((ids) => ids.filter((id) => id !== access.instanceId));
    setDroppedIds((ids) => ids.filter((id) => id !== access.instanceId));
    setPreparationError(null);
    setPrepared(access);
  }

  async function prepare(place: Place, server: Place['servers'][number]) {
    const ok = await confirmAction({
      title: `Подготовить доступ к «${server.name || 'Сервер'}»?`,
      body: 'Приложение сохранит гостевую сессию на этом устройстве и проверит доступ у хоста. Сделайте это, пока домашний инстанс доступен.',
      confirmLabel: 'Подготовить доступ',
    });
    if (!ok) return;
    setBusy(place.instanceId);
    forgetPreparation(place.instanceId);
    try {
      recordPreparation(await prepareGuestAccess(place, server.serverId));
    } catch (e) {
      setPreparationError({
        instanceId: place.instanceId,
        message: hostSilent(e)
          ? 'Не удалось связаться с инстансом. Доступ на этом устройстве пока не подтверждён.'
          : e instanceof GuestJoinError ? refusalText(e.code, label(place)) : refusalOrMessage(e, label(place)),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-pane">
      <div className="gp-actions">
        <button type="button" disabled={!!busy} onClick={() => setBackupInviteOpen(true)}>
          Подключить запасной сервер
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Подготовьте гостевой доступ, пока ваш инстанс отвечает. Если он станет недоступен, на запасной сервер можно
        будет зайти с этого устройства, пока хост принимает гостевую сессию.
      </div>
      {backupInviteOpen && createPortal(
        <JoinServerModal
          onClose={() => {
            setBackupInviteOpen(false);
            // Вступление могло пройти, даже если следующая проверка хоста оборвалась.
            setViewRevision((revision) => revision + 1);
          }}
          onPrepared={recordPreparation}
        />,
        document.body,
      )}
      {prepared && <PreparedAccessNotice access={prepared} />}
      {error && <div className="error">Не удалось спросить свой инстанс: {error}</div>}
      {!error && !view && <div className="muted">Загружаем…</div>}
      {!prepared && view?.places.length === 0 && <div className="muted">Вы пока не ходили в гости.</div>}
      {view?.places.map((place) => {
        const left = leftIds.includes(place.instanceId);
        const ended = endedIds.includes(place.instanceId);
        const dropped = droppedIds.includes(place.instanceId);
        const trouble = linkTrouble(place.linkState);
        const denied = banned(place);
        const canPrepare = !left && !dropped && !denied && place.linkState === 'active';
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
            {denied && (
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
                    {canPrepare && s.state === 'active' && (
                      <button
                        type="button"
                        className="link"
                        disabled={!!busy || backupInviteOpen}
                        aria-label={`Подготовить доступ к ${s.name || 'серверу'} на этом устройстве`}
                        onClick={() => void prepare(place, s)}
                      >
                        Подготовить доступ
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {ended && <div className="gp-done">Сессия завершена. Войти снова можно по ссылке-приглашению.</div>}
            {preparationError?.instanceId === place.instanceId && (
              <div className="gp-trouble" role="alert">{preparationError.message}</div>
            )}
            {dropped && (
              <div className="gp-done">Убрано с этого устройства. Членства там остались — вернуться можно по ссылке.</div>
            )}
            {/* Обе кнопки — про то, что там ещё есть: выйти с серверов и погасить сессию. После
                запрета нет ни того, ни другого, и кнопка, которая ничего не делает, только сбивает. */}
            {!denied && (
            <div className="gp-actions">
              <button
                type="button"
                className="link danger"
                disabled={!!busy || backupInviteOpen || left || place.servers.length === 0}
                onClick={() => void leaveAll(place)}
              >
                Выйти со всех серверов
              </button>
              <button
                type="button"
                className="link"
                disabled={!!busy || backupInviteOpen || ended}
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

const accessTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

function PreparedAccessNotice({ access }: { access: PreparedGuestAccess }) {
  const [now, setNow] = useState(Date.now);
  const { expiresAt } = access;
  useEffect(() => {
    const current = Date.now();
    setNow(current);
    if (expiresAt === null || expiresAt <= current) return;
    const timer = window.setTimeout(() => setNow(Date.now()), expiresAt - current);
    return () => window.clearTimeout(timer);
  }, [access, expiresAt]);

  return (
    <div className="gp-done">
      <span role="status">
        Хост подтвердил доступ к «{access.serverName}» на этом устройстве {accessTime.format(access.verifiedAt)}.{' '}
        {expiresAt === null
          ? 'Срок гостевой сессии неизвестен. Хост может отозвать её.'
          : expiresAt <= now
            ? `Срок проверенной сессии истёк ${accessTime.format(expiresAt)}.`
            : `Срок проверенной сессии до ${accessTime.format(expiresAt)}. Хост может отозвать её раньше.`}
      </span>{' '}
      <WebBackupStatus />
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
