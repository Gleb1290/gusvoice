import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as shared from '@gusvoice/shared';
import * as format from './fieldFormat';

it('HTML из Docs не делает normal жирным, spoiler сохраняется и несовпадающий plain отдаётся браузеру', () => {
  // HTML-обёртка Google Docs иначе превращала весь вставленный текст в жирный.
  GlobalRegistrator.register();
  try {
    const module = { exports: {} };
    runInNewContext(ts.transpileModule(readFileSync(new URL('./fieldFormatDom.ts', import.meta.url),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText,
      { module,exports:module.exports,document,DOMParser,Node,HTMLElement,HTMLInputElement,HTMLTextAreaElement,require:(id:string)=> { if(id==='@gusvoice/shared') return shared; if(id==='./fieldFormat')return format; assert.equal(id,'./hotkeys');return{isMobile:()=>false}; } });
    const api = module.exports as typeof import('./fieldFormatDom');
    assert.equal(api.htmlToMarkdown('<b style="font-weight:normal">word</b>','word'),null, 'без формата остаётся обычная браузерная вставка');
    assert.equal(api.htmlToMarkdown('<b>word</b>','word'),'**word**');
    assert.equal(api.htmlToMarkdown('<tg-spoiler>secret</tg-spoiler>','secret'),'||secret||');
    assert.equal(api.htmlToMarkdown('<b>word</b>','different'),null);
  } finally { GlobalRegistrator.unregister(); }
});
