import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // @oweibo/db is fully mocked in tests; alias prevents Vite from
      // resolving dist/ (which requires prisma generate to exist in CI)
      '@oweibo/db': path.resolve(__dirname, 'src/__stubs__/db.ts'),
    },
  },
});
