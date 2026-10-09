import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'cloud-client': ['@supabase/supabase-js'],
          scheduler: ['ts-fsrs'],
        },
      },
    },
  },
  test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'supabase/tests/**/*.test.ts'], environment: 'node' },
});
