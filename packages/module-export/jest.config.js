/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\.tsx?$': ['ts-jest', {
      tsconfig: { module: 'CommonJS', moduleResolution: 'Node' },
      useESM: false,
    }],
  },
  moduleNameMapper: { '^(\.{1,2}/.*)\.js$': '$1' },
};
