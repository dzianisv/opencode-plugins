export default {
  testMatch: ["**/*.test.ts"],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  extensionsToTreatAsEsm: ['.ts'],
};