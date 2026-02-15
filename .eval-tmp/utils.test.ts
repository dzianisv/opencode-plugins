// utils.test.ts

import { add } from './utils';

describe('add function', () => {
  test('adds two positive numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  test('adds two negative numbers', () => {
    expect(add(-2, -3)).toBe(-5);
  });

  test('adds a positive and a negative number', () => {
    expect(add(2, -3)).toBe(-1);
  });

  test('adds zero and a number', () => {
    expect(add(0, 5)).toBe(5);
    expect(add(0, -5)).toBe(-5);
  });
});