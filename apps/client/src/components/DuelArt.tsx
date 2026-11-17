import { useEffect, useState } from 'react';
import { DIE_FACE_ROT, PIP_CELLS, type DuelSide } from '../duelRules';
import { Avatar } from './Avatar';

type DuelistArt = { goose: string; sash: string };
let duelistArt: DuelistArt | null = null;
let duelistLoad: Promise<DuelistArt | null> | null = null;
function useDuelistArt(): DuelistArt | null {
  const [url, setUrl] = useState(duelistArt);
  useEffect(() => {
    if (url) return;
    let alive = true;
    duelistLoad ??= Promise.all([import('../assets/duel/duelist.png'), import('../assets/duel/duelist-sash.png')]).then(
      ([g, s]) => (duelistArt = { goose: g.default, sash: s.default }),
      () => null,
    );
    void duelistLoad.then((u) => {
      if (alive && u) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return url;
}

export function Duelist({
  side,
  who,
  phone,
  mine,
  won,
  lost,
}: {
  side: DuelSide;
  who: { name: string; avatar: string | null };
  phone: boolean;
  mine: boolean;
  won: boolean;
  lost: boolean;
}) {
  const art = useDuelistArt();
  return (
    <span className={`dc-figure ${side}${mine ? ' me' : ''}${won ? ' won' : ''}${lost ? ' lost' : ''}`}>
      <span className="dc-goose" aria-hidden="true">
        {art && <img src={art.goose} alt="" draggable={false} />}
        {art && side === 'target' && <img className="dc-sash" src={art.sash} alt="" draggable={false} />}
      </span>
      <span className="dc-badge">
        <Avatar url={who.avatar} name={who.name} size={phone ? 28 : 36} />
      </span>
    </span>
  );
}

export function Die({ v, rolling, stale }: { v: number | null; rolling: boolean; stale?: boolean }) {
  return (
    <span className={`dc-die${v === null ? ' unknown' : ''}${stale ? ' stale' : ''}`} aria-hidden="true">
      <span className={`dc-tumble${rolling ? ' rolling' : ''}`}>
        <span className="dc-cube" style={{ transform: DIE_FACE_ROT[v ?? 1] }}>
          {[1, 2, 3, 4, 5, 6].map((f) => (
            <span key={f} className={`dc-face f${f}`}>
              {v !== null && PIP_CELLS[f].map((c) => <i key={c} className={`p${c}`} />)}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
