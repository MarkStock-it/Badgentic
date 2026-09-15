import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js', 'tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 15000,
  },
});
