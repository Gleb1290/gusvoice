import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampPinIndex, PIN_BAR_SEGMENTS_MAX, pinSegments } from './pinBarRules.js';
import * as rules from './pinBarRules.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
it('трек закрепа соблюдает нижнюю границу и цикл после нажатия на самое старое', () => {
  // Ловит показ следующего вместо предыдущего закрепа на точном ключе.
  const keys=[10,20,30]; const track=(bottomKey:number|null,clickedKey:number|null=null)=>rules.pinTrack({keys,bottomKey,clickedKey});
  assert.deepEqual(track(30),{index:2,clickedKey:null}); assert.equal(track(1).index,0);
  assert.deepEqual(track(40,20),{index:0,clickedKey:20}); assert.deepEqual(track(20,20),{index:1,clickedKey:null});
  assert.equal(track(40,10).index,2); assert.equal(track(null).index,-1);
  assert.equal(rules.pinTrack({keys:[],bottomKey:10,clickedKey:null}).index,-1);
  assert.equal(rules.pinNextIndex(keys,20),2); assert.equal(rules.pinNextIndex(keys,30),0);
  for(const ref of [null,NaN]) assert.equal(rules.pinNextIndex(keys,ref),0);
  assert.equal(rules.pinNextIndex([],10),-1);
  // Те же пограничные случаи обязаны отвергать контрфакты включительности и цикла старейшего.
  const source=readFileSync(new URL('./pinBarRules.ts',import.meta.url),'utf8');
  const check=(api:typeof rules)=>{
    assert.equal(api.pinTrack({keys,bottomKey:30,clickedKey:null}).index,2);
    assert.equal(api.pinTrack({keys,bottomKey:40,clickedKey:10}).index,2);
    assert.equal(api.pinTrack({keys,bottomKey:20,clickedKey:20}).clickedKey,null);
  }; check(rules);
  for(const [from,to] of [['keys[i] <= limit','keys[i] < limit'],['if (clicked <= keys[0]) limit = Number.POSITIVE_INFINITY;','if (false) limit = Number.POSITIVE_INFINITY;'],['bottomKey <= clicked','bottomKey < clicked']] as const){
    assert.ok(source.includes(from));const module={exports:{}};
    runInNewContext(ts.transpileModule(source.replace(from,to),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports});
    assert.throws(()=>check(module.exports as typeof rules),assert.AssertionError);
  }
});
it('скрытый набор возвращается только новым id, служебная строка принимает известный вид и режет текст до 40', () => {
  // Ловит фантомную служебную строку и навсегда скрытый новый закреп.
  assert.equal(rules.pinBarHidden(['a'],['a','b']),true); assert.equal(rules.pinBarHidden(['a','c'],['a','b']),false);
  assert.equal(rules.pinBarHidden([],['a']),false);
  assert.equal(rules.pinTitle(1,0),'Закреплённое сообщение'); assert.equal(rules.pinTitle(2,0),'Предыдущее сообщение');
  assert.equal(rules.pinTitle(5,2),'Закреплённое сообщение #3'); assert.equal(rules.pinTitle(3,2),'Закреплённое сообщение');
  assert.deepEqual(rules.pinServiceMark({service:{kind:'pin',messageId:'a'}}),{kind:'pin',messageId:'a'});
  for(const service of [null,{kind:'other',messageId:'a'},{kind:'pin',messageId:''}]) assert.equal(rules.pinServiceMark({service}),null);
  assert.equal(rules.pinServiceLead(true,'x'),'Вы закрепили'); assert.equal(rules.pinServiceLead(false,'  '),'Собеседник закрепил(а)');
  assert.equal(rules.pinServiceTail('x'.repeat(40)),`«${'x'.repeat(40)}»`);
  assert.equal(rules.pinServiceTail('x'.repeat(41)),`«${'x'.repeat(39)}…»`);
  assert.equal(rules.pinServiceTail(''),'сообщение'); assert.equal(rules.pinServiceTail('','voice'),'голосовое сообщение');
});

