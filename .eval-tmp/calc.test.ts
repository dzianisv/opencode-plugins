// Test the divide function from calc.ts
import { divide } from './calc';

describe('divide function', () => {
    test('divides two positive numbers', () => {
        expect(divide(6, 2)).toBe(3);
    });

    test('handles division by zero', () => {
        expect(() => divide(6, 0)).toThrow("Division by zero is not allowed.");
    });

    test('divides a positive and a negative number', () => {
        expect(divide(6, -2)).toBe(-3);
    });

    test('divides two negative numbers', () => {
        expect(divide(-6, -2)).toBe(3);
    });

    test('returns 0 when numerator is 0', () => {
        expect(divide(0, 7)).toBe(0);
    });
});