import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import type { ShareTarget, SharePayload, ShareResult } from './shareSend';
import * as longText from './longTextRules';

const source = readFileSync(new URL('./shareSend.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
type Mode = 'conv' | 'channel';
const files = [{ name: 'one.bin' }, { name: 'two.bin' }] as File[];
async function send(mode: Mode, payload: SharePayload, raw = source, ids = ['destination'], failAt?: { id: string; piece: number }) {
  const calls: Array<{ step: string; id: string; content?: string; files?: unknown[] }> = [];
  const attempted: Array<{ id: string; content: string; piece: number }> = [];
  const pieces=new Map<string,number>();let planCalls=0;
  const beforeSend=(id:string,content:string)=>{
    const piece=(pieces.get(id)??0)+1;pieces.set(id,piece);attempted.push({id,content,piece});
    if((failAt&&id===failAt.id&&piece===failAt.piece)||(!failAt&&id==='bad'))throw new Error('отказ первого места');
  };
  let serial = 0;
  const api = {
    convUpload: async (id: string, f: File) => { calls.push({ step: 'conv-upload', id, content: f.name }); return { id: f.name }; },
    uploadAttachment: async (id: string, f: File) => { calls.push({ step: 'channel-upload', id, content: f.name }); return { url: f.name }; },
    convSend: async (id: string, input: { content: string; attachments: unknown[] }) => {
      beforeSend(id,input.content);
      calls.push({ step: 'conv-send', id, content: input.content, files: [...input.attachments] }); return { id: `msg-${++serial}` };
    },
    sendMessage: async (id: string, content: string, atts?: unknown[]) => {
      beforeSend(id,content);
      calls.push({ step: 'channel-send', id, content, files: atts }); return { id: `msg-${++serial}` };
    },
  };
  const state = { convActive: true,
    appendMessage: (id: string) => calls.push({ step: 'channel-append', id }),
    convAfterSend: (id: string) => calls.push({ step: 'conv-append', id }) };
  const deps: Record<string, unknown> = { './api': { api }, './store': { useStore: { getState: () => state } },
    './clientId': { newClientId: () => `client-${serial}` }, './convStore': { toOutboxRef: (a: { id: string }) => ({ id: a.id }) },
    './longTextRules': { ...longText, sharePlan: (...args: Parameters<typeof longText.sharePlan>) => { planCalls++; return longText.sharePlan(...args); } } };
  const module = { exports: {} };
  // Настоящий полный модуль и все внешние побочные эффекты через явные зависимости, не извлечённый sendOne.
  runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (id: string) => { assert.ok(id in deps); return deps[id]; } });
  const targets: ShareTarget[] = ids.map(id => ({ id, kind: mode === 'channel' ? 'channel' : 'conv' }));
  const result = await (module.exports as { sendShareTo(t: ShareTarget[], p: SharePayload): Promise<ShareResult[]> }).sendShareTo(targets, payload);
  return { calls, result, targets, attempted, planCalls };
}
for (const [mode, prefix] of [['conv', 'conv'], ['channel', 'channel']] as const) {
  it(`R128 ${mode}: комментарий отправляется раньше загрузки файлов и подписи правильным API`, async () => {
    const h = await send(mode, { comment: 'комментарий', text: 'подпись', files });
    assert.deepEqual(h.calls.map(c => c.step), [`${prefix}-send`, `${prefix}-append`, `${prefix}-upload`, `${prefix}-upload`, `${prefix}-send`, `${prefix}-append`]);
    const sent = h.calls.filter(c => c.step === `${prefix}-send`);
    assert.equal(sent[0].content, 'комментарий'); assert.equal(sent[1].content, 'подпись'); assert.equal(sent[1].files?.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(sent[1].files)), mode === 'conv' ? [{ id: 'one.bin' }, { id: 'two.bin' }] : [{ url: 'one.bin' }, { url: 'two.bin' }]);
    assert.equal(h.result.length, 1); assert.equal(h.result[0].ok, true); assert.equal(h.result[0].target, h.targets[0]);
  });
}
it('R128 без файлов принятый текст уходит одним сообщением в обоих живых путях', async () => {
  for (const mode of ['conv', 'channel'] as const) {
    const h = await send(mode, { comment: '', text: 'текст', files: [] });
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0].content, 'текст'); assert.equal(h.result[0].ok, true);
  }
});
it('R128 без принятого текста и файлов отправляется только комментарий, пустые места безопасны', async () => {
  for (const mode of ['conv', 'channel'] as const) {
    const h = await send(mode, { comment: 'комментарий', text: '', files: [] });
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0].content, 'комментарий');
    assert.equal((await send(mode, { comment: '', text: '', files: [] })).calls.length, 0);
  }
  assert.equal((await send('conv', { comment: 'x', text: 'y', files }, source, [])).result.length, 0);
});
it('R128 отказ первого места не мешает следующим, каждому возвращается свой результат', async () => {
  const h = await send('conv', { comment: 'комментарий', text: 'текст', files: [] }, source, ['bad', 'next', 'last']);
  assert.deepEqual(Array.from(h.result, r => r.ok), [false, true, true]);
  assert.equal((h.result[0].error as Error).message, 'отказ первого места');
  assert.deepEqual(h.calls.filter(c => c.step === 'conv-send').map(c => c.id), ['next', 'next', 'last', 'last']);
});
it('R128 контрфакты позднего комментария, break после отказа и пропущенного текста краснеют', async () => {
  const comment = '  for (const c of plan.comment) await sendText(c, []);\n';
  assert.ok(source.includes(comment));
  const tail = '  for (const part of plan.tail) await sendText(part, []);';
  assert.ok(source.includes(tail));
  const late = source.replace(comment, '').replace(tail, `${tail}\n${comment}`);
  const checkOrder = async (raw: string) => {
    const h = await send('conv', { comment: 'комментарий', text: 'подпись', files }, raw);
    assert.equal(h.calls[0].content, 'комментарий');
  };
  await checkOrder(source); await assert.rejects(checkOrder(late), assert.AssertionError);
  const broken = source.replace('out.push({ target, ok: false, error });', 'out.push({ target, ok: false, error }); break;');
  assert.notEqual(broken, source);
  const checkPlaces = async (raw: string) => assert.equal((await send('conv', { comment: '', text: 'x', files: [] }, raw, ['bad', 'next'])).result.length, 2);
  await checkPlaces(source); await assert.rejects(checkPlaces(broken), assert.AssertionError);
  const skipped = source.replace(tail, '');
  assert.notEqual(skipped, source);
  const checkText = async (raw: string) => assert.equal((await send('channel', { comment: '', text: 'x', files: [] }, raw)).calls.length, 2);
  await checkText(source); await assert.rejects(checkText(skipped), assert.AssertionError);
});

