export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^opencode$': '<rootDir>/test/mocks/opencodeMock.js'
  },
  globals: {
    'ts-jest': {
      useESM: true
    }
  },
  transform: {
    '^.+\.ts$': 'ts-jest'
  }
};