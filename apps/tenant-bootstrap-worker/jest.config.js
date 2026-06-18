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
    '^@oweibo/core-contracts$': '<rootDir>/../../packages/core-contracts/src/index.ts',
    // F.5/F.7: the worker now imports from @oweibo/core-engine
    // (withTenantScope + outbox stream types) and @oweibo/observability
    // (withServiceSpan in BootstrapWorker). Map to TS source so jest
    // resolves without a separate dist build step.
    '^@oweibo/core-engine$': '<rootDir>/../../packages/core-engine/src/index.ts',
    '^@oweibo/observability$': '<rootDir>/../../packages/observability/src/index.ts',
  },
};
