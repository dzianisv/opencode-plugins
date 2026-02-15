// counter.test.ts

import { Counter } from './counter';

describe('Counter', () => {
  let counter: Counter;

  beforeEach(() => {
    counter = new Counter();
  });

  test('initial count should be zero', () => {
    expect(counter.getCount()).toBe(0);
  });

  test('increment should increase count by 1', () => {
    counter.increment();
    expect(counter.getCount()).toBe(1);
  });

  test('increment should work multiple times', () => {
    counter.increment();
    counter.increment();
    counter.increment();
    expect(counter.getCount()).toBe(3);
  });
});