import { divide } from "./calc";

describe("divide function", () => {
    it("should return the quotient for valid inputs", () => {
        expect(divide(10, 2)).toBe(5);
        expect(divide(9, 3)).toBe(3);
    });

    it("should throw an error when dividing by zero", () => {
        expect(() => divide(10, 0)).toThrow("Division by zero is not allowed.");
    });

    it("should handle negative numbers", () => {
        expect(divide(-10, 2)).toBe(-5);
        expect(divide(10, -2)).toBe(-5);
    });
});