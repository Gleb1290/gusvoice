import type { Server } from '@gusvoice/shared';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { bgUnread as readBgUnread, onBgUnread, type BgUnreadMap } from '../bgGateways';
import { activeInstanceId, instances } from '../config';
import { useFederationEnabled } from '../federationClient';
import { ensureGuestSession, GuestJoinError, openInstance } from '../guestJoin';
import { refusalText } from '../inviteCheckRules';
import { buildRail, groupHeadTitle, serverTitle, type RailGroupView, type RailPlace, type RailServerView } from '../railRules';
import { guestEntryRebound } from '../configRules';
import { setPendingOpen } from '../pendingOpen';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/**
 * Серверы ВСЕХ инстансов в рейле (#139, §5.7).
 *
 * 🔴 Здесь рисуется весь список серверов — и своих, и чужих. Раньше своими занимался `ServerRail`, а
 * этот файл дорисовывал гостевые группы и кнопку «вернуться в свой инстанс». Из-за этого рейл
 * отвечал на вопрос «что у меня есть» по-разному в зависимости от того, где человек стоит: уйдя
 * гостем к соседу, он переставал видеть собственные серверы. Теперь список один и тот же всегда, а
 * переход между инстансами — обычный клик по серверу, а не отдельная кнопка (требование приёмки).
 *
 * Правила показа — в `railRules.ts` (чистые). Здесь только данные и клики.
 */
