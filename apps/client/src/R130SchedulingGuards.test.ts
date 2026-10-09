import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { quickOptions } from './schedRules';

const schedSource=readFileSync(new URL('./components/SchedPick.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const folderSource=readFileSync(new URL('./components/DmFolderBar.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function parsed(source:string){return ts.createSourceFile('guard.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function nodes<T extends ts.Node>(root:ts.Node,guard:(node:ts.Node)=>node is T):T[]{const result:T[]=[];const visit=(node:ts.Node)=>{if(guard(node))result.push(node);ts.forEachChild(node,visit);};visit(root);return result;}
function component(source:string){const sf=parsed(source);const pick=sf.statements.find((s):s is ts.FunctionDeclaration=>ts.isFunctionDeclaration(s)&&s.name?.text==='SchedPick');assert.ok(pick);assert.ok(pick.body);return {sf,pick};}
function attr(node:ts.JsxOpeningElement|ts.JsxSelfClosingElement,name:string){return node.attributes.properties.find((a):a is ts.JsxAttribute=>ts.isJsxAttribute(a)&&a.name.getText()===name);}
function variable(root:ts.Node,name:string){const declarations=nodes(root,ts.isVariableDeclaration).filter(d=>ts.isIdentifier(d.name)&&d.name.text===name);assert.equal(declarations.length,1,`переменная ${name} однозначна`);assert.ok(declarations[0].initializer);return declarations[0].initializer;}
function mutant(source:string,from:string,to:string){assert.ok(source.includes(from),`якорь ${from}`);const result=source.replace(from,to);assert.notEqual(result,source);return result;}

test('R130 SchedPick не принимает mute: окно отправки больше не служит выбором мьюта',()=>{
  // Ловит возврат скрытого режима мьюта в публичный контракт и деструктуризацию.
  const verify=(source:string)=>{const {sf,pick}=component(source);const props=sf.statements.find((s):s is ts.InterfaceDeclaration=>ts.isInterfaceDeclaration(s)&&s.name.text==='SchedPickProps');assert.ok(props);
    assert.ok(props.members.every(m=>!m.name||m.name.getText(sf)!=='mute'));
    const binding=pick.parameters[0].name;assert.ok(ts.isObjectBindingPattern(binding));assert.ok(binding.elements.every(e=>(e.propertyName??e.name).getText(sf)!=='mute'));
  };
  verify(schedSource);assert.throws(()=>verify(mutant(schedSource,'export interface SchedPickProps {','export interface SchedPickProps { mute?: boolean;')),assert.AssertionError);
});
test('R130 заголовок Отправить позже передаётся и листу телефона, и десктопному диалогу',()=>{
  // Ловит старый заголовок выбора срока и потерю правильной подписи в одной платформе.
  const verify=(source:string)=>{const {sf,pick}=component(source);const title=variable(sf,'TITLE');assert.ok(ts.isStringLiteral(title));assert.equal(title.text,'Отправить позже');
    const openings=nodes(pick,(n):n is ts.JsxOpeningElement|ts.JsxSelfClosingElement=>ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n));
    for(const name of ['BottomSheet','SchedDialog']){const list=openings.filter(n=>n.tagName.getText(sf)===name);assert.equal(list.length,1);const value=attr(list[0],'title')?.initializer;assert.ok(value&&ts.isJsxExpression(value)&&value.expression);assert.ok(ts.isIdentifier(value.expression));assert.equal(value.expression.text,'TITLE');}
  };
  verify(schedSource);assert.throws(()=>verify(mutant(schedSource,"const TITLE = 'Отправить позже';","const TITLE = 'Выключить на время';")),assert.AssertionError);
  assert.throws(()=>verify(mutant(schedSource,'<SchedDialog title={TITLE}','<SchedDialog title="Выключить на время"')),assert.AssertionError);
});
test('R130 быстрые варианты по-прежнему вычисляются и выбирают время отправки через commit',()=>{
  // Ловит исчезновение быстрых кнопок после удаления режима mute, а не просто наличие текста в комментарии.
  assert.deepEqual(quickOptions(new Date(2026,9,9,12,0)).map(q=>q.label),['Через час','Завтра утром','Завтра вечером']);
  const verify=(source:string)=>{const {sf,pick}=component(source);const quick=variable(pick,'quick');assert.ok(nodes(quick,ts.isCallExpression).some(call=>ts.isIdentifier(call.expression)&&call.expression.text==='quickOptions'&&call.arguments[0]?.getText(sf)==='now'));
    const maps=nodes(pick,ts.isCallExpression).filter(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.expression.getText(sf)==='quick'&&call.expression.name.text==='map');assert.equal(maps.length,1);
    for(const shown of ['q.label','q.time'])assert.ok(nodes(maps[0],ts.isJsxExpression).some(n=>n.expression?.getText(sf)===shown),`быстрая кнопка показывает ${shown}`);
    const buttons=nodes(maps[0],ts.isJsxOpeningElement).filter(n=>n.tagName.getText(sf)==='button');assert.equal(buttons.length,1);const click=attr(buttons[0],'onClick')?.initializer;assert.ok(click);
    const commits=nodes(click,ts.isCallExpression).filter(call=>ts.isIdentifier(call.expression)&&call.expression.text==='commit');assert.equal(commits.length,1);assert.equal(commits[0].arguments[0]?.getText(sf),'q.at');
  };
  verify(schedSource);assert.throws(()=>verify(mutant(schedSource,'quick.map((q)','[].map((q)')),assert.AssertionError);
  assert.throws(()=>verify(mutant(schedSource,'commit(q.at,','commit(now,')),assert.AssertionError);
  assert.throws(()=>verify(mutant(schedSource,'{q.label}',"{'Вариант'}")),assert.AssertionError);
});
test('R130 класс desk ставится только полосе Tauri, браузер и телефон его не получают',()=>{
  // Ловит инверсию платформы и перенос трёхстрочной подписи в обычный браузер.
  const verify=(source:string)=>{const sf=parsed(source);const tabs=nodes(sf,ts.isJsxOpeningElement).filter(n=>{const role=attr(n,'role')?.initializer;return n.tagName.getText(sf)==='div'&&role&&ts.isStringLiteral(role)&&role.text==='tablist';});assert.equal(tabs.length,1);
    const value=attr(tabs[0],'className')?.initializer;assert.ok(value&&ts.isJsxExpression(value)&&value.expression&&ts.isConditionalExpression(value.expression));const phone=value.expression;assert.equal(phone.condition.getText(sf),'phone');assert.ok(ts.isStringLiteral(phone.whenTrue));assert.equal(phone.whenTrue.text,'dm-folder-tabs');
    assert.ok(ts.isConditionalExpression(phone.whenFalse));const desktop=phone.whenFalse;assert.ok(ts.isCallExpression(desktop.condition));assert.ok(ts.isIdentifier(desktop.condition.expression));assert.equal(desktop.condition.expression.text,'isTauri');assert.equal(desktop.condition.arguments.length,0);
    assert.ok(ts.isStringLiteral(desktop.whenTrue)&&ts.isStringLiteral(desktop.whenFalse));assert.equal(desktop.whenTrue.text,'dm-folders desk');assert.equal(desktop.whenFalse.text,'dm-folders');
  };
  verify(folderSource);assert.throws(()=>verify(mutant(folderSource,"isTauri() ? 'dm-folders desk'","!isTauri() ? 'dm-folders desk'")),assert.AssertionError);
  assert.throws(()=>verify(mutant(folderSource,"isTauri() ? 'dm-folders desk' : 'dm-folders'","isTauri() ? 'dm-folders' : 'dm-folders desk'")),assert.AssertionError);
});
