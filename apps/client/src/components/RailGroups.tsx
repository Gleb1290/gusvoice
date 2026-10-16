import type { Server } from '@gusvoice/shared';
import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { bgUnread as readBgUnread, onBgUnread, type BgUnreadMap } from '../bgGateways';
import { activeInstanceId, instances } from '../config';
import { useFederationEnabled } from '../federationClient';
import { dropGoneGuests, ensureGuestSession, GuestJoinError, onGuestEntriesChanged, openInstance, sweepOtherHomes } from '../guestJoin';
import { refusalText } from '../inviteCheckRules';
import { buildRail, groupHeadTitle, serverTitle, type RailGroupView, type RailPlace, type RailServerView } from '../railRules';
import { guestEntryRebound } from '../configRules';
import { setPendingOpen } from '../pendingOpen';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { serverRowLine } from '../serverRowRules';
import { dmRowPreview, dmRowTime } from '../dmRowRules';
import { groupPreviewAuthor } from '../groupChatRules';

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
  onGroupMenu,
  rows = false,
}: {
  /** Телефон (#218): не значки-кружки рейла, а строки списка серверов — разметка и классы строки списка бесед (`.dm-row`). */
  rows?: boolean;
  /** Клик по серверу ЖИВОГО инстанса — обычный путь `ServerRail.select` (он же знает про закрытые). */
  onOpenLive: (serverId: string) => void;
  onMenu: (e: React.MouseEvent, s: Server) => void;
  /**
   * Правый клик / долгое нажатие по заголовку ЧУЖОЙ группы (15.10) — меню «Убрать из списка» (`ServerMenu.GuestGroupMenu`).
   * Работает и у серой группы (связка на паузе, хост не отвечает): именно там оно и нужно.
   */
  onGroupMenu?: (e: React.MouseEvent, group: RailGroupView) => void;
}) {
  const fed = useFederationEnabled();
  const servers = useStore((s) => s.servers);
  const currentServerId = useStore((s) => s.currentServerId);
  const view = useStore((s) => s.view);
  const closedServers = useStore((s) => s.closedServers);
  const unreadServers = useStore((s) => s.unreadServers);
  const mentionServers = useStore((s) => s.mentionServers);
  const pushMutedServers = useStore((s) => s.pushMutedServers);
  const meId = useStore((s) => s.user?.id);
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

  /* 15.10: связки дома с соседом больше нет — гостевые записи уходят с устройства (`guestGone.ts`). Перечитываем места
     по событию `federation.guest_links` (`guestLinksRev`) и по возврату на экран не чаще раза в 10 минут — телефон,
     открытый через неделю из фона, тоже уберёт группу; реестр поменялся — перерисоваться. */
  const guestLinksRev = useStore((s) => s.guestLinksRev);
  const [, setRegTick] = useState(0);
  const [visTick, setVisTick] = useState(0);
  const placesAt = useRef(0);
  /** Чьи места сейчас в `places`: перечитывание того же дома (событие, возврат на экран) их не обнуляет — иначе моргали бы группы. */
  const placesOf = useRef<string | null>(null);
  useEffect(() => {
    if (!fed) return;
    const offChanged = onGuestEntriesChanged(() => setRegTick((t) => t + 1));
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - placesAt.current > 10 * 60_000) setVisTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offChanged();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fed]);

  useEffect(() => {
    // Места — про ДОМ, откуда пришли (01.10: рейл больше не пересоздаётся на переходе): другой дом — спрашиваем заново.
    const placesKey = fed && atHome ? activeId : null;
    if (placesOf.current !== placesKey) {
      placesOf.current = placesKey;
      setPlaces([]);
      setPlacesLoaded(false);
    }
    if (!fed) return;
    // Гости ДРУГИХ своих домов и дом, когда стоим гостем, — своими ответами (мультиаккаунт: у каждого дома свои связки).
    void sweepOtherHomes();
    if (!atHome) return;
    let alive = true;
    placesAt.current = Date.now();
    api
      .fedMyGuest()
      .then((v) => {
        if (!alive) return;
        if (activeId) dropGoneGuests(activeId, v.places);
        setPlaces(v.places);
        setPlacesLoaded(true);
      })
      .catch(() => {
        /* дом не ответил — остаются снимки реестра, свои серверы на месте */
      });
    return () => {
      alive = false;
    };
  }, [fed, atHome, activeId, guestLinksRev, visTick]);

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

  /**
   * Меню заголовка группы соседа (15.10): «Убрать из списка». У своих групп меню нет — их убирают в «Мои инстансы».
   * ⚠️ Заголовок недоступной группы больше НЕ `disabled`, а `aria-disabled`: у выключенной кнопки браузер не отдаёт
   * правый клик, а меню нужнее всего именно у серой группы — у мёртвого соседа.
   */
  function groupMenu(e: React.MouseEvent, group: RailGroupView): void {
    if (!group.guest || !onGroupMenu) return;
    e.preventDefault();
    onGroupMenu(e, group);
  }

  if (rows) {
    /* Строка сервера на телефоне — та же сетка, что у беседы (`DmRow`): аватар 52, имя, вторая строка, справа счётчик.
       Telegram Android `DialogCell` (70 dp, аватар 52 в обычной раскладке); размеры и поля — `.app.m-list .dm-row`.
       Вторая строка (12.10, #218) — последнее сообщение сервера (`Server.lastMessage` из `GET /servers`, живьём — `sockets.ts`),
       как у группы в Telegram Android `DialogCell`: «Автор: текст», время справа сверху; справа снизу — число непрочитанного,
       при обращениях перед ним «@» (как у беседы, `.dm-marks`). Поля нет (старый бэкенд, чужой инстанс) или сервер закрыт —
       прежняя строка из счётчиков и состояния (`serverRowLine`). */
    return (
      <>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {showHeaders &&
              (group.live ? (
                <div className="dms-head srv-group-head" onContextMenu={(e) => groupMenu(e, group)}>
                  {group.guest && <Icon name="globe" size={13} />}
                  <span>{group.title}</span>
                </div>
              ) : (
                <button
                  type="button"
                  className={`dms-head srv-group-head go${group.reachable && !group.silent ? '' : ' off'}`}
                  title={groupHeadTitle(group)}
                  aria-disabled={!group.reachable || undefined}
                  disabled={busy === `head:${group.key}`}
                  onClick={() => group.reachable && void goToInstance(group)}
                  onContextMenu={(e) => groupMenu(e, group)}
                >
                  {group.guest && <Icon name="globe" size={13} />}
                  <span>{group.title}</span>
                  {/* 15.10: связка цела, хост молчит — словами в строке, а не только подсказкой (на телефоне её не навести). */}
                  {group.silent && <span className="srv-group-note">не отвечает</span>}
                </button>
              ))}
            {group.servers.map((s) => {
              const full = group.live ? servers.find((x) => x.id === s.id) : null;
              const open_ = group.live && view === 'server' && s.id === currentServerId;
              const last = !s.closed ? (full?.lastMessage ?? null) : null;
              const preview = last ? dmRowPreview({ typing: false, last: { ...last, sortKey: 0 } }) : null;
              const from =
                last && preview && (preview.kind === 'attachment' || preview.kind === 'text') ? groupPreviewAuthor(last, meId) : null;
              const when = last ? dmRowTime(last.createdAt) : null;
              const line = last ? null : serverRowLine(s);
              const solo = !last && !line;
              // С последним сообщением упоминания больше не написаны словами — справа «@» и общее число непрочитанного.
              const badge = s.closed
                ? 0
                : last
                  ? Math.max(s.unread, s.mentions)
                  : s.mentions > 0
                    ? s.mentions
                    : s.unread;
              const atMark = !!last && !s.closed && s.mentions > 0;
              const muted = group.live && pushMutedServers.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`dm-row srv-row${solo ? ' srv-solo' : ''}${badge > 0 ? ' unread has-tail' : ''}${s.closed ? ' rail-closed' : ''}${group.silent ? ' off' : ''}`}
                  aria-current={open_ ? 'true' : undefined}
                  title={serverTitle(group, s)}
                  disabled={!group.live && (busy === s.id || s.closed || !group.reachable)}
                  onClick={() => void open(group, s)}
                  onContextMenu={(e) => {
                    if (!full) return;
                    e.preventDefault();
                    onMenu(e, full);
                  }}
                >
                  <span className="dm-ava">
                    <Avatar name={s.name} url={s.iconUrl} size={52} />
                  </span>
                  <span className="dm-name">
                    <span className="dm-name-text">{s.name}</span>
                    {muted && (
                      <span className="dm-flag">
                        <Icon name="bell-off" size={12} stroke={1.75} title="Пуши сервера выключены" />
                      </span>
                    )}
                    {s.closed && (
                      <span className="dm-flag">
                        <Icon name="lock" size={12} stroke={1.75} title="Закрыт держателем" />
                      </span>
                    )}
                  </span>
                  {when && (
                    <span className="dm-when">
                      <time className="dm-time" dateTime={when.dateTime}>
                        {when.label}
                      </time>
                    </span>
                  )}
                  {preview ? (
                    <span className="dm-preview">
                      {from && <span className="dm-from">{from}: </span>}
                      {preview.kind === 'attachment' && (
                        <span className="dm-att">
                          <Icon name={preview.icon} size={14} />
                        </span>
                      )}
                      {preview.kind === 'attachment' ? preview.label : preview.kind === 'text' ? preview.text : ' '}
                    </span>
                  ) : (
                    line && <span className="dm-preview">{line}</span>
                  )}
                  {atMark ? (
                    <span className="dm-marks">
                      <span className="dm-mark" title="Непрочитанное упоминание">
                        <Icon name="at" size={12} stroke={2.2} />
                      </span>
                      <span className="dm-badge">{badge > 99 ? '99+' : badge}</span>
                    </span>
                  ) : (
                    badge > 0 && (
                      <span className={`dm-badge${s.mentions > 0 ? '' : ' muted'}`}>{badge > 99 ? '99+' : badge}</span>
                    )
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map((group, idx) => (
        <Fragment key={group.key}>
          {/* Разделитель — СОСЕД группы, а не её ребёнок: в мобильной ленте рейл прячет свои
              разделители правилом по прямым детям, и уехавший внутрь группы остался бы висеть
              поперёк ряда. */}
          {showHeaders && idx > 0 && <div className="rail-sep" />}
          <div className={`rail-group${group.silent ? ' off' : ''}`}>
          {showHeaders &&
            (group.live ? (
              <div className="rail-group-head" title={group.title} onContextMenu={(e) => groupMenu(e, group)}>
                {group.guest && <Icon name="globe" size={11} />}
                <span>{group.title}</span>
              </div>
            ) : (
              <button
                type="button"
                className={`rail-group-head go${group.reachable && !group.silent ? '' : ' off'}`}
                title={groupHeadTitle(group)}
                aria-disabled={!group.reachable || undefined}
                disabled={busy === `head:${group.key}`}
                onClick={() => group.reachable && void goToInstance(group)}
                onContextMenu={(e) => groupMenu(e, group)}
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
