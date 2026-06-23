import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

// `--mode native` 构建给 Capacitor iOS 壳用：资源从根加载（base '/'）、
// 输出到 dist-native、不要 service worker（SW 与 capacitor:// scheme 冲突）。
// 其余 mode 走原来的 /app/ + PWA 同源部署。
export default defineConfig(({ mode }) => {
  const isNative = mode === 'native'
  return {
    base: isNative ? '/' : '/app/',
    build: isNative ? { outDir: 'dist-native', emptyOutDir: true } : {},
    plugins: [
      figmaAssetResolver(),
      // The React and Tailwind plugins are both required for Make, even if
      // Tailwind is not being actively used – do not remove them
      react(),
      tailwindcss(),
      // 原生壳不注册 PWA；仅 web 部署启用。
      ...(isNative
        ? []
        : [
            VitePWA({
              registerType: 'autoUpdate',
              includeAssets: ['apple-touch-icon.png', 'favicon.png', 'icon-source.svg'],
              manifest: {
                name: 'Personal Assistant',
                short_name: 'Assistant',
                description:
                  'Records daily activities, expenses, and reminders, organizing data to track habits and boost productivity.',
                theme_color: '#6366f1',
                background_color: '#ffffff',
                display: 'standalone',
                orientation: 'portrait',
                start_url: '/app/',
                scope: '/app/',
                icons: [
                  { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
                  { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
                  {
                    src: 'pwa-512x512.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable',
                  },
                ],
              },
              workbox: {
                globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
                navigateFallback: '/app/index.html',
              },
            }),
          ]),
    ],
    resolve: {
      alias: {
        // Alias @ to the src directory
        '@': path.resolve(__dirname, './src'),
      },
    },

    // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
    assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})
