// Разбор трейса: процессорное время по процессам/потокам, верхние события, счётчики кадров и таймеров.
// node analyze.mjs trace.json [topN]
import fs from 'node:fs';

const file = process.argv[2];
const topN = Number(process.argv[3] || 12);
const { traceEvents: ev } = JSON.parse(fs.readFileSync(file, 'utf8'));

const pname = new Map(), tname = new Map();
for (const e of ev) {
  if (e.ph === 'M' && e.name === 'process_name') pname.set(e.pid, e.args.name);
  if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name);
}
let t0 = Infinity, t1 = 0; for (const e of ev) if (e.ts > 0) { if (e.ts < t0) t0 = e.ts; if (e.ts > t1) t1 = e.ts; }

const spanS = (t1 - t0) / 1e6;

// B/E → X
const open = new Map();
const xs = [];
for (const e of ev) {
  if (e.ph === 'X') xs.push(e);
  else if (e.ph === 'B') { const k = `${e.pid}:${e.tid}`; (open.get(k) || open.set(k, []).get(k)).push(e); }
  else if (e.ph === 'E') {
    const st = open.get(`${e.pid}:${e.tid}`); const b = st && st.pop();
    if (b) xs.push({ ...b, ph: 'X', dur: e.ts - b.ts, tdur: e.tts != null && b.tts != null ? e.tts - b.tts : undefined });
  }
}
// верхний уровень по потокам
const byThread = new Map();
for (const e of xs) { const k = `${e.pid}:${e.tid}`; (byThread.get(k) || byThread.set(k, []).get(k)).push(e); }
const rows = [];
for (const [k, list] of byThread) {
  list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  let end = -1; let cpu = 0; let wall = 0; const names = new Map();
  for (const e of list) {
    if (e.ts < end) continue;
    end = e.ts + (e.dur || 0);
    const c = (e.tdur ?? e.dur ?? 0);
    cpu += c; wall += e.dur || 0;
    names.set(e.name, (names.get(e.name) || 0) + c);
  }
  const [pid] = k.split(':');
  rows.push({ proc: pname.get(Number(pid)) || pid, pid, thread: tname.get(k) || k, cpuMs: cpu / 1000, wallMs: wall / 1000, names });
}
rows.sort((a, b) => b.cpuMs - a.cpuMs);
console.log(`span ${spanS.toFixed(1)} s, events ${ev.length}`);
const perProc = new Map();
for (const r of rows) perProc.set(`${r.proc} [${r.pid}]`, (perProc.get(`${r.proc} [${r.pid}]`) || 0) + r.cpuMs);
console.log('\n== CPU по процессам (мс процессора в секунду = доля ядра ×1000) ==');
for (const [p, ms] of [...perProc].sort((a, b) => b[1] - a[1])) console.log(`${(ms / spanS).toFixed(1).padStart(7)} ms/s  ${p}`);
console.log('\n== потоки ==');
for (const r of rows.slice(0, 20)) {
  const top = [...r.names].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ${(c / 1000 / spanS).toFixed(1)}`).join(', ');
  console.log(`${(r.cpuMs / spanS).toFixed(1).padStart(7)} ms/s  ${r.proc}/${r.thread}: ${top}`);
}
// счётчики
const count = (pred) => xs.filter(pred).length + ev.filter((e) => (e.ph === 'I' || e.ph === 'i' || e.ph === 'n') && pred(e)).length;
const perS = (n) => (n / spanS).toFixed(1);
console.log('\n== частоты (в секунду) ==');
for (const n of ['BeginMainFrame', 'ThreadProxy::BeginMainFrame', 'ProxyMain::BeginMainFrame', 'Commit', 'Paint', 'UpdateLayoutTree', 'Layout', 'Display::DrawAndSwap', 'DisplayScheduler::DrawAndSwap', 'Graphics.Pipeline', 'FireAnimationFrame', 'TimerFire', 'FunctionCall', 'EventDispatch', 'Animation', 'VideoFrameCompositor::UpdateCurrentFrame', 'WebMediaPlayerImpl::OnFrame', 'HitTest', 'RasterTask', 'ScheduleStyleRecalculation', 'InvalidateLayout', 'PaintImage', 'Decode Image']) {
  const c = count((e) => e.name === n);
  if (c) console.log(`${perS(c).padStart(7)}  ${n}`);
}
// JS: кто вызывается (FunctionCall/TimerFire/FireAnimationFrame/EventDispatch)
const js = new Map();
for (const e of xs) {
  if (!['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'v8.callFunction', 'RunMicrotasks'].includes(e.name)) continue;
  const d = e.args?.data || {};
  const key = `${e.name} ${d.functionName || ''} ${d.url ? d.url.split('/').pop() : ''}:${d.lineNumber ?? ''} ${d.type || ''} ${d.timerId ? 't' : ''}`.trim();
  const v = js.get(key) || { n: 0, ms: 0 };
  v.n++; v.ms += (e.tdur ?? e.dur ?? 0) / 1000; js.set(key, v);
}
console.log('\n== JS на главном потоке (вызовов/с, мс/с) ==');
for (const [k, v] of [...js].sort((a, b) => b[1].ms - a[1].ms).slice(0, topN * 2)) console.log(`${perS(v.n).padStart(7)} /s ${(v.ms / spanS).toFixed(2).padStart(7)} ms/s  ${k}`);
// инвалидации стилей: что их запускает
const inv = new Map();
for (const e of ev) {
  if (!['ScheduleStyleInvalidationTracking', 'StyleRecalcInvalidationTracking', 'ScheduleStyleRecalculation', 'InvalidateLayout', 'PaintInvalidationTracking'].includes(e.name)) continue;
  const d = e.args?.data || {};
  const k = `${e.name} ${d.reason || ''} ${d.nodeName || ''}`.trim();
  inv.set(k, (inv.get(k) || 0) + 1);
}
if (inv.size) { console.log('\n== инвалидации ==');
  for (const [k, c] of [...inv].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log(`${perS(c).padStart(7)} /s  ${k}`); }
