import { greet } from "./greeter";

test("greet function returns correct greeting", () => {
    const name = "John";
    const expectedGreeting = "Hello, John!";

    expect(greet(name)).toBe(expectedGreeting);
});