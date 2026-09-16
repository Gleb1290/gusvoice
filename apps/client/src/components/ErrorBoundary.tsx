import { Component, type ErrorInfo, type ReactNode } from 'react';
import { crashText, describeCrash, saveCrash, type CrashReport } from '../crashReport';
import { Icon } from './Icon';

/**
 * Граница ошибок (05.09).
 *
 * 🔴 **Чего не было и чем это кончалось.** До сегодняшнего дня границы не было НИ ОДНОЙ. Исключение
 * при отрисовке любого компонента сносило всё дерево React разом: у человека оставался голый фон,
 * вместе с `VoiceConnection` рвалось соединение с голосом — и ни строчки объяснения. Со стороны это
 * неотличимо от зависшего приложения, и именно так про это и рассказывают: «осталcя только фон и
 * меня выкинуло из канала».
 *
 * 🔴 **Класс, а не хук.** Ловить ошибки отрисовки умеют только классовые компоненты: хука с такой
 * возможностью в React нет. Это единственная причина, по которой файл выглядит иначе остальных.
 *
 * 🔴 **Восстановление — ПЕРЕЗАГРУЗКА окна, а не «попробовать ещё».** Сброс состояния границы
 * отрисовал бы то же самое дерево с теми же данными, то есть бросил бы снова — и человек получил бы
 * кнопку, которая делает вид, что что-то чинит. Перезагрузка поднимает приложение с нуля и работает.
 *
 * ⚠️ **Ошибку сохраняем ДО показа.** Первое, что делают на этом экране, — жмут «Перезагрузить», и
 * вместе со страницей исчезает единственный экземпляр стека. Запись переживает перезагрузку и
 * достаётся из `gv_last_crash`.
 *
 * ⚠️ Граница НЕ ловит: ошибки в обработчиках событий, в асинхронном коде и в таймерах — React их не
 * перехватывает по устройству. Она про отрисовку, и лечит она именно молчаливый чёрный экран.
 */

interface Props {
  children: ReactNode;
  /**
   * Не показывать экран ошибки, отрисовать пустоту.
   *
   * 🔴 Для окон оверлея и всплывающей плашки: они висят ПОВЕРХ чужой игры. Красная карточка с
   * трассировкой посреди боя хуже, чем пропавший виджет. Ошибка при этом всё равно записывается —
   * молчит только картинка, не журнал.
   */
  silent?: boolean;
}

interface State {
  crash: CrashReport | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crash: null, copied: false };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    // Стека компонентов здесь ещё нет — он приезжает в componentDidCatch, вторым проходом.
    return { crash: describeCrash(err, null, Date.now(), navigator.userAgent), copied: false };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    const crash = describeCrash(err, info.componentStack, Date.now(), navigator.userAgent);
    // ⚠️ Сначала в журнал: в вебе это единственный способ увидеть аварию с открытой консолью, а в
    // десктопе консоль поднимается только у меня.
    console.error('[crash] интерфейс упал', err, info.componentStack);
    saveCrash(safeStorage(), crash);
    this.setState({ crash });
  }

  private copy = () => {
    const { crash } = this.state;
    if (!crash) return;
    // Буфер может быть недоступен (нет разрешения, не защищённый контекст) — тогда просто ничего не
    // обещаем человеку: текст виден на экране и выделяется мышью.
    void navigator.clipboard
      ?.writeText(crashText(crash))
      .then(() => this.setState({ copied: true }))
      .catch(() => {});
  };

  render() {
    const { crash } = this.state;
    if (!crash) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="gv-crash">
        <div className="gv-crash-card">
          <div className="gv-crash-title">
            <Icon name="bolt" size={20} /> Что-то сломалось в интерфейсе
          </div>
          <div className="gv-crash-text">
            Приложение не смогло отрисовать экран и остановилось здесь, чтобы не оставить вас перед
            пустым окном. Голос при этом отключился — он вернётся после перезагрузки.
          </div>
          <div className="gv-crash-msg">{crash.message}</div>
          {/* Стек — под спойлером: он нужен мне, а человеку сразу в лицо не нужен. */}
          <details className="gv-crash-more">
            <summary>Подробности для разработчика</summary>
            <pre>{crashText(crash)}</pre>
          </details>
          <div className="gv-crash-actions">
            <button type="button" className="gv-crash-btn primary" onClick={() => location.reload()}>
              Перезагрузить
            </button>
            <button type="button" className="gv-crash-btn" onClick={this.copy}>
              {this.state.copied ? 'Скопировано' : 'Скопировать отчёт'}
            </button>
          </div>
          {/* Прямо говорим, что текст не потеряется: иначе человек боится нажать «Перезагрузить». */}
          <div className="gv-crash-hint">
            Отчёт сохранён и переживёт перезагрузку — его можно скопировать и позже.
          </div>
        </div>
      </div>
    );
  }
}

/** `localStorage` может бросать на самом обращении (выключены данные сайта) — не только на записи. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
