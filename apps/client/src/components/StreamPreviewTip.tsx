import {
  STREAM_PREVIEW_HOVER_DELAY_MS,
  STREAM_PREVIEW_REFRESH_MS,
  type CustomStatus,
  type GameActivity,
  type PresenceStatus,
} from '@gusvoice/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { cardGesture } from '../cardGesture';
import { createHoverHold, type HoverHold } from '../hoverHold';
import { topRoles, type RoleForBadge } from '../memberRoles';
import { clampAxis, toLayoutRect, viewport } from '../popover';
import { customStatusVisible, effectiveDot, type DotStatus } from '../status';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import { hexRgba, roleHex } from './UserContextMenu';

/**
 * Карточка человека со стримом по наведению мышкой (#115): слева краткий профиль, справа свежий
 * кадр его показа. Работает и снаружи канала, и внутри него.
 *
 * До этого про чужой показ было известно ровно одно — что он идёт. Чтобы понять, ЧТО человек
 * показывает, надо было зайти к нему в голосовой, то есть влезть в разговор и обозначить себя.
 *
 * ⚠️ Карточка появляется СРАЗУ с профилем, не дожидаясь кадра, и живёт даже если кадра не будет.
 * Это не украшательство: превью отдаёт клиент показывающего, и у человека на старой версии его нет
 * в принципе. Молчаливое «ничего не произошло» в этом случае читается как поломка — карточка с
 * профилем и честной подписью объясняет, что произошло.
 *
 * ⚠️ Запрос идёт ТОЛЬКО пока мышка висит над строкой. Список каналов виден всегда, и фоновое
 * обновление превью для всех стримеров означало бы постоянный трафик ради картинок, на которые
 * никто не смотрит.
 */

/**
 * Размеры карточки. Держим в паре с `.stream-tip` в стилях — по ним выбирается сторона.
 *
 * Размер РАЗНЫЙ: с кадром карточка широкая, без кадра (человек не показывает) — узкая, иначе
 * половина её была бы пустотой. Роли добавляют строку значков снизу. Числа приблизительные и это
 * нормально: они нужны только чтобы карточка не вылезла за край экрана.
 */
const TIP_W_WITH_SHOT = 470;
const TIP_W_SLIM = 260;
const TIP_H_BASE = 180;
/** Высота одной строки значков + отступ полосы. Замерено на стенде: шесть ролей в узкой = 93 px. */
const ROLE_ROW_H = 26;
const ROLES_PAD = 10;
/** Сколько значков влезает в строку. В узкой карточке вдвое меньше — она и шириной вдвое меньше. */
const rolesPerRow = (withShot: boolean) => (withShot ? 4 : 2);
const GAP = 10;

/** Прикидка высоты полосы ролей — ТОЛЬКО чтобы карточка не вылезла за край экрана. */
function rolesHeight(count: number, withShot: boolean): number {
  if (count === 0) return 0;
  return Math.ceil(count / rolesPerRow(withShot)) * ROLE_ROW_H + ROLES_PAD;
}

/**
 * Сколько карточка ждёт курсор, ушедший со строки.
 *
 * За это время мышка должна успеть пройти зазор в {@link GAP} и попасть на саму карточку — иначе
 * по кадру нельзя кликнуть в принципе. Меньше — не успеть неспешной рукой; заметно больше —
 * карточка висит над списком уже после того, как человек передумал.
 */
const TIP_GRACE_MS = 260;

/**
 * Карточка встаёт СБОКУ от строки, а не над ней.
 *
 * 🔴 Обычное «над или под кнопкой» здесь не годится: строка живёт в узком списке каналов, и
 * карточка шириной в 440 точек накрывала бы этот самый список — то есть то, по чему водят мышкой.
 * Уходим вправо, в область содержимого; если справа не влезает (узкое окно) — влево.
 */
function place(anchor: DOMRect, w: number, h: number): { left: number; top: number } {
  const { vw, vh } = viewport();
  let left = anchor.right + GAP;
  if (left + w > vw - 8) left = anchor.left - w - GAP;
  // По вертикали цепляемся за строку, но приподнимаем: так центр карточки оказывается примерно
  // напротив курсора, а не уезжает вниз.
  return { left: clampAxis(left, w, vw, 8), top: clampAxis(anchor.top - h / 2 + 12, h, vh, 8) };
}

export interface StreamPreviewTarget {
  channelId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** Показывает ли экран прямо сейчас. Без показа кадра не будет — и место под него не отводим. */
  streaming: boolean;
}

