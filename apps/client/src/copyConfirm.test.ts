import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

function fixture(userAgent:string){
  const calls: unknown[][]=[];const module={exports:{}};
  const code=ts.transpileModule(readFileSync(new URL('./copyConfirm.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(code,{module,exports:module.exports,navigator:{userAgent},require:(id:string)=>{assert.equal(id,'./toast');return{toast:(...args:unknown[])=>calls.push(args)};}});
  return{api:module.exports as typeof import('./copyConfirm'),calls};
}
it('системное подтверждение есть с Android 13, но не у урезанного Chrome Android 10',()=>{
  // Урезанный UA нельзя принимать за фактическую новую версию и лишать человека подтверждения.
  const {api}=fixture('');
  for(const [ua,expected] of [['Android 15; SM-S938B',true],['Android 13',true],['Android 12',false],['Android 10; K',false],['Windows NT 10.0',false],['',false]] as const)assert.equal(api.systemConfirmsCopy(ua),expected);
});
it('наш тост не дублирует системный, но остаётся на старом Android и ПК',()=>{
  // Две плашки поверх поля мешают следующему вводу.
  for(const ua of ['Android 15; SM-S938B','Android 12','Android 10; K','Windows']){const f=fixture(ua);f.api.toastCopied('Скопировано');assert.deepEqual(f.calls,ua.startsWith('Android 15')?[]:[['success','Скопировано']]);}
});