const textThree='a'.repeat(longText.MESSAGE_TEXT_MAX)+'b'.repeat(longText.MESSAGE_TEXT_MAX)+'c';
const commentTwo='x'.repeat(longText.MESSAGE_TEXT_MAX)+'y';
async function longOrder(mode:Mode,raw=source){
  const prefix=mode;
  const h=await send(mode,{comment:commentTwo,text:textThree,files},raw);
  const steps=[...Array(2).fill([`${prefix}-send`,`${prefix}-append`]).flat(),`${prefix}-upload`,`${prefix}-upload`,
    ...Array(4).fill([`${prefix}-send`,`${prefix}-append`]).flat()];
  assert.deepEqual(h.calls.map(c=>c.step),steps,'порядок: комментарий, файлы один раз, затем хвост текста');
  const sent=h.calls.filter(c=>c.step===`${prefix}-send`);
  assert.deepEqual(sent.map(c=>c.content),['x'.repeat(4096),'y','','a'.repeat(4096),'b'.repeat(4096),'c']);
  assert.deepEqual(sent.map(c=>c.files?.length),[0,0,2,0,0,0],'файлы только у единственного сообщения вложений');
  assert.equal(h.planCalls,1,'раскладка вычислена один раз');assert.equal(h.result[0]!.ok,true);
}
for(const mode of ['conv','channel']as const){
  it(`R132 ${mode}: куски комментария идут до файлов без длинной подписи и трёх кусков текста`,async()=>{
    // Длинная подпись переносится в сообщения, а файл загружается только один раз на место.
    await longOrder(mode);
  });
}
it('R132 три куска уходят в каждое из двух мест по порядку, раскладка общая',async()=>{
  // Расчёт внутри цикла мест мог дать разные разрезы одного и того же принятого текста.
  for(const mode of ['conv','channel']as const){
    const h=await send(mode,{text:textThree,comment:'',files:[]},source,['first','second']);
    assert.equal(h.planCalls,1,'одна раскладка на все места');
    assert.deepEqual(h.attempted.map(c=>[c.id,c.content]),['first','second'].flatMap(id=>[[id,'a'.repeat(4096)],[id,'b'.repeat(4096)],[id,'c']]));
    assert.deepEqual(Array.from(h.result,r=>r.ok),[true,true]);
  }
});
async function interrupted(raw=source){
  for(const mode of ['conv','channel']as const){
    const h=await send(mode,{text:textThree,comment:'',files:[]},raw,['first','second'],{id:'first',piece:2});
    assert.deepEqual(h.attempted.map(c=>[c.id,c.piece]),[['first',1],['first',2],['second',1],['second',2],['second',3]],'отказ останавливает только первое место');
    assert.deepEqual(Array.from(h.result,r=>r.ok),[false,true]);
    assert.equal((h.result[0]!.error as Error).message,'отказ первого места');
  }
}
it('R132 отказ второго куска прекращает первое место, следующее получает все три',async()=>{
  // Продолжение после ошибки дало бы дырявый текст; глобальный break оставил бы остальных без сообщения.
  await interrupted();
});
async function tooLong(raw=source){
  const over='z'.repeat(longText.SPLIT_TEXT_MAX+1);
  for(const mode of ['conv','channel']as const)for(const payload of [
    {text:over,comment:'',files},{text:'подпись',comment:over,files},
  ]){
    const h=await send(mode,payload,raw,['first','second']);
    assert.deepEqual(h.calls,[],'при отказе длины API не вызывается вообще');
    assert.deepEqual(h.attempted,[]);assert.equal(h.planCalls,1);
    assert.deepEqual(Array.from(h.result,r=>r.ok),[false,false]);
    for(const r of h.result)assert.equal((r.error as Error).message,longText.tooLongText(1));
  }
}
it('R132 сверх восьми пределов текста или комментария все места получают отказ без API',async()=>{
  // Загрузка файлов перед проверкой длины расходовала бы квоту даже для отвергнутого сообщения.
  await tooLong();
});
it('R132 мутанты повторных файлов, позднего комментария, общего break и отправки при отказе краснеют',async()=>{
  // Контрфакты исполняют полный sendShareTo с настоящим sharePlan, не заменяя бизнес-правила фикстурой.
  await longOrder('conv');await interrupted();await tooLong();
  const tail='  for (const part of plan.tail) await sendText(part, []);';assert.ok(source.includes(tail));
  const fileSend='  if (files.length > 0) await sendText(plan.caption, files);';assert.ok(source.includes(fileSend));
  const earlyTail=source.replace(tail,'').replace(fileSend,`${tail}\n${fileSend}`);
  await assert.rejects(longOrder('conv',earlyTail),/комментарий, файлы один раз/);
  await assert.rejects(longOrder('conv',source.replace(tail,'  for (const part of plan.tail) await sendText(part, files);')),/комментарий, файлы один раз/);
  const comment='  for (const c of plan.comment) await sendText(c, []);\n';assert.ok(source.includes(comment));
  await assert.rejects(longOrder('conv',source.replace(comment,'').replace(tail,`${tail}\n${comment}`)),assert.AssertionError);
  const broken=source.replace('out.push({ target, ok: false, error });','out.push({ target, ok: false, error }); break;');assert.notEqual(broken,source);
  await assert.rejects(interrupted(broken),/останавливает только первое место/);
  const refusal='  if (!plan.ok) return targets.map((target) => ({ target, ok: false, error: new Error(plan.error) }));';assert.ok(source.includes(refusal));
  const leaked=source.replace(refusal,'  if (!plan.ok) { await api.convSend(targets[0].id, { content: p.text, attachments: [] }); return targets.map((target) => ({ target, ok: false, error: new Error(plan.error) })); }');
  await assert.rejects(tooLong(leaked),/API не вызывается вообще/);
});
