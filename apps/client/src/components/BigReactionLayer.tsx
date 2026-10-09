import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { BIG_EFFECT_MS, shouldPlayBigEffect } from '../bigReaction';
import { onEffect } from '../effectsBus';
import { reducedMotion } from '../effectsDom';
import { liteModeEnabled } from '../liteMode';
import { useStore } from '../store';

/**
 * Крупная анимация «большой» реакции (08.10, `bigreact1`, G43; Telegram `ReactionsEffectOverlay.LONG_ANIMATION`): эмодзи
 * вырастает над сообщением, держится и уходит вниз к пузырю, вокруг разлетаются шесть маленьких копий. Слушает общую шину
 * эффектов (`effectsBus`, вид `bigReaction`) — и свою реакцию по удержанию, и чужую по `reaction.big`.
 *
 * Играет, только если беседа открыта и сообщение пересекает видимую часть ленты (`.messages [data-mid]`), вкладка видна, нет
 * `prefers-reduced-motion` и лёгкого режима (`shouldPlayBigEffect`). Реакция при этом ставится всё равно — слой лишь украшение.
 * Слой `pointer-events: none` и ниже меню (`z-index` < `.ctx-stack`).
 */
type Shot = { key: number; emoji: string; x: number; y: number; size: number };

const PARTICLES = [0, 60, 120, 180, 240, 300];

/**
 * Пузырь сообщения (`.bubble`; без пузырей — сама строка) в ленте: его видимая часть и прямоугольник ленты. Нет узла или он
 * целиком за краем ленты — `null`.
 */
function messageBox(messageId: string): { box: DOMRect; feed: DOMRect } | null {
  const row = document.querySelector(`.messages [data-mid="${CSS.escape(messageId)}"]`);
  if (!row) return null;
  const el = row.querySelector('.bubble') ?? row;
  const r = el.getBoundingClientRect();
  const feed = row.closest('.messages')?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const top = Math.max(r.top, feed.top, 0);
  const bottom = Math.min(r.bottom, feed.bottom, window.innerHeight);
  if (bottom <= top || r.width === 0) return null;
  return { box: new DOMRect(r.left, top, r.width, bottom - top), feed };
}

/** Центр по оси: у середины пузыря, но так, чтобы эмодзи целиком лёг в ленту (если она достаточно велика). */
function clampIn(v: number, from: number, to: number, half: number): number {
  if (to - from < half * 2) return (from + to) / 2;
  return Math.min(Math.max(v, from + half), to - half);
}

let seq = 0;

export function BigReactionLayer() {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(
    () =>
      onEffect((req) => {
        if (req.kind !== 'bigReaction') return;
        const at = messageBox(req.messageId);
        const play = shouldPlayBigEffect({
          tabHidden: document.visibilityState === 'hidden',
          reducedMotion: reducedMotion(),
          lite: liteModeEnabled(),
          convOpen: useStore.getState().currentDmId === req.conversationId,
          onScreen: at !== null,
        });
        if (!play || !at) return;
        const { box, feed } = at;
        // Размер — от ширины окна: на телефоне 412 px эмодзи ~150 px, на ПК не больше 200 (у Telegram эффект ~ полэкрана).
        const size = Math.round(Math.min(200, Math.max(120, window.innerWidth * 0.36)));
        const x = clampIn(box.left + box.width / 2, feed.left, feed.right, size / 2);
        const y = clampIn(box.top + box.height / 2, feed.top, feed.bottom, size / 2);
        const shot: Shot = { key: ++seq, emoji: req.emoji, x, y, size };
        setShots((list) => [...list.slice(-2), shot]);
        window.setTimeout(() => setShots((list) => list.filter((s) => s.key !== shot.key)), BIG_EFFECT_MS + 50);
      }),
    [],
  );
  if (shots.length === 0) return null;
  return (
    <div className="big-react-layer" aria-hidden="true">
      {shots.map((s) => (
        <div
          key={s.key}
          className="big-react"
          style={{ left: s.x, top: s.y, '--big-size': `${s.size}px`, '--big-ms': `${BIG_EFFECT_MS}ms` } as CSSProperties}
        >
          {PARTICLES.map((deg) => (
            <span key={deg} className="big-react-dot" style={{ '--big-deg': `${deg}deg` } as CSSProperties}>
              {s.emoji}
            </span>
          ))}
          <span className="big-react-emoji">{s.emoji}</span>
        </div>
      ))}
    </div>
  );
}
