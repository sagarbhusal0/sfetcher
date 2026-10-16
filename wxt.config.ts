import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Sfetcher — Media Downloader',
    description:
      'Free, local-first media detector and downloader: direct files, HLS VOD and DASH VOD.',
    version: '0.3.0',
    permissions: ['storage', 'downloads', 'activeTab', 'scripting', 'webRequest', 'offscreen'],
    content_security_policy: {
      // Single-threaded ffmpeg.wasm core runs from chrome-extension:// URLs.
      // 'wasm-unsafe-eval' permits local WASM compilation; no remote code.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval';",
    },
    optional_host_permissions: ['<all_urls>'],
    host_permissions: [],
    action: {
      default_title: 'Sfetcher',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: { alias: { '@': resolve('./src') } },
  }),
});