interface Tip extends StreamPreviewTarget {
  dot: DotStatus;
  username: string | null;
  custom: CustomStatus | null;
  game: GameActivity | null;
  /** Роли от старшей к младшей — общее правило с нижней шторкой профиля (`memberRoles.ts`). */
  roles: RoleForBadge[];
  /** Карточку закрепили кликом: она не закрывается уводом мышки, только Esc или кликом мимо. */
  pinned: boolean;
  /** Кадр. `null` — либо ещё не дошёл, либо его нет; различает `answered`. */
  image: string | null;
  /** Ответ по превью уже получен — значит, пустота это ответ, а не ожидание. */
  answered: boolean;
  left: number;
  top: number;
}

/**
 * Профиль на момент наведения. Читаем НЕПОДПИСАННО (`getState`), а не селектором: подписка на
 * статусы и игры ре-рендерила бы весь сайдбар на каждое их изменение у кого угодно, а карточка
 * живёт секунды — свежести на момент открытия достаточно.
 */
function profileOf(userId: string): Pick<Tip, 'dot' | 'username' | 'custom' | 'game' | 'roles'> {
  const s = useStore.getState();
  const st: PresenceStatus = s.userStatuses[userId]?.status ?? 'online';
  const online = s.onlineUsers.includes(userId);
  const isSelf = s.user?.id === userId;
  const custom = s.userStatuses[userId]?.customStatus ?? null;
  const member = s.members.find((m) => m.user.id === userId);
  return {
    dot: effectiveDot(st, online, isSelf),
    username: member?.user.username ?? null,
    custom: customStatusVisible(st, online, isSelf) ? custom : null,
    game: s.userActivities[userId] ?? null,
    // Роли берём тем же правилом, что и нижняя шторка профиля: две копии показали бы одному
    // человеку разный набор в двух местах одного экрана.
    roles: topRoles(s.bootstrap?.roles ?? [], member?.roleIds ?? []),
  };
}

