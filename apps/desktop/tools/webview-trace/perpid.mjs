import fs from 'node:fs';
const { traceEvents: ev } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pname = new Map(), plabel = new Map(), tname = new Map();
let t0 = Infinity, t1 = 0;
for (const e of ev) { if (e.ph === 'M' && e.name === 'process_name') pname.set(e.pid, e.args.name); if (e.ph === 'M' && e.name === 'process_labels') plabel.set(e.pid, e.args.labels); if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name); if (e.ts > 0) { t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts); } }
const span = (t1 - t0) / 1e6;
const names = (process.argv[3] || 'ProxyMain::BeginMainFrame,Paint,RasterTask,ProxyImpl::ScheduledActionDraw,LayerTreeHostImpl::PrepareToDraw,SubmitCompositorFrame,Scheduler::BeginFrame,Animation,UpdateLayoutTree,PaintImage,VideoFrameSubmitter::SubmitFrame,ImageDecodeTask').split(',');
const m = new Map();
for (const e of ev) { if (!names.includes(e.name) || e.ph === 'E') continue; const k = `${e.name}|${pname.get(e.pid)} ${e.pid} ${plabel.get(e.pid) || ''}|${tname.get(`${e.pid}:${e.tid}`) || ''}`; m.set(k, (m.get(k) || 0) + 1); }
for (const [k, c] of [...m].sort()) console.log((c / span).toFixed(1).padStart(7), k);
const anim = new Map();
for (const e of ev) if (e.name === 'Animation' && e.args?.data?.name !== undefined) anim.set(`${e.pid} ${e.args.data.name}`, (anim.get(`${e.pid} ${e.args.data.name}`) || 0) + 1);
console.log('animations:', [...anim].slice(0, 20));
