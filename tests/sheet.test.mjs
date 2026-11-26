import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOps, checkWorkbook, emptyWorkbook, filterHiddenRows, normalizeWorkbook, parseDelimited, parseOps, parseWorkbookJson, rangeText, readRange,
  relativeForm, seriesValues, serializeWorkbook, summarizeWorkbook, templateOps, toDelimited, validate, validationAt,
} from '../src/extensions/sheet/sheet.ts';
import { Engine } from '../src/extensions/sheet/engine.ts';
import { parse, shiftFormula, tokenize, transformRefs, colName, colIndex, parseRect } from '../src/extensions/sheet/formula.ts';
import { FUNCTIONS, FUNCTION_NAMES, criterion } from '../src/extensions/sheet/functions.ts';
import { formatValue, parseInput, serialFromParts } from '../src/extensions/sheet/numfmt.ts';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const run = (wb, ops, opts) => {
  const r = applyOps(wb, ops, opts);
  assert.equal(r.error, undefined, r.error);
  return r.workbook;
};
/** Workbook with values typed at A1 of Sheet1, plus extra ops. */
const book = (rows, ops = []) => run(emptyWorkbook('T'), [{ op: 'set', range: 'A1', values: rows }, ...ops]);
const engine = (wb) => new Engine(wb, { now: NOW, random: () => 0.5 });
const val = (wb, a, sheet = 's1') => { const e = engine(wb); const m = /^([A-Z]+)(\d+)$/.exec(a); return e.value(sheet, Number(m[2]) - 1, colIndex(m[1])); };
/** Evaluates one formula against a small data block. */
const calc = (formula, rows = []) => { const wb = book(rows.length ? rows : [['']]); return engine(wb).evalAt('s1', formula, 50, 10); };

test('A1 helpers: column names, ranges and tokens', () => {
  assert.equal(colName(0), 'A'); assert.equal(colName(25), 'Z'); assert.equal(colName(26), 'AA'); assert.equal(colName(701), 'ZZ'); assert.equal(colName(18277), 'ZZZ');
  assert.equal(colIndex('AA'), 26); assert.equal(colIndex('ZZZ'), 18277);
  assert.deepEqual(parseRect('B2:D9'), { r1: 1, c1: 1, r2: 8, c2: 3 });
  assert.deepEqual(parseRect('C:C', 100, 26), { r1: 0, c1: 2, r2: 99, c2: 2 });
  assert.deepEqual(parseRect('2:4', 100, 26), { r1: 1, c1: 0, r2: 3, c2: 25 });
  const toks = tokenize("SUM('My Sheet'!$A$1:B2, LOG10(5), Sheet2!C:C)").filter((t) => t.type === 'ref');
  assert.equal(toks.length, 2);
  assert.equal(toks[0].ref.sheet, 'My Sheet'); assert.equal(toks[0].ref.ac1, true); assert.equal(toks[1].ref.kind, 'cols');
  assert.throws(() => parse('=SUM(1,'));
  assert.throws(() => parse('=(1+2'));
});

test('operators follow Sheets precedence and coercion', () => {
  assert.equal(calc('=1+2*3'), 7);
  assert.equal(calc('=-2^2'), 4);
  assert.equal(calc('=2^3^2'), 64);
  assert.equal(calc('=50%*10'), 5);
  assert.equal(calc('="3"+4'), 7);
  assert.equal(calc('="a"&1&TRUE'), 'a1TRUE');
  assert.equal(calc('=TRUE+1'), 2);
  assert.equal(calc('="abc"="ABC"'), true);
  assert.equal(calc('=1<"a"'), true);
  assert.equal(calc('=1/0').code, '#DIV/0!');
  assert.equal(calc('="x"*2').code, '#VALUE!');
  assert.equal(calc('=NOPE(1)').code, '#NAME?');
  assert.equal(calc('=SUM(').code, '#ERROR!');
  assert.deepEqual(calc('={1,2;3,4}*10'), [[10, 20], [30, 40]]);
});

test('math and statistics functions', () => {
  const rows = [[1, 'x'], [2, ''], [3, true], [4, 10], ["'5", 20]];
  assert.equal(calc('=SUM(A1:A5)', rows), 10); // "5" is text inside a range and is skipped
  assert.equal(calc('=SUM(1,"2",TRUE)'), 4);
  assert.equal(calc('=AVERAGE(A1:A4)', rows), 2.5);
  assert.equal(calc('=COUNT(A1:B5)', rows), 6);
  assert.equal(calc('=COUNTA(A1:B5)', rows), 9);
  assert.equal(calc('=COUNTBLANK(B1:B5)', rows), 1);
  assert.equal(calc('=MIN(A1:A4)', rows), 1); assert.equal(calc('=MAX(B4:B5)', rows), 20);
  assert.equal(calc('=ROUND(2.5)'), 3); assert.equal(calc('=ROUND(-2.5)'), -3); assert.equal(calc('=ROUND(1.005,2)'), 1.01);
  assert.equal(calc('=ROUNDUP(1.21,1)'), 1.3); assert.equal(calc('=ROUNDDOWN(-1.29,1)'), -1.2);
  assert.equal(calc('=MOD(-3,2)'), 1); assert.equal(calc('=INT(-1.5)'), -2); assert.equal(calc('=ABS(-4)'), 4);
  assert.equal(calc('=POWER(2,10)'), 1024); assert.equal(calc('=SQRT(16)'), 4); assert.equal(calc('=SQRT(-1)').code, '#NUM!');
  assert.equal(calc('=PRODUCT(2,3,4)'), 24);
  assert.equal(calc('=RAND()'), 0.5); assert.equal(calc('=RANDBETWEEN(1,10)'), 6);
  assert.equal(calc('=MEDIAN(5,1,3,2)'), 2.5);
  assert.ok(Math.abs(calc('=STDEV(2,4,4,4,5,5,7,9)') - 2.138089935) < 1e-9);
  assert.equal(calc('=STDEVP(2,4,4,4,5,5,7,9)'), 2);
  assert.equal(calc('=VARP(2,4,4,4,5,5,7,9)'), 4);
  assert.equal(calc('=LARGE({5,1,9,3},2)'), 5); assert.equal(calc('=SMALL({5,1,9,3},1)'), 1);
  assert.equal(calc('=RANK(9,{5,1,9,3})'), 1); assert.equal(calc('=RANK(1,{5,1,9,3},1)'), 1);
  assert.equal(calc('=PERCENTILE({1,2,3,4},0.5)'), 2.5);
  assert.equal(calc('=SUMPRODUCT({1,2,3},{4,5,6})'), 32);
  assert.equal(calc('=SUBTOTAL(9,{1,2,3})'), 6);
});

