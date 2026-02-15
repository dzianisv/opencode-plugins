import { greet } from './greeter';

describe('greet', () => {
    it('should return a greeting message for the given name', () => {
        expect(greet('Alice')).toBe('Hello, Alice!');
        expect(greet('Bob')).toBe('Hello, Bob!');
    });
});