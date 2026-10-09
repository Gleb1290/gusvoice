import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';

type LayerApi = { layerAbove: (el: Element | null) => boolean };

function layerSource(change?: (source: string) => string): string {
  const full = readFileSync(new URL('./androidBack.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const parsed = ts.createSourceFile('androidBack.ts', full, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let topLayers: ts.VariableStatement | undefined;
  let layerAbove: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'TOP_LAYERS')) topLayers = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'layerAbove') layerAbove = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(topLayers && layerAbove, 'извлечены настоящие TOP_LAYERS и layerAbove');
  const raw = `${topLayers.getText(parsed)}\n${layerAbove.getText(parsed)}`;
  return change ? change(raw) : raw;
}

function load(source: string): LayerApi {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as LayerApi };
  runInNewContext(code, { module, exports: module.exports, document });
  return module.exports;
}

function mutant(from: string, to: string): LayerApi {
  const source = layerSource();
  assert.ok(source.includes(from), `найдено место мутации: ${from}`);
  const changed = source.replace(from, to);
  assert.notEqual(changed, source, 'мутант действительно изменил исходник');
  return load(changed);
}

it('Esc-модалка молчит при соседнем листе, но не считает свой лист-родитель чужим слоем', () => {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  try {
    const check = (api: LayerApi) => {
      document.body.replaceChildren();
      const dialog = document.createElement('div');
      document.body.append(dialog);
      assert.equal(api.layerAbove(dialog), false, 'пустая страница не перекрывает окно');

      const siblingSheet = document.createElement('div'); siblingSheet.className = 'sheet';
      document.body.append(siblingSheet);
      assert.equal(api.layerAbove(dialog), true, 'лист в body рядом с окном получает первый Esc');

      document.body.replaceChildren();
      const parentSheet = document.createElement('div'); parentSheet.className = 'sheet';
      const nestedDialog = document.createElement('div'); parentSheet.append(nestedDialog); document.body.append(parentSheet);
      assert.equal(api.layerAbove(nestedDialog), false, 'окно внутри листа не должно блокировать собственный Esc');
    };
    const original = layerSource();
    check(load(original));
    assert.throws(() => check(mutant('if (el && l.contains(el)) continue;', '')), assert.AssertionError);
    assert.throws(() => check(mutant('document.querySelectorAll(TOP_LAYERS)', "document.querySelectorAll('.modal-overlay')")), assert.AssertionError);
  } finally {
    GlobalRegistrator.unregister();
  }
});
