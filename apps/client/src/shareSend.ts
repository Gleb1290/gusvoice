import type { Attachment } from '@gusvoice/shared';
import { api } from './api';
import { newClientId } from './clientId';
import { toOutboxRef } from './convStore';
import { sharePlan, type SharePlan } from './longTextRules';
import { useStore } from './store';

/**
 * «Поделиться в…» — отправка сразу в несколько мест (09.10, мультивыбор как у Telegram: `ShareBox` / `DialogsActivity` в
 * режиме «поделиться» — отметили беседы, «Отправить (N)» шлёт всем, без захода в каждую). Принятое из чужого приложения
 * (текст и файлы, `ShareIncoming`) уходит в каждое место ОТДЕЛЬНЫМ сообщением: файлы + текст подписью (как одна отправка из
 * поля), «Комментарий» окна — отдельным сообщением ПЕРЕД ним (как у Telegram: комментарий первым). Места идут по очереди,
 * сбой одного не останавливает остальные.
 *
 * Все три пути — те же ручки, что у поля ввода: беседы режима бесед (`convUpload` + `convSend`), ЛС старого пути
 * (`uploadDmAttachment` + `sendDmMessage`), каналы серверов (`uploadAttachment` + `sendMessage`).
 */

export type ShareTarget = { kind: 'conv' | 'channel'; id: string };

export interface SharePayload {
  /** Текст принятого (в подпись к файлам или отдельным сообщением, если файлов нет). */
  text: string;
  files: readonly File[];
  /** Поле «Комментарий» окна выбора, уже после `trim`. */
  comment: string;
}

/** Одно место: что вышло. `ok` — всё ушло. */
export interface ShareResult {
  target: ShareTarget;
  ok: boolean;
  error?: unknown;
}

/** Отправка в одно место по готовой раскладке (`sharePlan`); бросает при первом же сбое. */
async function sendOne(t: ShareTarget, files: readonly File[], plan: Extract<SharePlan, { ok: true }>): Promise<void> {
  const st = useStore.getState();
  // Одно сообщение: канал сервера / беседа режима бесед / ЛС старого пути; вложения грузятся перед отправкой.
  const sendText = async (content: string, upload: readonly File[]): Promise<void> => {
    if (t.kind === 'channel') {
      const atts: Attachment[] = [];
      for (const f of upload) atts.push(await api.uploadAttachment(t.id, f));
      st.appendMessage(t.id, await api.sendMessage(t.id, content, atts));
    } else if (st.convActive) {
      const refs = [];
      for (const f of upload) refs.push(toOutboxRef(await api.convUpload(t.id, f)));
      const msg = await api.convSend(t.id, { clientId: newClientId(), content, attachments: refs });
      useStore.getState().convAfterSend(t.id, msg);
    } else {
      const atts: Attachment[] = [];
      for (const f of upload) atts.push(await api.uploadDmAttachment(t.id, f));
      st.appendDmMessage(t.id, await api.sendDmMessage(t.id, content, atts));
    }
  };
  // Порядок как у Telegram: комментарий (кусками) → файлы с подписью → остаток текста (кусками).
  for (const c of plan.comment) await sendText(c, []);
  if (files.length > 0) await sendText(plan.caption, files);
  for (const part of plan.tail) await sendText(part, []);
}

/** Всем по очереди; результат на каждое место (сбой одного не мешает остальным). */
export async function sendShareTo(targets: readonly ShareTarget[], p: SharePayload): Promise<ShareResult[]> {
  const out: ShareResult[] = [];
  /* Длинный текст (09.10, как у Telegram): сверх предела сообщения режется на несколько (`splitLongText`), подпись не
     режется. Раскладка одна на все места; сверх 8 пределов — отказ каждому месту словами, ничего не уходит. */
  const plan = sharePlan(p.text, p.comment, p.files.length > 0);
  if (!plan.ok) return targets.map((target) => ({ target, ok: false, error: new Error(plan.error) }));
  for (const target of targets) {
    try {
      await sendOne(target, p.files, plan);
      out.push({ target, ok: true });
    } catch (error) {
      out.push({ target, ok: false, error });
    }
  }
  return out;
}