test('conditional aggregation: COUNTIF(S), SUMIF(S), AVERAGEIF(S) with operators and wildcards', () => {
  const rows = [['Region', 'Product', 'Units'], ['North', 'Widget', 10], ['South', 'Gadget', 5], ['North', 'Gadget', 7], ['East', 'Widget', 3], ['north', 'Gizmo', 20]];
  assert.equal(calc('=COUNTIF(A2:A6,"north")', rows), 3);
  assert.equal(calc('=COUNTIF(C2:C6,">5")', rows), 3);
  assert.equal(calc('=COUNTIF(C2:C6,"<>5")', rows), 4);
  assert.equal(calc('=COUNTIF(B2:B6,"G*")', rows), 3);
  assert.equal(calc('=COUNTIF(B2:B6,"?idget")', rows), 2);
  assert.equal(calc('=SUMIF(A2:A6,"North",C2:C6)', rows), 37);
  assert.equal(calc('=SUMIFS(C2:C6,A2:A6,"North",B2:B6,"Gadget")', rows), 7);
  assert.equal(calc('=COUNTIFS(A2:A6,"North",C2:C6,">=10")', rows), 2);
  assert.equal(calc('=AVERAGEIF(B2:B6,"Widget",C2:C6)', rows), 6.5);
  assert.equal(calc('=AVERAGEIFS(C2:C6,A2:A6,"North")', rows), 37 / 3);
  assert.equal(calc('=MAXIFS(C2:C6,B2:B6,"Gadget")', rows), 7);
  assert.equal(calc('=MINIFS(C2:C6,B2:B6,"Gadget")', rows), 5);
  assert.equal(criterion('>=2')(3), true); assert.equal(criterion('')(null), true); assert.equal(criterion('<>')(null), false);
});

test('logical functions are lazy where they should be', () => {
  assert.equal(calc('=IF(1>2,"yes","no")'), 'no');
  assert.equal(calc('=IF(TRUE,1)'), 1); assert.equal(calc('=IF(FALSE,1)'), false);
  assert.equal(calc('=IF(TRUE,1,1/0)'), 1);
  assert.equal(calc('=IFS(1>2,"a",2>1,"b")'), 'b');
  assert.equal(calc('=IFS(1>2,"a")').code, '#N/A');
  assert.equal(calc('=AND(TRUE,1,2>1)'), true); assert.equal(calc('=OR(FALSE,0)'), false); assert.equal(calc('=NOT(FALSE)'), true); assert.equal(calc('=XOR(TRUE,TRUE)'), false);
  assert.equal(calc('=IFERROR(1/0,"oops")'), 'oops'); assert.equal(calc('=IFERROR(5,"oops")'), 5);
  assert.equal(calc('=IFNA(NA(),"none")'), 'none'); assert.equal(calc('=IFNA(1/0,"none")').code, '#DIV/0!');
  assert.equal(calc('=SWITCH(2,1,"one",2,"two","other")'), 'two'); assert.equal(calc('=SWITCH(9,1,"one","other")'), 'other');
  assert.deepEqual(calc('=IF({1,0,1},"y","n")'), [['y', 'n', 'y']]);
});

test('lookups: VLOOKUP, HLOOKUP, XLOOKUP, INDEX/MATCH', () => {
  const rows = [['Code', 'Name', 'Price'], ['A1x', 'Apple', 1.2], ['B2x', 'Banana', 0.5], ['C3x', 'Cherry', 4]];
  assert.equal(calc('=VLOOKUP("B2x",A2:C4,2,FALSE)', rows), 'Banana');
  assert.equal(calc('=VLOOKUP("b2X",A2:C4,3,FALSE)', rows), 0.5);
  assert.equal(calc('=VLOOKUP("Z",A2:C4,2,FALSE)', rows).code, '#N/A');
  assert.equal(calc('=VLOOKUP("B*",A2:C4,2,FALSE)', rows), 'Banana');
  assert.equal(calc('=VLOOKUP(2.5,{1,"a";2,"b";3,"c"},2)'), 'b');
  assert.equal(calc('=VLOOKUP("A1x",A2:C4,9,FALSE)', rows).code, '#VALUE!');
  assert.equal(calc('=HLOOKUP("Price",A1:C4,3,FALSE)', rows), 0.5);
  assert.equal(calc('=INDEX(A1:C4,3,2)', rows), 'Banana');
  assert.equal(calc('=MATCH("Cherry",B1:B4,0)', rows), 4);
  assert.equal(calc('=INDEX(C2:C4,MATCH("Apple",B2:B4,0))', rows), 1.2);
  assert.equal(calc('=XLOOKUP("Cherry",B2:B4,C2:C4)', rows), 4);
  assert.equal(calc('=XLOOKUP("Kiwi",B2:B4,C2:C4,"missing")', rows), 'missing');
  assert.equal(calc('=XLOOKUP(3,{1,2,4},{10,20,40},,1)'), 40);
  assert.equal(calc('=XLOOKUP(3,{1,2,4},{10,20,40},,-1)'), 20);
  assert.deepEqual(calc('=XLOOKUP("B2x",A2:A4,A2:C4)', rows), [['B2x', 'Banana', 0.5]]);
  assert.equal(calc('=SUM(INDEX(C2:C4,0,1))', rows), 5.7);
  assert.equal(calc('=ROWS(A1:C4)', rows), 4); assert.equal(calc('=COLUMNS(A1:C4)', rows), 3);
  assert.equal(calc('=INDIRECT("B3")', rows), 'Banana');
  assert.equal(calc('=SUM(OFFSET(C1,1,0,3,1))', rows), 5.7);
  assert.equal(calc('=ADDRESS(2,3)'), '$C$2'); assert.equal(calc('=ADDRESS(2,3,4)'), 'C2');
  assert.equal(calc('=CHOOSE(2,"a","b","c")'), 'b');
});

