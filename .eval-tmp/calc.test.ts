import { divide } from "./calc";

describe("divide function", () => {
  it("should return the correct quotient for valid numbers", () => {
    expect(divide(6, 2)).toBe(3);
    expect(divide(9, 3)).toBe(3);
  });

  it("should throw an error when dividing by zero", () => {
    expect(() => divide(5, 0)).toThrow("Division by zero is not allowed.");
  });
});