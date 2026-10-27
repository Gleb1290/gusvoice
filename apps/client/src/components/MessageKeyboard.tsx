/**
 * Кнопки под сообщением бота (#230, `ConvMessage.keyboard` = `reply_markup.inline_keyboard` Bot API) и нажимаемые `/команды`
 * в его тексте. Вид — tdesktop `ui/chat/chat.style:279` (`msgBotKbButton`: высота 36, зазор 2, поля 10; телефон — Telegram
 * Android `ChatMessageCell`: 44 dp, зазор 4) — стили `.bot-kb*` в `styles.css`. Правила — `botKeyboardRules.ts`.
 *
 * Нажатие callback-кнопки — долгий запрос `api.convBotCallback` (в канале, #231, — `api.channelBotCallback`): пока висит, на кнопке часики, повторное нажатие этой же
 * кнопки не делает ничего (другие живут — у tdesktop `requestId` у каждой кнопки). Ответ: `alert` — окно, `text` — всплывашка,
 * молчание и `timeout` — ничего. url-кнопка: своя ссылка — сразу, чужая — «Открыть ссылку?» (подпись может врать про адрес).
 */
import { Fragment, cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import type { InlineKeyboard, InlineKeyboardButton } from '@gusvoice/shared';
import { api } from '../api';
import {
  BOT_CALLBACK_CLIENT_WAIT_MS,
  STALE_BUTTON_TEXT,
  callbackErrorOutcome,
  callbackOutcome,
  drawableKeyboard,
  kbPressKey,
  kbUrlAction,
  splitBotCommands,
} from '../botKeyboardRules';
import { alertDialog } from '../confirm';
import { isOwnLink, LinkConfirmModal, openLink } from '../linkGuard';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/** Кнопки, ждущие ответа бота, — на весь модуль: строка ленты может пересоздаться, а часики и запрет повтора должны остаться. */
const pressing = new Set<string>();

/** Нажатие внутри клавиатуры не доходит до строки ленты: иначе тап по кнопке на телефоне открыл бы ещё и меню сообщения. */
const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/**
 * Чьё сообщение (#231): беседа 1:1 с ботом или канал сервера. Отличие только в адресе нажатия (`convBotCallback` /
 * `channelBotCallback`); `convId` — прежний проп этапа 2 (= `{ kind: 'conv', id }`).
 */
export type KeyboardTarget = { kind: 'conv'; id: string } | { kind: 'channel'; id: string };

export function MessageKeyboard({
  convId,
  target,
  messageId,
  keyboard,
}: {
  convId?: string;
  target?: KeyboardTarget;
  messageId: string;
  keyboard: InlineKeyboard;
}) {
  const to: KeyboardTarget | null = target ?? (convId ? { kind: 'conv', id: convId } : null);
  const rows = drawableKeyboard(keyboard);
  const [, bump] = useState(0);
  const [ask, setAsk] = useState<string | null>(null);
  if (!rows.length || !to) return null;

  async function pressCallback(data: string) {
    const key = kbPressKey(messageId, data);
    if (pressing.has(key)) return;
    pressing.add(key);
    bump((n) => n + 1);
    try {
      const res =
        to!.kind === 'channel'
          ? await api.channelBotCallback(to!.id, messageId, data, BOT_CALLBACK_CLIENT_WAIT_MS)
          : await api.convBotCallback(to!.id, messageId, data, BOT_CALLBACK_CLIENT_WAIT_MS);
      const out = callbackOutcome(res);
      if (out.kind === 'alert') void alertDialog(out.text);
      else if (out.kind === 'toast') toast('info', out.text);
    } catch (err) {
      const how = callbackErrorOutcome(err);
      if (how === 'stale') toast('info', STALE_BUTTON_TEXT);
      else if (how === 'error') toastError(err, 'Бот не получил нажатие');
    } finally {
      pressing.delete(key);
      bump((n) => n + 1);
    }
  }

  function press(b: InlineKeyboardButton) {
    if (typeof b.url === 'string') {
      if (kbUrlAction(isOwnLink(b.url)) === 'open') openLink(b.url);
      else setAsk(b.url);
      return;
    }
    if (typeof b.callback_data === 'string') void pressCallback(b.callback_data);
  }

  return (
    <div className="bot-kb" role="group" aria-label="Кнопки бота" onClick={stop} onMouseDown={stop} onDoubleClick={stop} onTouchStart={stop}>
      {rows.map((row, r) => (
        <div className="bot-kb-row" key={r}>
          {row.map((b, i) => {
            const busy = typeof b.callback_data === 'string' && pressing.has(kbPressKey(messageId, b.callback_data));
            return (
              <button
                type="button"
                key={`${i}:${b.callback_data ?? b.url}`}
                className={`bot-kb-btn${b.url ? ' url' : ''}${busy ? ' loading' : ''}`}
                title={b.url}
                aria-busy={busy || undefined}
                onClick={() => press(b)}
              >
                <span className="bot-kb-text">{b.text}</span>
                {busy ? (
                  <span className="confirm-spin bot-kb-ico" aria-hidden="true" />
                ) : b.url ? (
                  <span className="bot-kb-ico" aria-hidden="true">
                    <Icon name="arrow-up-right" size={12} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      {ask && <LinkConfirmModal url={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}

/** Узлы, внутрь которых `/команды` не ищем: код, ссылки и любые свои компоненты (упоминание, ссылка, эмодзи). */
const SKIP = new Set(['pre', 'code', 'a', 'button']);

/**
 * `/команда` в тексте сообщения бота — кнопка, тап отправляет её (Telegram: сущность `bot_command` в сообщении бота). Обходит
 * уже разобранный текст (`renderMessageText`): строки режутся `splitBotCommands`, обычные теги (жирный, цитата, спойлер)
 * обходятся вглубь, код и ссылки — нет. Без `onCommand` (автор не бот) — текст как есть.
 */
export function linkBotCommands(nodes: ReactNode, onCommand: ((cmd: string) => void) | undefined, key = 'c'): ReactNode {
  if (!onCommand) return nodes;
  if (typeof nodes === 'string') {
    const parts = splitBotCommands(nodes);
    if (parts.length === 1 && typeof parts[0] === 'string') return nodes;
    return parts.map((p, i) =>
      typeof p === 'string' ? (
        <Fragment key={`${key}.${i}`}>{p}</Fragment>
      ) : (
        <button
          type="button"
          key={`${key}.${i}`}
          className="bot-cmd"
          onClick={(e) => {
            e.stopPropagation();
            onCommand(p.cmd);
          }}
        >
          {p.cmd}
        </button>
      ),
    );
  }
  if (Array.isArray(nodes)) return nodes.map((n, i) => <Fragment key={`${key}.${i}`}>{linkBotCommands(n, onCommand, `${key}.${i}`)}</Fragment>);
  if (isValidElement(nodes) && typeof nodes.type === 'string' && !SKIP.has(nodes.type)) {
    const el = nodes as ReactElement<{ children?: ReactNode }>;
    if (el.props.children === undefined) return el;
    return cloneElement(el, undefined, linkBotCommands(el.props.children, onCommand, key));
  }
  return nodes;
}