test('text functions', () => {
  assert.equal(calc('=CONCATENATE("a","b",1)'), 'ab1'); assert.equal(calc('=CONCAT("x","y")'), 'xy');
  assert.equal(calc('=TEXTJOIN(", ",TRUE,"a","","b")'), 'a, b'); assert.equal(calc('=JOIN("-",{1,2,3})'), '1-2-3');
  assert.equal(calc('=LEFT("Sheets",3)'), 'She'); assert.equal(calc('=RIGHT("Sheets",2)'), 'ts'); assert.equal(calc('=MID("Sheets",2,3)'), 'hee');
  assert.equal(calc('=LEN("สวัสดี")'), 6);
  assert.equal(calc('=UPPER("abc")'), 'ABC'); assert.equal(calc('=LOWER("ABC")'), 'abc'); assert.equal(calc('=PROPER("hello wORLD")'), 'Hello World');
  assert.equal(calc('=TRIM("  a   b  ")'), 'a b');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c'); assert.equal(calc('=SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c');
  assert.deepEqual(calc('=SPLIT("a,b,,c",",")'), [['a', 'b', 'c']]);
  assert.deepEqual(calc('=SPLIT("1;2",";")'), [[1, 2]]);
  assert.equal(calc('=TEXT(1234.5,"#,##0.00")'), '1,234.50'); assert.equal(calc('=TEXT(0.256,"0.0%")'), '25.6%');
  assert.equal(calc('=TEXT(DATE(2026,3,5),"yyyy-mm-dd")'), '2026-03-05'); assert.equal(calc('=TEXT(DATE(2026,3,5),"dddd d mmmm")'), 'Thursday 5 March');
  assert.equal(calc('=VALUE("1,200")'), 1200); assert.equal(calc('=VALUE("12%")'), 0.12); assert.equal(calc('=VALUE("x")').code, '#VALUE!');
  assert.equal(calc('=FIND("b","abcb")'), 2); assert.equal(calc('=FIND("B","abcb")').code, '#VALUE!'); assert.equal(calc('=SEARCH("B","abcb",3)'), 4);
  assert.equal(calc('=REGEXMATCH("order-123","\\d+")'), true); assert.equal(calc('=REGEXEXTRACT("order-123","(\\d+)")'), '123');
  assert.equal(calc('=REGEXREPLACE("a1b2","\\d","#")'), 'a#b#');
  assert.equal(calc('=REPT("ab",3)'), 'ababab'); assert.equal(calc('=EXACT("a","A")'), false);
  assert.deepEqual(calc('=UPPER({"a","b"})'), [['A', 'B']]);
});

test('dates are serial numbers like Google Sheets', () => {
  assert.equal(serialFromParts(1899, 12, 31), 1);
  assert.equal(calc('=DATE(2026,1,31)'), serialFromParts(2026, 1, 31));
  assert.equal(calc('=DATE(2026,13,1)'), serialFromParts(2027, 1, 1));
  assert.equal(calc('=YEAR(DATE(2026,7,4))'), 2026); assert.equal(calc('=MONTH("2026-07-04")'), 7); assert.equal(calc('=DAY(DATE(2026,7,4))'), 4);
  assert.equal(calc('=WEEKDAY(DATE(2026,11,25))'), 4); assert.equal(calc('=WEEKDAY(DATE(2026,11,25),2)'), 3);
  assert.equal(calc('=EDATE(DATE(2026,1,31),1)'), serialFromParts(2026, 2, 28));
  assert.equal(calc('=EOMONTH(DATE(2024,1,15),1)'), serialFromParts(2024, 2, 29));
  assert.equal(calc('=DATEDIF(DATE(2020,5,10),DATE(2026,5,9),"Y")'), 5);
  assert.equal(calc('=DATEDIF(DATE(2026,1,1),DATE(2026,3,15),"M")'), 2);
  assert.equal(calc('=DATEDIF(DATE(2026,1,1),DATE(2026,3,15),"D")'), 73);
  assert.equal(calc('=NETWORKDAYS(DATE(2026,11,23),DATE(2026,11,29))'), 5);
  assert.equal(calc('=NETWORKDAYS(DATE(2026,11,23),DATE(2026,11,29),DATE(2026,11,24))'), 4);
  assert.equal(calc('=WORKDAY(DATE(2026,11,27),1)'), serialFromParts(2026, 11, 30));
  assert.equal(calc('=DAYS(DATE(2026,12,25),DATE(2026,11,25))'), 30);
  assert.equal(calc('=TODAY()'), Math.floor(calc('=NOW()')));
  assert.equal(calc('=HOUR(TIME(13,45,10))'), 13); assert.equal(calc('=MINUTE("13:45")'), 45);
  assert.equal(calc('=DATEVALUE("2026-02-03")'), serialFromParts(2026, 2, 3));
});

