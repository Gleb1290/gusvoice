import { useEffect, useState } from 'react';
import { occupancyText, occupiedNow, type Occupancy } from '../occupancy';

/**
 * Сколько канал уже занят — подпись у названия канала.
 *
 * 🔴 **ОТДЕЛЬНЫЙ компонент со своим таймером, а не тик в сайдбаре.** Тик, положенный в
 * `ChannelSidebar`, перерисовывал бы каждую секунду весь список каналов со всеми участниками и
 * аватарками. Здесь перерисовывается только эта надпись.
 *
 * ⚠️ Оговорка честности: сайдбар и так перерисовывается целиком на каждое изменение зелёных
 * обводок (`liveVoice` читается им объектом), а в живом разговоре это чаще раза в секунду. То есть
 * секундный тик сам по себе ничего бы не сломал — но платить лишним рендером всего списка за
 * надпись из шести символов незачем, тем более что она идёт и когда никто не говорит.
 *
 * ⚠️ Досчитываем ОТ ЯКОРЯ (`performance.now()`), а не складываем тики: в фоновой вкладке браузер
 * душит таймеры, и сумма тиков отстала бы от настоящего времени. Вернулся человек через час —
 * увидит плюс час, а не плюс сколько успело тикнуть.
 */
export function ChannelTimer({ occupancy }: { occupancy: Occupancy }) {
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ms = occupiedNow(occupancy, performance.now());
  return (
    <span className="ch-timer" title="Канал занят" aria-label={`Канал занят ${occupancyText(ms)}`}>
      {occupancyText(ms)}
    </span>
  );
}
