// RunTask по месту постановки (src_func) и по первому дочернему событию, для заданного процесса/потока
import fs from 'node:fs';
const [file, procSub, threadSub] = process.argv.slice(2);
const { traceEvents: ev } = JSON.parse(fs.readFileSync(file, 'utf8'));
const pname = new Map(), tname = new Map(); let t0 = Infinity, t1 = 0;
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') pname.set(e.pid, e.args.name); if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name); if (e.ts > 0) { t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts); } }
const span = (t1 - t0) / 1e6;
const sel = ev.filter((e) => e.ph === 'X' && (pname.get(e.pid) || '').includes(procSub) && (tname.get(`${e.pid}:${e.tid}`) || '') === threadSub);
// кандидаты на PID: берём тот, где больше всего событий
const byPid = new Map(); for (const e of sel) byPid.set(e.pid, (byPid.get(e.pid) || 0) + 1);
const pid = [...byPid].sort((a, b) => b[1] - a[1])[0]?.[0];
const list = sel.filter((e) => e.pid === pid).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const agg = new Map(), child = new Map();
let i = 0;
while (i < list.length) {
  const top = list[i]; const end = top.ts + top.dur; const c = (top.tdur ?? top.dur) / 1000;
  const k = `${top.args?.src_func || top.name} @ ${(top.args?.src_file || '').split(/[\/]/).slice(-2).join('/')}`;
  const v = agg.get(k) || { n: 0, ms: 0 }; v.n++; v.ms += c; agg.set(k, v);
  let j = i + 1; const seen = new Set();
  while (j < list.length && list[j].ts < end) { const e = list[j]; if (!seen.has(e.name) && e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask') { seen.add(e.name); const d = e.args?.data; const kk = e.name + (d?.url ? ' ' + d.url.split('/').pop().slice(0, 40) : '') + (d?.functionName ? ' ' + d.functionName : ''); const w = child.get(kk) || { n: 0, ms: 0 }; w.n++; w.ms += (e.tdur ?? e.dur) / 1000; child.set(kk, w); } j++; }
  i = j;
}
console.log(`pid ${pid} ${procSub}/${threadSub}, span ${span.toFixed(1)}s`);
console.log('-- по месту постановки задачи --');
for (const [k, v] of [...agg].sort((a, b) => b[1].ms - a[1].ms).slice(0, 18)) console.log(`${(v.ms / span).toFixed(1).padStart(6)} ms/s ${(v.n / span).toFixed(0).padStart(5)}/s  ${k}`);
console.log('-- вложенные события (первое вхождение в задаче) --');
for (const [k, v] of [...child].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)) console.log(`${(v.ms / span).toFixed(1).padStart(6)} ms/s ${(v.n / span).toFixed(0).padStart(5)}/s  ${k}`);