test('array formulas spill: UNIQUE, SORT, FILTER, SEQUENCE, TRANSPOSE, ARRAYFORMULA', () => {
  const wb = book([['Fruit', 'Qty'], ['pear', 3], ['apple', 5], ['pear', 1], ['fig', 9]], [
    { op: 'set', range: 'D1', formula: '=UNIQUE(A2:A5)' },
    { op: 'set', range: 'E1', formula: '=SORT(A2:B5,2,FALSE)' },
    { op: 'set', range: 'H1', formula: '=FILTER(A2:A5,B2:B5>2)' },
    { op: 'set', range: 'J1', formula: '=SEQUENCE(2,3,10,5)' },
    { op: 'set', range: 'A10', formula: '=ARRAYFORMULA(B2:B5*2)' },
    { op: 'set', range: 'C10', formula: '=SUM(A10:A13)' },
  ]);
  const e = engine(wb);
  const v = (a) => { const m = /^([A-Z]+)(\d+)$/.exec(a); return e.value('s1', Number(m[2]) - 1, colIndex(m[1])); };
  assert.deepEqual(['D1', 'D2', 'D3', 'D4'].map(v), ['pear', 'apple', 'fig', null]);
  assert.deepEqual(['E1', 'F1', 'E2', 'F4'].map(v), ['fig', 9, 'apple', 1]);
  assert.deepEqual(['H1', 'H2', 'H3'].map(v), ['pear', 'apple', 'fig']);
  assert.deepEqual(['J1', 'K1', 'L1', 'J2', 'L2'].map(v), [10, 15, 20, 25, 35]);
  assert.equal(v('C10'), 36);
  assert.deepEqual(e.spillOf('s1', 0, 3), { origin: [0, 3], size: [3, 1] });
  // a spill that would overwrite data becomes #REF!
  const blocked = run(wb, [{ op: 'set', range: 'D3', value: 'x' }]);
  const b = engine(blocked);
  assert.equal(b.value('s1', 0, 3).code, '#REF!');
  assert.match(b.value('s1', 0, 3).message, /overwrite data in D3/);
  assert.deepEqual(calc('=TRANSPOSE({1,2,3})'), [[1], [2], [3]]);
  assert.equal(calc('=FILTER({1,2},{FALSE,FALSE})').code, '#N/A');
});

test('cross-sheet references, named ranges and sheet renames', () => {
  let wb = book([[1], [2], [3]], [
    { op: 'sheet_add', name: 'Data 2' },
    { op: 'set', sheet: 'Data 2', range: 'A1', values: [[10], [20]] },
    { op: 'set', sheet: 'Sheet1', range: 'B1', formula: "=SUM('Data 2'!A1:A2)+A1" },
    { op: 'name_set', name: 'Scores', range: 'Sheet1!A1:A3' },
    { op: 'set', sheet: 'Sheet1', range: 'B2', formula: '=AVERAGE(Scores)' },
  ]);
  assert.equal(val(wb, 'B1'), 31); assert.equal(val(wb, 'B2'), 2);
  wb = run(wb, [{ op: 'sheet_rename', sheet: 'Data 2', name: 'Inputs' }]);
  assert.equal(wb.sheets[0].cells.B1.f, '=SUM(Inputs!A1:A2)+A1');
  assert.equal(val(wb, 'B1'), 31);
  wb = run(wb, [{ op: 'sheet_delete', sheet: 'Inputs' }]);
  assert.equal(wb.sheets[0].cells.B1.f, '=SUM(#REF!)+A1');
  assert.equal(val(wb, 'B1').code, '#REF!');
  assert.equal(calc('=SUM(Nope!A1)').code, '#REF!');
  assert.equal(calc('=Unknown+1').code, '#NAME?');
});

test('circular references are detected and every cell in the loop is marked', () => {
  const wb = book([[]], [{ op: 'set', range: 'A1', formula: '=B1+1' }, { op: 'set', range: 'B1', formula: '=A1*2' }, { op: 'set', range: 'C1', formula: '=A1' }, { op: 'set', range: 'D1', formula: '=D1' }]);
  const e = engine(wb);
  assert.equal(e.value('s1', 0, 0).code, '#CIRCULAR!');
  assert.equal(e.value('s1', 0, 1).code, '#CIRCULAR!');
  assert.equal(e.value('s1', 0, 2).code, '#CIRCULAR!');
  assert.equal(e.value('s1', 0, 3).code, '#CIRCULAR!');
  assert.equal(e.isCircular('s1', 0, 0), true);
  assert.ok(checkWorkbook(wb, e).some((w) => w.includes('#CIRCULAR!')));
});

test('incremental recalculation matches a full recalculation', () => {
  let wb = book([[1, '=A1*2', '=B1+A2'], [5, '=SUM(A1:A3)', '=C1*B2'], [7]], [{ op: 'set', range: 'D1', formula: '=SEQUENCE(A1+1)' }, { op: 'set', range: 'E1', formula: '=SUM(D1:D5)' }]);
  let e = engine(wb);
  assert.equal(e.value('s1', 0, 4), 3);
  for (const [cell, v] of [['A1', 3], ['A2', -2], ['A3', 'x'], ['A1', 1], ['B2', '=A1+A3']]) {
    const r = applyOps(wb, [{ op: 'set', range: cell, value: v }]);
    assert.equal(r.error, undefined);
    const inc = e.update(r.workbook, r.touched);
    const full = new Engine(r.workbook, { now: NOW });
    for (const a of ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'D3', 'D4', 'E1']) {
      const m = /^([A-Z]+)(\d+)$/.exec(a);
      const x = inc.value('s1', Number(m[2]) - 1, colIndex(m[1])), y = full.value('s1', Number(m[2]) - 1, colIndex(m[1]));
      assert.deepEqual(x?.code ?? x, y?.code ?? y, `${a} after setting ${cell}=${v}`);
    }
    wb = r.workbook; e = inc;
  }
});