export function RailGroups({
  onOpenLive,
  onMenu,
}: {
  /** Клик по серверу ЖИВОГО инстанса — обычный путь `ServerRail.select` (он же знает про закрытые). */
  onOpenLive: (serverId: string) => void;
  onMenu: (e: React.MouseEvent, s: Server) => void;
}) {
  const fed = useFederationEnabled();
  const servers = useStore((s) => s.servers);
  const currentServerId = useStore((s) => s.currentServerId);
  const view = useStore((s) => s.view);
  const closedServers = useStore((s) => s.closedServers);
  const unreadServers = useStore((s) => s.unreadServers);
  const mentionServers = useStore((s) => s.mentionServers);
  /**
   * Счётчики инстансов, куда человек сейчас не смотрит (§5.7). Не в сторе намеренно: стор чистится
   * при переходе между инстансами, а эти числа принадлежат ДРУГИМ инстансам и переход переживают.
   */
  const [bg, setBg] = useState<BgUnreadMap>(readBgUnread);
  const [places, setPlaces] = useState<RailPlace[]>([]);
  /** Ответ дома получен — с этого мига пустота значит «мест нет», а не «ещё не спросили». */
  const [placesLoaded, setPlacesLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /* Переход в другой инстанс больше не перемонтирует рейл (01.10): пока новый инстанс не отдал свои серверы, его
     группа рисуется из снимка реестра — иначе она на миг пустела бы; нажатая кнопка отпускается, когда переход
     закончился (раньше это делало перемонтирование). */
  const switching = useStore((s) => s.switching);
  useEffect(() => {
    if (!switching) setBusy(null);
  }, [switching]);

  // Реестр читается ОДИН раз за отрисовку: `instances()` каждый раз разбирает JSON из хранилища, а
  // рейл перерисовывается на каждое изменение непрочитанного.
  const registry = instances();
  const activeId = activeInstanceId();
  // Индекс членств живёт на ДОМЕ. Стоя гостем на хосте, спрашивать его некого — группы тогда
  // собираются из снимков реестра, и это ровно та причина, по которой снимки заведены.
  const atHome = !registry.find((i) => i.id === activeId)?.guestOf;

  useEffect(() => onBgUnread(setBg), []);

  useEffect(() => {
    // Места — про ДОМ, откуда пришли (01.10: рейл больше не пересоздаётся на переходе): другой дом — спрашиваем заново.
    setPlaces([]);
    setPlacesLoaded(false);
    if (!fed || !atHome) return;
    let alive = true;
    api
      .fedMyGuest()
      .then((v) => {
        if (!alive) return;
        setPlaces(v.places);
        setPlacesLoaded(true);
      })
      .catch(() => {
        /* дом не ответил — остаются снимки реестра, свои серверы на месте */
      });
    return () => {
      alive = false;
    };
  }, [fed, atHome, activeId]);

  const { groups, showHeaders } = buildRail({
    instances: registry,
    activeId,
    liveServers: switching && servers.length === 0 ? (registry.find((i) => i.id === activeId)?.servers ?? []) : servers,
    closedServerIds: Object.keys(closedServers),
    liveUnread: unreadServers,
    liveMentions: mentionServers,
    bgUnread: bg,
    places,
    placesLoaded,
  });

  /**
   * Открыть сервер, где бы он ни жил.
   *
   * ⚠️ Переход в другой инстанс пока перезапускает приложение, поэтому намерение «открыть именно
   * этот сервер» записывается ДО перехода (`pendingOpen`) — иначе человек попадал бы «куда-то туда»
   * и искал сервер заново.
   */
  /**
   * В какую запись реестра вести — заводя гостевую сессию, если её нет или токен хоста протух.
   *
   * 🔴 Иначе переход привёл бы человека на экран входа ЧУЖОГО инстанса, где ему нечего ввести:
   * пароля у него там нет и быть не может, за него ручается дом. Своя запись без токена — другое
   * дело: там экран входа и есть правильный ответ, поэтому её этим путём не ведём.
   */
  async function instanceIdFor(group: RailGroupView): Promise<string> {
    const entry = group.instanceId ? (registry.find((i) => i.id === group.instanceId) ?? null) : null;
    /**
     * 🔴 Хост сменил ключ и перепривязан (прогон F-20, 23.09): у записи прежняя личность, её токен выдан
     * прежней и погашен. Отдать её как есть — переход, отказ, «сессия истекла», второй клик. Ведём
     * через `ensureGuestSession`: он перепишет запись и заведёт сессию сразу.
     */
    const rebound = !!entry?.guestOf && !!group.place && guestEntryRebound(entry, group.place.instanceId);
    if (entry && !(entry.guestOf && !entry.token) && !rebound) return entry.id;
    /**
     * 🔴 **Гостевую запись БЕЗ токена отдавать наружу нельзя.** Переход в неё кончится тем, что
     * человека без разговоров вернёт домой (`bounceStrandedGuestHome`): приложение моргнёт и ничего
     * не произойдёт — ни ошибки, ни объяснения, только лишний круг загрузки. Ровно это и случилось
     * на стенде 18.09, когда я «смягчил» здесь отказ до молчаливого возврата id.
     *
     * Сессию заводит `ensureGuestSession`, и для неё нужна строка «где я гость» от дома. Нет её —
     * говорим человеку словами, а не отправляем по кругу.
     */
    if (!group.place) {
      /**
       * ⚠️ Текст называет ДВЕ разные причины, потому что они требуют разных действий, а выглядят
       * одинаково. Дом не вернул НИ ОДНОГО гостевого места — почти всегда это «вошёл под другой
       * учётной записью»: гостевые членства принадлежат человеку, а не браузеру. Дом вернул места,
       * но не это — значит членство на том сервере сняли или связку приостановили.
       */
      throw new Error(
        places.length === 0
          ? `«${group.title}» остался в списке от прошлого входа: за вами сейчас не числится ни одного гостевого сервера. Чаще всего это значит, что вы вошли под другой учётной записью.`
          : `Ваш инстанс больше не числит вас гостем на «${group.title}» — членство сняли или связка приостановлена. Войдите по новой ссылке.`,
      );
    }
    const { entry: fresh } = await ensureGuestSession(group.place);
    return fresh.id;
  }

  /**
   * Отказ при переходе — словами, а не кодом. Коды федерации (`wrong-host`, «нет связки», «сервер
   * закрыт») уже переведены на человеческий в `inviteCheckRules.refusalText`, и второй набор
   * формулировок здесь означал бы, что у одной причины два разных текста.
   */
  function reportFailure(group: RailGroupView, e: unknown): void {
    if (e instanceof GuestJoinError) toast('error', refusalText(e.code, group.title));
    else toastError(e);
  }

  async function open(group: RailGroupView, server: RailServerView) {
    if (group.live) {
      onOpenLive(server.id);
      return;
    }
    setBusy(server.id);
    try {
      const instanceId = await instanceIdFor(group);
      setPendingOpen({ instanceId, serverId: server.id });
      await openInstance(instanceId);
    } catch (e) {
      reportFailure(group, e);
      setBusy(null);
    }
  }

  /**
   * Перейти в инстанс, не открывая конкретный сервер — клик по подписи группы.
   *
   * 🔴 Это дорога назад для того, у кого ДОМА нет своих серверов: нажимать в его группе было бы
   * нечего, и человек оставался бы в гостях без выхода. Оживлена существующая подпись, а не
   * заведена кнопка «вернуться»: подпись есть у КАЖДОЙ чужой группы, и ведёт она туда, что
   * написано, — это не особое действие, а тот же обычный переход.
   */
  async function goToInstance(group: RailGroupView) {
    if (group.live) return;
    setBusy(`head:${group.key}`);
    try {
      await openInstance(await instanceIdFor(group));
    } catch (e) {
      reportFailure(group, e);
      setBusy(null);
    }
  }

  return (
    <>
      {groups.map((group, idx) => (
        <Fragment key={group.key}>
          {/* Разделитель — СОСЕД группы, а не её ребёнок: в мобильной ленте рейл прячет свои
              разделители правилом по прямым детям, и уехавший внутрь группы остался бы висеть
              поперёк ряда. */}
          {showHeaders && idx > 0 && <div className="rail-sep" />}
          <div className="rail-group">
          {showHeaders &&
            (group.live ? (
              <div className="rail-group-head" title={group.title}>
                {group.guest && <Icon name="globe" size={11} />}
                <span>{group.title}</span>
              </div>
            ) : (
              <button
                type="button"
                className={`rail-group-head go${group.reachable ? '' : ' off'}`}
                title={groupHeadTitle(group)}
                disabled={!group.reachable || busy === `head:${group.key}`}
                onClick={() => void goToInstance(group)}
              >
                {group.guest && <Icon name="globe" size={11} />}
                <span>{group.title}</span>
              </button>
            ))}
          {group.servers.map((s) => {
            const full = group.live ? servers.find((x) => x.id === s.id) : null;
            const open_ = group.live && view === 'server' && s.id === currentServerId;
            return (
              <button
                key={s.id}
                type="button"
                className={`rail-icon${open_ ? ' active' : ''}${s.closed ? ' rail-closed' : ''}`}
                title={serverTitle(group, s)}
                // Живую кнопку не гасим никогда: закрытый сервер должен объяснить себя окном, а не
                // молча не нажиматься. Чужую — гасим: там объяснять нечем, мы туда даже не ходили.
                disabled={!group.live && (busy === s.id || s.closed || !group.reachable)}
                onClick={() => void open(group, s)}
                onContextMenu={(e) => {
                  if (!full) return;
                  e.preventDefault();
                  onMenu(e, full);
                }}
              >
                {s.iconUrl ? <img className="rail-img" src={s.iconUrl} alt="" loading="lazy" /> : (s.name[0]?.toUpperCase() ?? '?')}
                {s.closed && (
                  <span className="rail-lock" aria-label="закрыт держателем">
                    <Icon name="lock" size={11} />
                  </span>
                )}
                {/* Непрочитанное есть у ЛЮБОЙ группы, с которой открыт шлюз: у активной — из стора,
                    у остальных — от фонового соединения (§5.7). Закрытому серверу значок не рисуем:
                    туда всё равно не войти, и звать туда человека нечестно. */}
                {!s.closed && s.mentions > 0 ? (
                  <span className="rail-badge">{s.mentions > 99 ? '99+' : s.mentions}</span>
                ) : !s.closed && s.unread > 0 ? (
                  <span className="rail-badge muted">{s.unread > 99 ? '99+' : s.unread}</span>
                ) : null}
              </button>
            );
          })}
          </div>
        </Fragment>
      ))}
    </>
  );
}
