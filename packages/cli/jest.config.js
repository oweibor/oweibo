/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        // Node16 module mode is incompatible with Jest's CJS runner.
        // Override to CommonJS for the test build only; production build
        // still uses the project tsconfig with Node16.
        module: 'CommonJS',
        moduleResolution: 'Node',
      },
      useESM: false,
    }],
  },
  // Rewrite .js extension imports to their .ts sources so ts-jest can find them
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
