import { defineConfig } from 'vitest/config';

// Relative base so the build works on GitHub Pages (/siffle/) and locally.
export default defineConfig({
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
