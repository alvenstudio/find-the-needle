import { defineConfig, type Plugin } from 'vite';

/**
 * Answer `/sdk.js` locally.
 *
 * The Yandex Games SDK tag in `index.html` has to be a plain root-relative
 * script - the platform serves that path itself, and bundling a copy or
 * pointing it elsewhere is a rejection. On any other host it 404s, which puts
 * a red line in the console on every reload, and a console with a permanent
 * error in it is a console nobody reads. So in dev we serve an empty file and
 * set the flag the wrapper watches for, which also saves it the four-second
 * wait for a global that is never coming.
 */
function yandexSdkStub(): Plugin {
  return {
    name: 'yandex-sdk-stub',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/sdk.js', (_request, response) => {
        response.setHeader('Content-Type', 'application/javascript');
        response.end('window.__yaSdkMissing = true;');
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [yandexSdkStub()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 2048,
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  preview: { host: '127.0.0.1', port: 5188, strictPort: true },
});
