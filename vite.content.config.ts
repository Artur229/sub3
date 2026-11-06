import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Chrome content scripts are classic scripts, so all imports must be bundled.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    cssCodeSplit: true,
    lib: {
      entry: fileURLToPath(new URL('./src/content/content-script.ts', import.meta.url)),
      formats: ['iife'],
      name: 'Sub3ContentScript',
      fileName: () => 'content-script.js'
    },
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