export function useStreamPreview() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timers = useRef<{ open: number | null; refresh: number | null }>({ open: null, refresh: null });
  // Номер наводки. Всё, что прилетит от прошлой, отбрасывается по несовпадению: иначе ответ,
  // догнавший нас после ухода мышки, показал бы карточку заново — уже не под курсором.
  const session = useRef(0);

  // Канал, в котором мы сейчас: от него зависит подпись на кадре. Значение меняется только на
  // входе-выходе из голоса, поэтому подписка тут ничего не стоит.
  const voiceChannelId = useStore((s) => s.voice?.channelId ?? null);

  const clearTimers = useCallback(() => {
    if (timers.current.open !== null) window.clearTimeout(timers.current.open);
    if (timers.current.refresh !== null) window.clearTimeout(timers.current.refresh);
    timers.current = { open: null, refresh: null };
  }, []);

  // Кто показан ЗАКРЕПЛЁННОЙ карточкой (`null` — закреплённой нет). В ссылке, а не только в
  // состоянии: и `leave`, и слушатель «нажали мимо» стабильны и до состояния не дотягиваются, а
  // решать им приходится на каждый увод мышки и на каждое нажатие в окне.
  const pinnedUserRef = useRef<string | null>(null);

  const closeNow = useCallback(() => {
    session.current += 1;
    pinnedUserRef.current = null;
    clearTimers();
    setTip(null);
  }, [clearTimers]);

  // Удержание создаётся ОДИН раз и замкнуло бы на себе первый `closeNow`, поэтому ходим через
  // ссылку на актуальный — тем же приёмом, что и грейс просмотра в сцене.
  const closeRef = useRef(closeNow);
  closeRef.current = closeNow;
  const holdRef = useRef<HoverHold | null>(null);
  if (holdRef.current === null) {
    holdRef.current = createHoverHold({
      close: () => closeRef.current(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
      graceMs: TIP_GRACE_MS,
    });
  }

  /**
   * Курсор ушёл со строки ИЛИ с карточки — закрываем с отсрочкой, а не мгновенно.
   *
   * ⚠️ Закреплённую карточку уход мышки не трогает вовсе: её открыли кликом, значит человек
   * собирается в ней что-то прочитать или нажать, и увод курсора — не повод её отнимать.
   */
  const leave = useCallback(() => {
    if (pinnedUserRef.current !== null) return;
    holdRef.current?.release();
  }, []);

  /**
   * Общее тело для наведения и клика — карточка ОДНА, отличается только тем, как её вызвали:
   * наведение ждёт задержку и закрывается уводом мышки, клик открывает сразу и закрепляет.
   * Решение «открыть, закрыть или не трогать» принимает чистое правило `cardGesture`.
   */
  const begin = useCallback(
    (el: HTMLElement, target: StreamPreviewTarget, gesture: 'hover' | 'click') => {
    const action = cardGesture({ gesture, pinnedUserId: pinnedUserRef.current, targetUserId: target.userId });
    if (action === 'ignore') return;
    if (action === 'close') {
      closeNow();
      return;
    }
    const pinned = action === 'open-pinned';
    // Перевели мышку на соседа (или кликнули по другому) — прошлая наводка больше не наша, и ждать
    // тут нечего: курсор уже на новой цели, отсрочка показывала бы чужой профиль поверх неё.
    holdRef.current?.closeNow();
    const mine = session.current;
    const profile = profileOf(target.userId);
    // Экранные координаты → вёрсточные: при масштабе ≠ 100% карточка иначе уедет мимо строки.
    const anchor = toLayoutRect(el.getBoundingClientRect());
    const w = target.streaming ? TIP_W_WITH_SHOT : TIP_W_SLIM;
    const h = TIP_H_BASE + rolesHeight(profile.roles.length, target.streaming);
    const { left, top } = place(anchor, w, h);

    const show = () => {
      pinnedUserRef.current = pinned ? target.userId : null;
      setTip({ ...target, ...profile, image: null, answered: false, pinned, left, top });
      // Кадр запрашиваем только у того, кто показывает: остальным просить нечего.
      if (target.streaming) void pull();
    };

    const pull = async () => {
      let image: string | null = null;
      try {
        image = (await api.getStreamPreview(target.channelId, target.userId)).image;
      } catch {
        // 404 — кадра нет: человек на старой версии, выключил отдачу или уже не показывает.
        image = null;
      }
      if (session.current !== mine) return;
      // Профиль не пересобираем — карточка уже стоит, дёргать её незачем.
      setTip((t) => (t ? { ...t, image, answered: true } : t));
      // Следующий заход планируем ТОЛЬКО после ответа: медленная сеть иначе накладывала бы
      // запросы друг на друга.
      timers.current.refresh = window.setTimeout(() => void pull(), STREAM_PREVIEW_REFRESH_MS);
    };

    // По клику — сразу: человек уже выбрал, кого смотреть, и ждать ему нечего. По наведению — с
    // задержкой, иначе проведённая через список мышка дёргала бы запрос на каждого, мимо кого прошла.
      if (pinned) show();
      else timers.current.open = window.setTimeout(show, STREAM_PREVIEW_HOVER_DELAY_MS);
    },
    [closeNow],
  );

  const enter = useCallback(
    (el: HTMLElement, target: StreamPreviewTarget) => begin(el, target, 'hover'),
    [begin],
  );

  /** Клик по строке участника: та же карточка, но сразу и закреплённая. */
  const open = useCallback((el: HTMLElement, target: StreamPreviewTarget) => begin(el, target, 'click'), [begin]);

  /**
   * Клик по кадру: зайти в канал (если мы не там) и открыть показ.
   *
   * ⚠️ Само открытие здесь НЕ делается — трека ещё нет. Оставляем намерение, его подберёт сцена,
   * когда появится подходящий трек; разбор — в `pendingWatch.ts`.
   */
  const go = useCallback((t: Tip) => {
    holdRef.current?.closeNow();
    const s = useStore.getState();
    s.setPendingWatch({ channelId: t.channelId, userId: t.userId, at: Date.now() });
    s.enterVoiceChannel(t.channelId).catch((e: Error) => {
      // Не зашли (нет права, сеть) — намерение висеть не должно: иначе оно молча сработает при
      // следующем случайном заходе в этот канал и откроет показ, которого человек уже не просил.
      useStore.getState().clearPendingWatch();
      toastError(e);
    });
  }, []);

  // Список размонтировали (ушли с сервера, свернули категорию) — снимаем и отсрочку, и таймеры
  // запроса. Закрывать через состояние тут уже нельзя: дерева нет.
  useEffect(
    () => () => {
      holdRef.current?.dispose();
      session.current += 1;
      clearTimers();
    },
    [clearTimers],
  );

  // Подпись зависит от того, где мы: заходить не нужно, если уже стоим в этом канале.
  const goLabel = tip && voiceChannelId === tip.channelId ? 'Смотреть' : 'Зайти и смотреть';

  /**
   * Закреплённую карточку закрывают Esc или клик мимо неё.
   *
   * ⚠️ Слушатели вешаются В ЭФФЕКТЕ, то есть уже ПОСЛЕ того `pointerdown`, который её открыл, —
   * иначе то же самое нажатие сразу же её и закрыло бы. Ловим именно `pointerdown`, а не `click`:
   * `click` по строке участника прилетает ей же и после перетаскивания (замерено), и карточка
   * закрывалась бы от жестов, к ней не относящихся.
   */
  useEffect(() => {
    if (!tip?.pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNow();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) {
        closeNow();
        return;
      }
      if (t.closest('.stream-tip')) return;
      // 🔴 Нажатие по строке ТОГО ЖЕ человека здесь НЕ закрываем — этим займётся её `onClick`,
      // который умеет переключать. Иначе повторный клик гасил бы карточку прямо на `pointerdown`,
      // а долетевший следом `click` открывал бы её заново: на вид она просто моргала, и закрыть
      // её кликом было невозможно.
      const row = t.closest('[data-pp]');
      if (row !== null && row.getAttribute('data-pp') === pinnedUserRef.current) return;
      closeNow();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [tip?.pinned, closeNow]);

  const node = tip ? (
    // 🔴 `role="tooltip"` снят намеренно: внутри теперь кнопка, а подсказка с управлением внутри —
    // это ловушка для скринридера (роль обещает «просто текст», который читают и забывают).
    <div
      className={`stream-tip${tip.streaming ? '' : ' slim'}${tip.pinned ? ' pinned' : ''}`}
      style={{ left: tip.left, top: tip.top }}
      // Карточка ПРИНИМАЕТ мышь (по кадру надо кликать) и потому обязана держать себя сама: иначе
      // курсор, зашедший на неё, считался бы ушедшим со строки и карточка закрылась бы под ним.
      onMouseEnter={() => holdRef.current?.hold()}
      onMouseLeave={leave}
    >
      <div className="stream-tip-main">
      <div className="stream-tip-who">
        <span className="stream-tip-ava">
          <Avatar url={tip.avatarUrl} name={tip.name} size={48} fallback="icon" />
          <span className="stream-tip-dot">
            <StatusDot status={tip.dot} size={14} ringColor="var(--bg-2)" />
          </span>
        </span>
        <span className="stream-tip-name">{tip.name}</span>
        {tip.username && <span className="stream-tip-handle">@{tip.username}</span>}
        {/* Игра ИЛИ статус, не оба сразу — как в списке участников (`ServerMembersPanel`). Две
            строки мелкого текста под именем в карточке шириной в полторы ладони — это шум. */}
        {tip.game ? (
          <span className="stream-tip-game" title={`Играет в ${tip.game.name}`}>
            <Icon name="gamepad" size={12} />
            <span className="stream-tip-line">{tip.game.name}</span>
          </span>
        ) : tip.custom ? (
          <span className="stream-tip-custom">
            {tip.custom.emoji && <span className="stream-tip-emoji">{tip.custom.emoji}</span>}
            <span className="stream-tip-line">{tip.custom.text}</span>
          </span>
        ) : null}
      </div>
      {/* Кадр — кнопка. Кликабелен и БЕЗ картинки: превью может не дойти (старая версия у
          показывающего, выключенная отдача), а посмотреть показ человек всё равно хочет — отнимать
          у него эту возможность из-за отсутствия картинки не за что.
          Показа нет вовсе — места под кадр не отводим, иначе половина карточки была бы пустотой. */}
      {tip.streaming && (
        <button type="button" className="stream-tip-shot" onClick={() => go(tip)} title={goLabel}>
          {/* Причину отсутствия кадра НЕ называем: их несколько (старая версия у показывающего,
              выключенная отдача, показ уже закончился), и со стороны зрителя не различить. */}
          {tip.image ? (
            <img src={tip.image} alt={`Показ экрана: ${tip.name}`} draggable={false} />
          ) : (
            <span className="stream-tip-empty">{tip.answered ? 'Превью недоступно' : 'Загружаем кадр…'}</span>
          )}
          <span className="stream-tip-go">
            <Icon name="play" size={14} />
            {goLabel}
          </span>
        </button>
      )}
      </div>
      {/* Роли — отдельной полосой снизу, а не под именем: там уже живут @ник и игра-или-статус, и
          третья строка мелкого текста превратила бы колонку в кашу. Значки читаются рядом. */}
      {tip.roles.length > 0 && (
        <div className="stream-tip-roles">
          {tip.roles.map((r) => {
            const hex = r.color ? roleHex(r.color) : null;
            return (
              <span
                key={r.id}
                className="stream-tip-role"
                style={hex ? { background: hexRgba(hex, 0.16), color: hex } : undefined}
              >
                <span className="stream-tip-role-dot" style={hex ? { background: hex } : undefined} />
                {r.name}
              </span>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  return { enter, leave, open, node };
}
