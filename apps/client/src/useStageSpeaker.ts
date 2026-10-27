import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { nextStageSpeaker, stageSpeakerRecheckMs, type StageSpeaker } from './stageLayoutRules';

/**
 * Крупный говорящий для вида сцены «Говорящий» (#221, 16.10). Признак «говорит» — тот же, что у зелёной обводки
 * плитки (`liveVoice[identity].speaking`, клиентский VAD по уровню, `VoiceParticipants.tsx`), поэтому крупно
 * выходит ровно тот, у кого горит обводка. Смена — по `nextStageSpeaker` (гистерезис `STAGE_SPEAKER_HOLD_MS`,
 * минимум речи `STAGE_SPEAKER_MIN_TALK_MS`); отложенную смену дожимает таймер (`stageSpeakerRecheckMs`): человек
 * просто продолжает говорить, и новых событий может не прийти.
 *
 * `present` — кто на сцене, БЕЗ меня (себя крупно не выводим). `enabled` — выключено: ничего не считаем, `null`.
 * `bots` — боты (#232): крупно сами не выходят (ни говорящим, ни запасом «первый на сцене»).
 */
export function useStageSpeaker(presentAll: readonly string[], enabled: boolean, bots?: ReadonlySet<string>): string | null {
  // Боты (#232) на сцене «крупно» не участвуют вовсе: ни говорящим, ни запасом «первый на сцене».
  const present = bots && bots.size > 0 ? presentAll.filter((id) => !bots.has(id)) : presentAll;
  // Строка, а не объект: селектор стора сравнивается по значению, иначе перерисовка на каждый кадр уровня.
  const speakingKey = useStore((s) => {
    if (!enabled) return '';
    const ids: string[] = [];
    for (const id of present) if (s.liveVoice[id]?.speaking) ids.push(id);
    return ids.join(',');
  });
  const presentKey = present.join(',');
  const sinceRef = useRef(new Map<string, number>());
  const stateRef = useRef<StageSpeaker>({ id: null, at: 0 });
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      sinceRef.current.clear();
      stateRef.current = { id: null, at: 0 };
      setSpeaker(null);
      return;
    }
    const now = Date.now();
    const speaking = new Set(speakingKey ? speakingKey.split(',') : []);
    const since = sinceRef.current;
    for (const id of [...since.keys()]) if (!speaking.has(id)) since.delete(id);
    for (const id of speaking) if (!since.has(id)) since.set(id, now);
    const inp = {
      speakingSince: since,
      present: presentKey ? presentKey.split(',') : [],
      now,
    };
    const next = nextStageSpeaker(stateRef.current, inp);
    stateRef.current = next;
    setSpeaker(next.id);
    const wait = stageSpeakerRecheckMs(next, inp);
    if (wait === null) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), wait + 20);
    return () => window.clearTimeout(t);
  }, [enabled, speakingKey, presentKey, tick]);

  if (!enabled) return null;
  // Состояние догоняет на эффекте (кадр спустя): ушедшего уже нет на сцене, а первый кадр без крупного
  // мигнул бы сеткой — подставляем запас сразу.
  return speaker && present.includes(speaker) ? speaker : (present[0] ?? null);
}
