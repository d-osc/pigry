import test from 'node:test';
import assert from 'node:assert/strict';
import { JQ, VIEWPORT_PRESETS, assertDom, assertValue, deepEqual, expectFn, fmt, makeStub, normCss, parseChainer, runAssertion } from '../src/extensions/e2e/engine/assert.ts';

const el = (over = {}) => ({ tag: 'button', id: 'go', cls: ['btn', 'primary'], text: 'Save', html: 'Save', value: '', vis: true, dis: false, chk: false, sel: false, foc: false, attrs: { type: 'submit', href: '/x' }, css: { 'background-color': 'rgb(37, 99, 235)', 'font-size': '16px' }, empty: false, rect: { x: 0, y: 0, w: 80, h: 30 }, desc: '<button#go.btn.primary>', readOnly: false, required: false, type: 'submit', name: '', ...over });
const dom = (...els) => ({ count: els.length, els });

test('chainers are parsed with negation and filler words', () => {
  assert.deepEqual(parseChainer('not.to.have.text'), { not: true, deep: false, any: false, all: false, own: false, terms: ['text'] });
  assert.deepEqual(parseChainer('deep.equal').terms, ['equal']);
  assert.equal(parseChainer('not.not.exist').not, false);
});

test('DOM assertions: existence, visibility, state, text, attributes, classes, css, length', () => {
  const one = dom(el());
  assert.ok(assertDom(one, 'exist', []).pass);
  assert.ok(assertDom(dom(), 'not.exist', []).pass);
  assert.ok(!assertDom(dom(), 'be.visible', []).pass, 'a missing element is not "visible"');
  assert.ok(assertDom(one, 'be.visible', []).pass);
  assert.ok(assertDom(dom(el({ vis: false })), 'not.be.visible', []).pass);
  assert.ok(assertDom(dom(el({ dis: true })), 'be.disabled', []).pass);
  assert.ok(assertDom(one, 'be.enabled', []).pass);
  assert.ok(assertDom(dom(el({ chk: true })), 'be.checked', []).pass);
  assert.ok(assertDom(one, 'have.text', ['Save']).pass);
  assert.ok(!assertDom(one, 'have.text', ['Sav']).pass);
  assert.ok(assertDom(one, 'contain.text', ['av']).pass);
  assert.ok(assertDom(one, 'have.text', [/^Sa/]).pass);
  assert.match(assertDom(one, 'have.text', ['Other']).message, /expected <button#go.btn.primary> to have text 'Other'/);
  assert.ok(assertDom(dom(el({ value: 'abc' })), 'have.value', ['abc']).pass);
  assert.ok(assertDom(one, 'have.attr', ['type', 'submit']).pass);
  assert.ok(assertDom(one, 'have.attr', ['href']).pass);
  assert.ok(assertDom(one, 'not.have.attr', ['disabled']).pass);
  assert.ok(assertDom(one, 'have.class', ['primary']).pass);
  assert.ok(assertDom(one, 'have.id', ['go']).pass);
  assert.ok(assertDom(one, 'have.css', ['background-color', '#2563eb']).pass, 'hex equals rgb');
  assert.ok(assertDom(one, 'have.css', ['font-size', '16px']).pass);
  assert.ok(assertDom(dom(el(), el()), 'have.length', [2]).pass);
  assert.ok(assertDom(dom(el(), el(), el()), 'have.length.greaterThan', [2]).pass);
  assert.ok(assertDom(dom(el(), el()), 'have.length.lte', [2]).pass);
  assert.ok(assertDom(dom(el({ empty: true })), 'be.empty', []).pass);
});

test('value assertions follow chai', () => {
  assert.ok(assertValue(5, 'eq', [5]).pass);
  assert.ok(assertValue({ a: 1 }, 'deep.equal', [{ a: 1 }]).pass);
  assert.ok(assertValue({ a: 1 }, 'eql', [{ a: 1 }]).pass);
  assert.ok(!assertValue({ a: 1 }, 'equal', [{ a: 1 }]).pass);
  assert.ok(assertValue('hello world', 'include', ['world']).pass);
  assert.ok(assertValue([1, 2, 3], 'include', [2]).pass);
  assert.ok(assertValue([1, 2, 3], 'have.length', [3]).pass);
  assert.ok(assertValue('abc', 'match', [/b/]).pass);
  assert.ok(assertValue(10, 'be.above', [5]).pass);
  assert.ok(assertValue(10, 'be.within', [5, 15]).pass);
  assert.ok(assertValue(null, 'be.null', []).pass);
  assert.ok(assertValue(undefined, 'not.exist', []).pass);
  assert.ok(assertValue('x', 'be.a', ['string']).pass);
  assert.ok(assertValue([], 'be.empty', []).pass);
  assert.ok(assertValue({ a: 1, b: 2 }, 'have.property', ['a', 1]).pass);
  assert.ok(assertValue({ a: 1, b: 2 }, 'have.all.keys', ['a', 'b']).pass);
  assert.ok(assertValue({ calls: [{ args: ['x', 1] }] }, 'have.been.calledWith', ['x']).pass);
  assert.ok(assertValue(5, 'not.equal', [6]).pass);
  assert.equal(assertValue(1, 'nonsense', []).pass, false);
  assert.ok(runAssertion(dom(el()), 'have.text', ['Save']).pass);
  assert.ok(runAssertion('x', 'eq', ['x']).pass);
});

test('expect() builds chai chains and throws on failure', () => {
  expectFn(1).to.equal(1);
  expectFn([1, 2]).to.have.length(2);
  expectFn('abc').to.include('b');
  expectFn({ a: { b: 1 } }).to.deep.equal({ a: { b: 1 } });
  expectFn(5).to.be.above(2);
  void expectFn(true).to.be.true;
  void expectFn(null).to.not.exist;
  expectFn(new JQ(dom(el()))).to.have.text('Save');
  expectFn(new JQ(dom(el(), el()))).to.have.length(2);
  assert.throws(() => expectFn(1).to.equal(2), /expected 1 to equal 2/);
  assert.throws(() => expectFn('a').to.be.a('number'), /to be a number/);
});

test('helpers: formatting, equality, colours, presets, stubs and the jQuery view', () => {
  assert.equal(fmt('x'), "'x'");
  assert.equal(fmt({ a: 1 }), '{"a":1}');
  assert.equal(fmt('y'.repeat(200), 20).length, 20);
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
  assert.equal(normCss('red'), 'rgb(255, 0, 0)');
  assert.equal(normCss('#0f0'), 'rgb(0, 255, 0)');
  assert.equal(normCss('rgba(0,0,0,1)'), 'rgb(0, 0, 0)');
  assert.deepEqual(VIEWPORT_PRESETS['iphone-x'], [375, 812]);
  const s = makeStub().returns(7);
  assert.equal(s(1, 2), 7);
  assert.equal(s.callCount, 1);
  assert.deepEqual(s.calls[0].args, [1, 2]);
  const q = new JQ(dom(el({ value: 'v' }), el({ text: 'Two', cls: ['x'] })));
  assert.equal(q.length, 2);
  assert.equal(q.text(), 'SaveTwo');
  assert.equal(q.eq(1).text(), 'Two');
  assert.equal(q.first().attr('type'), 'submit');
  assert.equal(q.val(), 'v');
  assert.ok(q.first().hasClass('primary'));
  assert.ok(q.is(':visible'));
});