test('typed input is parsed like Google Sheets and gets an automatic format', () => {
  assert.deepEqual(parseInput('1,234.5'), { value: 1234.5, format: '#,##0.00' });
  assert.deepEqual(parseInput('12%'), { value: 0.12, format: '0%' });
  assert.deepEqual(parseInput('$1,200.50'), { value: 1200.5, format: '$#,##0.00' });
  assert.deepEqual(parseInput('฿99'), { value: 99, format: '฿#,##0' });
  assert.equal(parseInput('2026-11-25').value, serialFromParts(2026, 11, 25));
  assert.equal(parseInput('25/11/2026').format, 'd/m/yyyy');
  assert.ok(Math.abs(parseInput('13:30').value - 13.5 / 24) < 1e-9);
  assert.equal(parseInput('true').value, true);
  assert.equal(parseInput("'00123").value, '00123');
  assert.equal(parseInput('00123').value, 123);
  assert.equal(parseInput('hello').value, 'hello');
  const wb = book([['2026-01-05', '15%', 'abc']]);
  assert.equal(wb.sheets[0].cells.A1.s.nf, 'yyyy-mm-dd');
  assert.equal(engine(wb).display('s1', 0, 0).text, '2026-01-05');
  assert.equal(engine(wb).display('s1', 0, 1).text, '15%');
});

test('number formats: decimals, thousands, percent, currency, negatives, dates, text and colours', () => {
  const f = (v, p) => formatValue(v, p).text;
  assert.equal(f(1234.567, '#,##0.00'), '1,234.57'); assert.equal(f(0.5, '0%'), '50%'); assert.equal(f(-5, '#,##0.00;(#,##0.00)'), '(5.00)');
  assert.equal(f(-5, '0.0'), '-5.0'); assert.equal(f(3, '000'), '003'); assert.equal(f(1234567, '0.00E+00'), '1.23E+06');
  assert.equal(f(1500, '$#,##0'), '$1,500'); assert.equal(f(0, '0;-0;"zero"'), 'zero');
  assert.equal(formatValue(-3, '0;[Red]-0').color, '#d93025');
  assert.equal(f(serialFromParts(2026, 3, 9, 14, 5, 7), 'yyyy-mm-dd hh:mm:ss'), '2026-03-09 14:05:07');
  assert.equal(f(serialFromParts(2026, 3, 9, 14, 5), 'h:mm AM/PM'), '2:05 PM');
  assert.equal(f(serialFromParts(2026, 3, 9), 'mmm d, yyyy'), 'Mar 9, 2026');
  assert.equal(f(1.5, '[h]:mm'), '36:00');
  assert.equal(f('abc', '"Name: "@'), 'Name: abc');
  assert.equal(f(1 / 3), '0.3333333333');
  assert.equal(f(1e20), '1.00E+20');
});

test('inserting and deleting rows and columns rewrites formulas, merges, validation and charts', () => {
  let wb = book([[1, 2], [3, 4], [5, 6]], [
    { op: 'set', range: 'C1', formula: '=SUM(A1:A3)' }, { op: 'set', range: 'C2', formula: '=A3*$B$3' },
    { op: 'merge', range: 'D1:E1' }, { op: 'validation', range: 'A1:A3', type: 'number', rule: 'gt', min: 0 },
    { op: 'chart_add', type: 'line', range: 'A1:B3', anchor: 'G2' },
  ]);
  wb = run(wb, [{ op: 'insert_rows', at: 2, count: 2 }]);
  const s = wb.sheets[0];
  assert.equal(s.cells.C1.f, '=SUM(A1:A5)'); assert.equal(s.cells.C4.f, '=A5*$B$5');
  assert.equal(s.cells.A4.v, 3); assert.equal(s.validations[0].range, 'A1:A5'); assert.equal(s.charts[0].range, 'A1:B5'); assert.equal(s.charts[0].anchor, 'G4');
  assert.equal(val(wb, 'C1'), 9);
  wb = run(wb, [{ op: 'delete_rows', at: 5 }]);
  assert.equal(wb.sheets[0].cells.C4.f, '=#REF!*#REF!');
  assert.equal(wb.sheets[0].cells.C1.f, '=SUM(A1:A4)');
  wb = run(wb, [{ op: 'insert_cols', at: 'A' }]);
  assert.equal(wb.sheets[0].cells.D1.f, '=SUM(B1:B4)');
  assert.deepEqual(wb.sheets[0].merges, ['E1:F1']);
  wb = run(wb, [{ op: 'delete_cols', at: 'B' }]);
  assert.equal(wb.sheets[0].cells.C1.f, '=SUM(#REF!)');
});

test('copy shifts relative references, move keeps references pointing at the moved cells', () => {
  let wb = book([[1, 10], [2, 20]], [{ op: 'set', range: 'C1', formula: '=A1+$B$1' }, { op: 'set', range: 'D1', formula: '=SUM(A1:A2)' }]);
  wb = run(wb, [{ op: 'copy', from: 'C1', to: 'C2' }]);
  assert.equal(wb.sheets[0].cells.C2.f, '=A2+$B$1');
  assert.equal(val(wb, 'C2'), 12);
  wb = run(wb, [{ op: 'copy', from: 'C1', to: 'E5:E6' }]);
  assert.equal(wb.sheets[0].cells.E6.f, '=C6+$B$1');
  wb = run(wb, [{ op: 'move', from: 'A1:A2', to: 'H1' }]);
  assert.equal(wb.sheets[0].cells.D1.f, '=SUM(H1:H2)');
  assert.equal(wb.sheets[0].cells.C1.f, '=H1+$B$1');
  assert.equal(val(wb, 'D1'), 3);
  wb = run(wb, [{ op: 'copy', from: 'H1:H2', to: 'J1', transpose: true }]);
  assert.deepEqual([wb.sheets[0].cells.J1.v, wb.sheets[0].cells.K1.v], [1, 2]);
  wb = run(wb, [{ op: 'copy', from: 'D1', to: 'L1', paste: 'values' }]);
  assert.equal(wb.sheets[0].cells.L1.v, 3); assert.equal(wb.sheets[0].cells.L1.f, undefined);
});

