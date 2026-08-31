import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


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
// 其余 mode 只构建电脑资料投递台；不注册 PWA，避免旧网页 App 被缓存。
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
