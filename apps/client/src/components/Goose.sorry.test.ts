import { counterfact } from '../../../../packages/shared/test/counterfacts.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = readFileSync(new URL('./Goose.tsx', import.meta.url), 'utf8');
const png = readFileSync(new URL('../assets/mascot/sorry.png', import.meta.url));

// Читаем фактические RGBA-пиксели без браузера и зависимостей. У сохранённых PNG-поз —
// 8 бит на канал, без interlace; все пять стандартных PNG-фильтров поддержаны.
function readRgba(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width = 0; let height = 0;
  const blocks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length, 'PNG chunk не обрезан');
    const name = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'PNG: 8 бит на канал');
      assert.equal(data[9], 6, 'PNG: настоящий RGBA, не непрозрачный RGB');
      assert.equal(data[10], 0); assert.equal(data[11], 0); assert.equal(data[12], 0);
    }
    if (name === 'IDAT') blocks.push(data);
    offset += length + 12;
    if (name === 'IEND') break;
  }
  assert.ok(width > 0 && width <= 1024 && height > 0 && height <= 1024);
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(blocks), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
      let predict = 0;
      if (filter === 1) predict = left;
      if (filter === 2) predict = up;
      if (filter === 3) predict = Math.floor((left + up) / 2);
      if (filter === 4) {
        const p = left + up - upperLeft;
        const a = Math.abs(p - left); const b = Math.abs(p - up); const c = Math.abs(p - upperLeft);
        predict = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      rgba[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predict) & 255;
    }
  }
  return { width, height, rgba };
}
const pixels = readRgba(png);
function alphaCheck(image: typeof pixels) {
  let visible = 0; let partial = 0; let transparent = 0; let paintedBorder = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const alpha = image.rgba[(y * image.width + x) * 4 + 3];
    if (alpha === 0) transparent++;
    else {
      visible++;
      if (alpha < 255) partial++;
      if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) paintedBorder++;
    }
  }
  assert.equal(paintedBorder, 0, 'R318/sorry/прозрачный-край');
  const area = image.width * image.height;
  assert.ok(visible > area * 0.2, 'маскот не исчез и не заменён пустым PNG');
  assert.ok(transparent > area * 0.2, 'нет сплошной подложки или нарисованных шахмат');
  assert.ok(partial > 0, 'сглаженный контур сохранён, не бинарная зубчатая маска');
}
function poseSize(raw: string) {
  const ast = ts.createSourceFile('Goose.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let table: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'POSES'
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) table = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(table, 'таблица POSES существует');
  const pose = table.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'sorry');
  assert.ok(pose && ts.isPropertyAssignment(pose) && ts.isObjectLiteralExpression(pose.initializer));
  const fields = new Map(pose.initializer.properties.filter(ts.isPropertyAssignment)
    .map(p => [p.name.getText(ast), p.initializer.getText(ast)]));
  const binding = fields.get('src');
  const imports = ast.statements.filter(ts.isImportDeclaration);
  assert.ok(imports.some(i => i.importClause?.name?.text === binding
    && ts.isStringLiteral(i.moduleSpecifier) && i.moduleSpecifier.text === '../assets/mascot/sorry.png'),
  'sorry использует собственный PNG, не head');
  return { width: Number(fields.get('width')), height: Number(fields.get('height')) };
}
function geometryCheck(raw: string) {
  const size = poseSize(raw);
  assert.equal(size.width, pixels.width, 'R318/sorry/ширина-ассета');
  assert.equal(size.height, pixels.height, 'R318/sorry/высота-ассета');
  const exports: { Goose?: (p: { pose: string; size: number }) => React.ReactElement } = {};
  const js = ts.transpileModule(raw, { fileName: 'Goose.tsx', compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(js, { exports, require: (name: string) => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.match(name, /^\.\.\/assets\/mascot\/[a-z-]+\.png$/);
    return { default: name };
  } }, { filename: 'Goose.r318.vm.js', timeout: 2_000 });
  assert.ok(exports.Goose);
  for (const width of [96, 104, 120]) {
    const element = exports.Goose({ pose: 'sorry', size: width });
    const props = element.props as { width: number; height: number; src: string; alt: string;
      'aria-hidden': string; draggable: boolean };
    assert.equal(props.width, width);
    assert.equal(props.height, Math.round(width * pixels.height / pixels.width), 'R318/sorry/пропорция');
    assert.equal(props.src, '../assets/mascot/sorry.png');
    assert.equal(props.alt, ''); assert.equal(props['aria-hidden'], 'true'); assert.equal(props.draggable, false);
    assert.match(renderToStaticMarkup(element), /<img /);
  }
}
function changed(anchor: string, next: string) {
  assert.equal(source.split(anchor).length - 1, 1, 'R318/sorry/уникальный-якорь');
  return source.replace(anchor, next);
}

it('R318 sorry — отдельная полная PNG-поза, не прежняя заглушка head и не огромный исходник', () => {
  const head = readFileSync(new URL('../assets/mascot/head.png', import.meta.url));
  assert.notEqual(createHash('sha256').update(png).digest('hex'), createHash('sha256').update(head).digest('hex'));
  assert.ok(pixels.width >= 160 && pixels.width <= 384);
  assert.ok(pixels.height >= 160 && pixels.height <= 384);
  assert.ok(png.length < 200_000, 'поза не раздувает загрузку маленькой карточки');
});
it('R318 настоящий PNG имеет прозрачные края, свободный фон и сглаженный непустой силуэт', () => {
  alphaCheck(pixels);
});
it('R318 Goose знает настоящие размеры sorry и сохраняет пропорции при 96/104/120 пикселях', () => {
  geometryCheck(source);
});
it('R318 контрфакт: непрозрачная подложка не проходит проверку реальных альфа-пикселей', () => {
  alphaCheck(pixels);
  counterfact(() => {
    const rgba = Buffer.from(pixels.rgba);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    assert.throws(() => alphaCheck({ ...pixels, rgba }), e => e instanceof assert.AssertionError
      && e.message.includes('R318/sorry/прозрачный-край') && typeof e.actual === 'number'
      && e.actual > 0 && e.expected === 0);
  });
});
it('R318 контрфакт: старые размеры головы не подходят новой полной позе', () => {
  geometryCheck(source);
  counterfact(() => {
    const old = poseSize(source);
    const mutant = changed(`sorry: { src: sorryPng, width: ${old.width}, height: ${old.height} }`,
      'sorry: { src: sorryPng, width: 104, height: 104 }');
    assert.throws(() => geometryCheck(mutant), e => e instanceof assert.AssertionError
      && e.message.includes('R318/sorry/ширина-ассета') && e.actual === 104 && e.expected === pixels.width);
  });
});
it('R318 контрфакт: принудительный квадрат не должен сплющивать извиняющегося гуся', () => {
  geometryCheck(source);
  counterfact(() => {
    const mutant = changed('height={Math.round(size * (asset.height / asset.width))}', 'height={size}');
    assert.throws(() => geometryCheck(mutant), e => e instanceof assert.AssertionError
      && e.message.includes('R318/sorry/пропорция') && e.actual === 96
      && e.expected === Math.round(96 * pixels.height / pixels.width));
  });
});