test('the fill handle continues series and copies formulas', () => {
  let wb = book([[1, 'Item 1', 'Jan', 'Monday', '2026-01-30', 5], [3]], [{ op: 'set', range: 'G1', formula: '=A1*2' }]);
  wb = run(wb, [{ op: 'fill', from: 'A1:A2', to: 'A1:A5' }, { op: 'fill', from: 'B1:G1', to: 'B1:G4' }]);
  const s = wb.sheets[0].cells;
  assert.deepEqual([s.A3.v, s.A4.v, s.A5.v], [5, 7, 9]);
  assert.deepEqual([s.B2.v, s.B4.v], ['Item 2', 'Item 4']);
  assert.deepEqual([s.C2.v, s.C4.v], ['Feb', 'Apr']);
  assert.deepEqual([s.D2.v, s.D3.v], ['Tuesday', 'Wednesday']);
  assert.equal(s.E2.v, serialFromParts(2026, 1, 31));
  assert.deepEqual([s.F2.v, s.F3.v], [5, 5]);
  assert.equal(s.G3.f, '=A3*2');
  wb = run(wb, [{ op: 'fill', from: 'A1:A2', to: 'D10:D10' }].slice(0, 0));
  assert.equal(typeof seriesValues, 'function');
  const bad = applyOps(wb, [{ op: 'fill', from: 'A1', to: 'C3:D9' }]);
  assert.match(bad.error, /extend/);
});

test('sorting, filtering, duplicates, trim, split and find & replace', () => {
  let wb = book([['Name', 'Score'], ['cara', 7], ['Abe', 9], ['bea', 7], ['Abe', 9], ['  dan  ', 2]]);
  wb = run(wb, [{ op: 'sort', range: 'A1:B6', header: true, by: [{ col: 'B', desc: true }, { col: 'A' }] }]);
  assert.deepEqual(rangeText(wb.sheets[0], { r1: 1, c1: 0, r2: 5, c2: 0 }, engine(wb)).flat(), ['Abe', 'Abe', 'bea', 'cara', '  dan  ']);
  wb = run(wb, [{ op: 'remove_duplicates', range: 'A1:B6', header: true }, { op: 'trim', range: 'A:A' }]);
  assert.equal(wb.sheets[0].cells.A6, undefined);
  assert.equal(wb.sheets[0].cells.A5.v, 'dan');
  wb = run(wb, [{ op: 'filter', range: 'A1:B5' }, { op: 'filter_set', col: 'B', condition: { type: 'gte', value: 7 } }]);
  assert.deepEqual([...filterHiddenRows(wb.sheets[0], engine(wb))], [4]);
  wb = run(wb, [{ op: 'filter_set', col: 'A', hide: ['bea'] }]);
  assert.deepEqual([...filterHiddenRows(wb.sheets[0], engine(wb))].sort(), [2, 4]);
  wb = run(wb, [{ op: 'find_replace', find: 'a', replace: 'A', match_case: true }]);
  assert.equal(wb.sheets[0].cells.A3.v, 'beA');
  wb = run(wb, [{ op: 'set', range: 'D1', value: 'x;y;z' }, { op: 'split', range: 'D1', delimiter: ';' }]);
  assert.deepEqual([wb.sheets[0].cells.D1.v, wb.sheets[0].cells.F1.v], ['x', 'z']);
});

test('formats, borders, merges, notes, freeze, sizes and hidden rows', () => {
  let wb = book([['Title'], [1.5]]);
  wb = run(wb, [
    { op: 'format', range: 'A1', bold: true, italic: true, size: 14, color: '#ff0000', fill: '#ffff00', align: 'center', wrap: true },
    { op: 'format', range: 'A2', number: 'percent' }, { op: 'border', range: 'A1:B2', where: 'outer', style: 'thick', color: '#333333' },
    { op: 'merge', range: 'A1:B1' }, { op: 'note', cell: 'A2', text: 'Check this' }, { op: 'freeze', rows: 1, cols: 1 },
    { op: 'col_width', from: 'A', size: 150 }, { op: 'row_height', from: 1, size: 40 }, { op: 'hide_rows', from: 5, to: 6 }, { op: 'hide_cols', from: 'C' },
  ]);
  const s = wb.sheets[0];
  assert.deepEqual(s.cells.A1.s, { b: true, i: true, fs: 14, color: '#ff0000', fill: '#ffff00', ha: 'center', wrap: 'wrap', bt: 'thick #333333', bl: 'thick #333333' });
  assert.equal(s.cells.B2.s.br, 'thick #333333'); assert.equal(s.cells.B2.s.bb, 'thick #333333');
  assert.equal(engine(wb).display('s1', 1, 0).text, '150.00%');
  assert.deepEqual(s.merges, ['A1:B1']); assert.equal(s.cells.A2.note, 'Check this');
  assert.deepEqual([s.frozenRows, s.frozenCols, s.colW[0], s.rowH[0]], [1, 1, 150, 40]);
  assert.deepEqual(s.hiddenRows, [4, 5]); assert.deepEqual(s.hiddenCols, [2]);
  const bad = applyOps(wb, [{ op: 'format', range: 'A1', color: 'not a colour!' }]);
  assert.match(bad.error, /op 1 \(format\): color/);
  assert.equal(bad.workbook, wb);
});

