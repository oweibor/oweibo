/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 30000,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'CommonJS' } }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@oweibo/core-contracts$': '<rootDir>/../core-contracts/src/index.ts',
    '^@oweibo/core-contracts/testing$': '<rootDir>/../core-contracts/src/testing/index.ts',
    // F.7.1: ActionTrustLadder, OutboxRelay, OutboxStreamConsumer
    // import from @oweibo/observability. Mapping to its src/index.ts
    // lets jest resolve without a separate dist build step on CI.
    '^@oweibo/observability$': '<rootDir>/../observability/src/index.ts',
  },
};