describe('правила полосы закрепа', () => {
  // Число делений ограничено шириной полосы, иначе длинный список вытеснит текст сообщения.
  it('лимит окна остаётся четырьмя делениями — компактная полоса не разрастается', () => {
    assert.ok(PIN_BAR_SEGMENTS_MAX === 4, 'полоса должна показывать не больше четырёх делений');
  });

  // Пустое или испорченное состояние встречается при гонках обновления списка и не должно рисовать фантомные закрепы.
  it('пустой список и некорректное количество не дают выбранного закрепа', () => {
    assert.ok(clampPinIndex(0, 4) === 0, 'при нуле закрепов индекс безопасно равен нулю');
    assert.ok(clampPinIndex(-2, 4) === 0, 'отрицательное количество не должно создавать индекс');
    assert.ok(clampPinIndex(Number.NaN, 4) === 0, 'NaN в количестве не должен протечь в отображение');
    assert.ok(clampPinIndex(Number.POSITIVE_INFINITY, 4) === 0, 'бесконечность не является числом закрепов');
    assert.ok(pinSegments(0, 0).length === 0, 'пустой список не рисует сегменты');
  });

  // Даже устаревший индекс не должен оставить единственный сегмент неактивным.
  it('один закреп даёт одно активное деление независимо от мусорного индекса', () => {
    assert.deepEqual(pinSegments(1, 99), [true], 'единственное деление обязано быть активным');
  });

  // Ровно лимит — важная включительная граница перед переключением на скользящее окно.
  it('до четырёх закрепов показываются все — ровно четыре ещё помещаются', () => {
    assert.deepEqual(pinSegments(4, 2), [false, false, true, false], 'четыре закрепа целиком помещаются');
  });

  // Пятый элемент меняет отображение на окно, но не теряет текущий выбор.
  it('пятый закреп включает окно из четырёх вокруг текущего', () => {
    assert.deepEqual(pinSegments(5, 2), [false, false, true, false], 'у среднего закрепа окно включает два старых и один новый');
  });

  // На старом краю окно должно сдвигаться, а не оставлять пустое место слева.
  it('окно у старого края упирается в начало списка', () => {
    assert.deepEqual(pinSegments(10, 0), [true, false, false, false], 'у первого закрепа окно не уходит в отрицательные позиции');
    assert.deepEqual(pinSegments(10, 1), [false, true, false, false], 'у второго закрепа окно также начинается с нуля');
  });

  // На новом краю выбранное деление остаётся видимым, несмотря на ограничение длины окна.
  it('окно у нового края упирается в конец списка', () => {
    assert.deepEqual(pinSegments(10, 9), [false, false, false, true], 'последнее деление остаётся видимым у последнего закрепа');
    assert.deepEqual(pinSegments(10, 8), [false, false, true, false], 'предпоследний индекс не сдвигает окно за край');
  });

  // Дробные данные отзывающегося компонента не должны создавать лишний сегмент или выбирать соседний элемент.
  it('дробное количество округляется вниз, а дробный индекс к целому', () => {
    assert.deepEqual(pinSegments(4.9, 1.9), [false, true, false, false], 'мусорные дроби нормализуются без лишнего закрепа');
  });

  // Внешние индексы часто устаревают после удаления закрепа, поэтому обе стороны диапазона нужно зажимать.
  it('отрицательные, чрезмерные и нечисловые индексы прижимаются к диапазону', () => {
    assert.ok(clampPinIndex(3, -1) === 0, 'отрицательный индекс выбирает первый закреп');
    assert.ok(clampPinIndex(3, 9) === 2, 'индекс выше списка выбирает последний закреп');
    assert.ok(clampPinIndex(3, Number.NaN) === 0, 'NaN индекса безопасно выбирает первый закреп');
    assert.ok(clampPinIndex(3, Number.POSITIVE_INFINITY) === 0, 'бесконечный индекс безопасно выбирает первый закреп');
    assert.ok(clampPinIndex(3, 1.9) === 1, 'дробный индекс отбрасывает дробную часть');
  });

  // Скользящее окно должно сохранять ровно один маркер выбора и при движении через весь список.
  it('активен ровно один сегмент при любом допустимом выбранном индексе', () => {
    for (let index = 0; index < 12; index++) {
      const segments = pinSegments(12, index);
      assert.ok(segments.length === 4, `для индекса ${index} окно должно оставаться четырёхместным`);
      assert.ok(segments.filter(Boolean).length === 1, `для индекса ${index} активен ровно один сегмент`);
    }
  });
});