test('data validation: lists, number rules, checkboxes and range lists', () => {
  let wb = book([['Status', 'Qty', 'Done'], ['Open', 5, true], ['Bogus', -1, 'x']], [
    { op: 'validation', range: 'A2:A9', type: 'list', values: ['Open', 'Closed'] },
    { op: 'validation', range: 'B2:B9', type: 'number', rule: 'between', min: 0, max: 10 },
    { op: 'validation', range: 'C2:C9', type: 'checkbox' },
    { op: 'sheet_add', name: 'Lists' }, { op: 'set', sheet: 'Lists', range: 'A1', values: [['red'], ['green']] },
    { op: 'validation', sheet: 'Sheet1', range: 'D2:D9', type: 'range', source: 'Lists!A1:A2' },
  ]);
  const s = wb.sheets[0];
  assert.equal(s.cells.C4.v, false, 'a checkbox range fills empty cells with FALSE');
  const e = engine(wb);
  assert.equal(validate(wb, s, validationAt(s, 1, 0), 'open', e), null);
  assert.match(validate(wb, s, validationAt(s, 2, 0), 'Bogus', e), /Choose one of/);
  assert.match(validate(wb, s, validationAt(s, 2, 1), -1, e), /between 0 and 10/);
  assert.match(validate(wb, s, validationAt(s, 2, 2), 'x', e), /TRUE or FALSE/);
  assert.equal(validate(wb, s, validationAt(s, 2, 3), 'green', e), null);
  const review = checkWorkbook(wb, e);
  assert.ok(review.some((w) => w.includes('A3') && w.includes('list rule')));
});

test('pivot summaries are live formulas', () => {
  let wb = book([['Region', 'Product', 'Units'], ['North', 'A', 10], ['South', 'B', 5], ['North', 'B', 7], ['East', 'A', 3]]);
  wb = run(wb, [{ op: 'pivot', source: 'A1:C5', rows: 'A', values: [{ col: 'C', fn: 'sum' }, { col: 'C', fn: 'count' }], target: 'Summary!A1' }]);
  const sum = wb.sheets.find((s) => s.name === 'Summary');
  assert.ok(sum);
  const e = engine(wb);
  const grid = rangeText(sum, { r1: 0, c1: 0, r2: 4, c2: 2 }, e);
  assert.deepEqual(grid, [['Region', 'SUM of Units', 'COUNT of Units'], ['East', '3', '1'], ['North', '17', '2'], ['South', '5', '1'], ['Grand total', '25', '4']]);
  wb = run(wb, [{ op: 'set', range: 'C2', value: 20 }]);
  assert.equal(engine(wb).display(sum.id, 2, 1).text, '27');
  const two = run(book([['R', 'P', 'U'], ['N', 'A', 1], ['N', 'B', 2], ['S', 'A', 4]]), [{ op: 'pivot', source: 'A1:C4', rows: 'A', columns: 'B', values: [{ col: 'C', fn: 'sum' }], target: 'F1' }]);
  assert.deepEqual(rangeText(two.sheets[0], { r1: 0, c1: 5, r2: 3, c2: 7 }, engine(two)), [['R', 'SUM of U · A', 'SUM of U · B'], ['N', '1', '2'], ['S', '4', '0'], ['Grand total', '5', '2']]);
});

test('sheets: add, duplicate, move, colour, hide and protect the last visible one', () => {
  let wb = run(emptyWorkbook(), [{ op: 'sheet_add', name: 'Two' }, { op: 'sheet_duplicate', sheet: 'Two' }, { op: 'sheet_move', sheet: 'Copy of Two', to: 1 }, { op: 'sheet_set', sheet: 'Two', color: '#34a853', hidden: true }]);
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Copy of Two', 'Sheet1', 'Two']);
  assert.equal(wb.sheets[2].hidden, true); assert.equal(wb.sheets[2].color, '#34a853');
  assert.match(applyOps(wb, [{ op: 'sheet_add', name: 'sheet1' }]).error, /already exists/);
  assert.match(applyOps(wb, [{ op: 'sheet_rename', sheet: 'Sheet1', name: 'a/b' }]).error, /cannot/);
  const one = run(emptyWorkbook(), []);
  assert.match(applyOps(one, [{ op: 'sheet_delete', sheet: 'Sheet1' }]).error, /at least one visible sheet/);
});

test('conditional formats, banding and charts are stored with ids', () => {
  const wb = book([['a', 1], ['b', 5]], [
    { op: 'cond_format', range: 'B1:B2', type: 'gt', value: 3, style: { fill: '#ff0000' } },
    { op: 'cond_format', range: 'B1:B2', type: 'scale', colors: ['#ffffff', '#00ff00'] },
    { op: 'cond_format', range: 'A1:B2', type: 'formula', value: '$B1>3' },
    { op: 'banding', range: 'A1:B2', odd: '#ffffff', even: '#eeeeee' },
    { op: 'chart_add', type: 'pie', range: 'A1:B2', title: 'Share', headers: false },
  ]);
  const s = wb.sheets[0];
  assert.deepEqual(s.condFormats.map((c) => c.type), ['gt', 'scale', 'formula']);
  assert.equal(s.condFormats[2].value, '=$B1>3');
  assert.equal(s.charts[0].type, 'pie'); assert.equal(s.charts[0].anchor, 'D1'); assert.equal(s.charts[0].headers, false);
  assert.match(applyOps(wb, [{ op: 'cond_format', range: 'A1', type: 'scale', colors: ['#fff'] }]).error, /2 or 3/);
  assert.match(applyOps(wb, [{ op: 'chart_add', type: 'line' }]).error, /data range/);
});

test('CSV and TSV round trips', () => {
  const grid = parseDelimited('name,note\r\n"Smith, J","He said ""hi"""\nx,\n');
  assert.deepEqual(grid, [['name', 'note'], ['Smith, J', 'He said "hi"'], ['x', '']]);
  assert.equal(toDelimited(grid), 'name,note\r\n"Smith, J","He said ""hi"""\r\nx,');
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
});

