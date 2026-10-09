import { useCallback, useEffect, useState } from 'react';
import { isEditableTag, ownEditMenu } from '../contextMenuRules';
import { FORMAT_MENU, selectionHasFormat } from '../fieldFormat';
import { formatField, isFormatField } from '../fieldFormatDom';
import { isMobile } from '../hotkeys';
import { selectedSlice, spliceText } from '../textEdit';
import { toast } from '../toast';
import { ContextMenu, MenuDivider, MenuItem, type MenuPos } from './ContextMenu';

/**
 * Своё меню правки по правому клику в поле ввода (#75).
 *
 * Родное меню мы оставляли в полях ради «Вставить» — и вместе с ним человек получал «Импорт
 * паролей», «Отправить вкладку на свои устройства» и «Проверить». То есть ровно тот браузерный
 * мусор, ради которого меню и гасили: в поле ввода он просто был законной лазейкой.
 *
 * Даём четыре пункта, которые в поле действительно нужны, и гасим родное меню везде.
 */

type EditTarget = HTMLInputElement | HTMLTextAreaElement;

function editTargetOf(el: Element | null): EditTarget | null {
  if (!el) return null;
  const tag = el.tagName?.toLowerCase() ?? '';
  if (!isEditableTag(tag, (el as HTMLInputElement).type ?? '')) return null;
  return el as EditTarget;
}

/**
 * React держит значение поля у себя, поэтому прямая запись в `value` до него не доходит — состояние
 * и DOM разъезжаются на первом же ререндере. Пишем через нативный сеттер прототипа и шлём `input`,
 * как это делает настоящий ввод с клавиатуры.
 */
function writeBack(el: EditTarget, r: { value: string; caret: number }): void {
  setValue(el, r.value, r.caret);
}

function setValue(el: EditTarget, next: string, caret: number): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectedText(el: EditTarget): string {
  return selectedSlice(el.value, el.selectionStart, el.selectionEnd);
}

export function EditContextMenu() {
  const [menu, setMenu] = useState<{ pos: MenuPos; el: EditTarget; selection: string; level?: 'fmt' } | null>(null);

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      // Компоненты со своим меню (канал, участник, сообщение) уже погасили событие — не мешаем им.
      if (e.defaultPrevented) return;
      // Палец и телефон — системное меню над полем (правило и повод — `contextMenuRules.ownEditMenu`).
      if (!ownEditMenu((e as PointerEvent).pointerType, isMobile())) return;
      const el = editTargetOf(e.target as Element | null);
      if (!el) return;
      e.preventDefault();
      setMenu({ pos: { x: e.clientX, y: e.clientY }, el, selection: selectedText(el) });
    };
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);

  const close = useCallback(() => setMenu(null), []);

  if (!menu) return null;
  const { el, selection } = menu;

  const cut = () => {
    void navigator.clipboard?.writeText(selection).catch(() => {});
    writeBack(el, spliceText(el.value, el.selectionStart, el.selectionEnd, ''));
    el.focus();
    close();
  };

  const copy = () => {
    void navigator.clipboard?.writeText(selection).catch(() => {});
    el.focus();
    close();
  };

  const paste = () => {
    close();
    // Чтение буфера может быть недоступно (нет разрешения, не secure context). Ctrl+V работает
    // всегда — он идёт мимо страницы, поэтому в отказе честно отправляем к нему, а не молчим.
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (!text) return;
        writeBack(el, spliceText(el.value, el.selectionStart, el.selectionEnd, text));
        el.focus();
      })
      .catch(() => toast('info', 'Буфер недоступен — вставьте через Ctrl+V'));
  };

  const selectAll = () => {
    el.focus();
    el.select();
    close();
  };

  /* Подменю «Форматирование» (G20, Telegram Desktop 02·4.4) — только в поле сообщения (`data-fmt`): пункты с клавишами,
     черта, «Без форматирования» (неактивно, если снимать нечего). Пункт меню — тем же переходом уровня, что «Выключить
     уведомления» в меню беседы (`DmRowMenu`). */
  if (menu.level === 'fmt') {
    const apply = (kind: Parameters<typeof formatField>[1]) => () => {
      close();
      formatField(el, kind);
    };
    return (
      <ContextMenu key="fmt" pos={menu.pos} onClose={close} width={264}>
        {FORMAT_MENU.map((it) => (
          <MenuItem key={it.kind} label={it.label} shortcut={it.shortcut} onClick={apply(it.kind)} />
        ))}
        <MenuDivider />
        <MenuItem
          label="Без форматирования"
          shortcut="Ctrl+Shift+N"
          disabled={!selectionHasFormat(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0)}
          onClick={apply('clear')}
        />
      </ContextMenu>
    );
  }

  return (
    <ContextMenu pos={menu.pos} onClose={close} width={isFormatField(el) ? 232 : 200}>
      <MenuItem label="Вырезать" shortcut="Ctrl+X" disabled={!selection} onClick={cut} />
      <MenuItem icon="copy" label="Копировать" shortcut="Ctrl+C" disabled={!selection} onClick={copy} />
      <MenuItem label="Вставить" shortcut="Ctrl+V" onClick={paste} />
      {isFormatField(el) && (
        <MenuItem label="Форматирование" submenu disabled={!selection} onClick={() => setMenu({ ...menu, level: 'fmt' })} />
      )}
      <MenuDivider />
      <MenuItem label="Выделить всё" shortcut="Ctrl+A" onClick={selectAll} />
    </ContextMenu>
  );
}
