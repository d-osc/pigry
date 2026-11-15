import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { useScopedState } from '../src/hooks/useScopedState.ts';

test('changing request scope clears old results before rendering', () => {
  function Probe() {
    const [step, setStep] = useState(0);
    const scope = step < 2 ? 'first request' : 'second request';
    const [value, setValue] = useScopedState(scope, 0);
    if (step === 0) {
      setValue(10);
      setStep(1);
    } else if (step === 1) {
      assert.equal(value, 10);
      setStep(2);
    } else if (step === 2) {
      assert.equal(value, 0);
      setStep(3);
    } else if (step === 3) {
      setValue(current => current + 1);
      setStep(4);
    }
    return createElement('span', null, value);
  }
  assert.equal(renderToString(createElement(Probe)), '<span>1</span>');
});