test('files are normalised, repaired and summarised for agents', () => {
  const { workbook, warnings } = normalizeWorkbook({ title: 'X', sheets: [{ id: 's1', name: 'A', cells: { A1: { v: 1 }, B1: { f: '=A1*2' }, ZZ: { v: 3 }, C1: { v: 'x', s: { b: true, color: 'javascript:alert(1)' } } } }, { id: 's1', name: 'a' }] });
  assert.equal(workbook.sheets.length, 2); assert.notEqual(workbook.sheets[1].id, 's1'); assert.equal(workbook.sheets[1].name, 'a (2)');
  assert.ok(warnings.length >= 1);
  assert.equal(workbook.sheets[0].cells.ZZ, undefined); assert.equal(workbook.sheets[0].cells.C1.s.color, undefined);
  const again = parseWorkbookJson(serializeWorkbook(workbook)).workbook;
  assert.deepEqual(again, workbook);
  assert.match(parseWorkbookJson('not json').warnings[0], /not valid JSON/);
  const e = engine(workbook);
  assert.match(summarizeWorkbook(workbook, e), /A \[s1\].*2 formula|1 formulas/);
  assert.match(readRange(workbook.sheets[0], { r1: 0, c1: 0, r2: 0, c2: 2 }, e), /A1=1 \| B1=2 ‹=A1\*2› \| C1=x/);
});

test('review warnings: numbers stored as text, typed constants and odd formulas', () => {
  const wb = book([["'1200", 1, 2], ['', 3, 4], ['', 5, 6], ['', 7, 8]], [
    { op: 'set', range: 'D2', formula: '=B2*C2' }, { op: 'fill', from: 'D2', to: 'D2:D4' }, { op: 'set', range: 'D1', formula: '=B1+C1' },
    { op: 'set', range: 'E1', formula: '=B1*1.07' },
  ]);
  const review = checkWorkbook(wb, engine(wb));
  assert.ok(review.some((w) => /numbers stored as text in A1/.test(w)), review.join('\n'));
  assert.ok(review.some((w) => /numbers typed inside formulas/.test(w)));
  assert.ok(review.some((w) => /D1 differ/.test(w)), review.join('\n'));
  assert.equal(relativeForm('=B2*$C$2', 1, 3), relativeForm('=B3*$C$2', 2, 3));
});

test('the function library is broad and documented', () => {
  for (const name of ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'SUMIF', 'SUMIFS', 'AVERAGEIF', 'AVERAGEIFS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'MOD', 'POWER', 'SQRT', 'PRODUCT', 'INT', 'RAND', 'RANDBETWEEN',
    'IF', 'IFS', 'AND', 'OR', 'NOT', 'IFERROR', 'IFNA', 'SWITCH', 'VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'CONCAT', 'CONCATENATE', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'UPPER', 'LOWER', 'PROPER', 'TRIM', 'SUBSTITUTE', 'SPLIT', 'TEXT', 'VALUE', 'FIND', 'SEARCH', 'REGEXMATCH', 'REGEXREPLACE',
    'TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'EDATE', 'EOMONTH', 'DATEDIF', 'NETWORKDAYS', 'UNIQUE', 'SORT', 'FILTER', 'SEQUENCE', 'ARRAYFORMULA', 'MEDIAN', 'STDEV', 'VAR', 'LARGE', 'SMALL', 'RANK', 'PMT', 'FV', 'NPV']) {
    assert.ok(FUNCTIONS[name], `${name} is implemented`);
    assert.ok(FUNCTIONS[name].syntax.startsWith(name) || FUNCTIONS[name].syntax.includes('('), name);
  }
  assert.ok(FUNCTION_NAMES.length >= 170, `${FUNCTION_NAMES.length} functions`);
});

test('finance functions match the spreadsheet formulas', () => {
  const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
  near(calc('=PMT(0.05/12,360,300000)'), -1610.464869);
  near(calc('=FV(0.06/12,120,-200)'), 32775.87, 0.01);
  near(calc('=PV(0.08/12,60,-500)'), 24659.22, 0.01);
  near(calc('=NPV(0.1,-1000,300,400,500)'), -19.1244, 0.001);
  near(calc('=IRR({-1000,300,400,500})'), 0.0889633947, 1e-6);
  near(calc('=NPER(0.01,-100,1000)'), 10.588, 0.001);
  near(calc('=RATE(36,-300,9000)'), 0.0102074, 1e-6);
  near(calc('=IPMT(0.1/12,1,36,8000)'), -66.6667, 1e-3);
  near(calc('=PPMT(0.1/12,1,36,8000)') + calc('=IPMT(0.1/12,1,36,8000)'), calc('=PMT(0.1/12,36,8000)'));
  near(calc('=SLN(10000,1000,5)'), 1800);
});

test('templates build without errors and the budget adds up', () => {
  for (const kind of ['budget', 'sales', 'tasks']) {
    const wb = run(emptyWorkbook(), templateOps(kind));
    assert.deepEqual(engine(wb).errors(), [], kind);
  }
  const budget = run(emptyWorkbook(), templateOps('budget'));
  const e = engine(budget);
  assert.equal(e.value('s1', 10, 2), 1500 + 655 + 210 + 188 + 276 + 1000 + 140);
  assert.equal(e.display('s1', 10, 4).text, '76.3%');
  assert.equal(e.value('s1', 13, 2), 5200 - 3969);
  assert.equal(budget.sheets[0].charts.length, 1);
  assert.deepEqual(parseOps('x').errors, ['ops must be an array of {op: …} objects']);
});

test('shift and transform helpers keep absolute parts and text', () => {
  assert.equal(shiftFormula('=A1+$B$2+B$3+$C4+"A1"', 2, 1), '=B3+$B$2+C$3+$C6+"A1"');
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(transformRefs('=SUM(A:A)', (r) => ({ ...r, c1: 2, c2: 2 })), '=SUM(C:C)');
});
