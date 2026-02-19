// utils.test.ts

import { add } from './utils';

describe('add', () => {
    it('should add two positive numbers', () => {
        expect(add(2, 3)).toBe(5);
    });

    it('should add a positive and a negative number', () => {
        expect(add(10, -5)).toBe(5);
    });

    it('should add two negative numbers', () => {
        expect(add(-4, -6)).toBe(-10);
    });

    it('should return the second number when the first is zero', () => {
        expect(add(0, 7)).toBe(7);
    });

    it('should return the first number when the second is zero', () => {
        expect(add(7, 0)).toBe(7);
    });
});