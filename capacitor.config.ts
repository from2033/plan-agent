import type { CapacitorConfig } from "@capacitor/cli";

// 原生 iOS 壳配置。Web 资源打进 app 本地（capacitor://localhost），
// 只有 API/WS 走远程后端（见 .env.native 的 VITE_API_BASE）。
// 注意：webDir 指向原生专用构建产物 dist-native（base '/'、无 PWA），
// 不要用同源部署的 dist（base '/app/'）。
const config: CapacitorConfig = {
  appId: "com.from2033.assistant",
  appName: "Personal Assistant",
  webDir: "dist-native",
  ios: {
    // 允许内联播放、不要求用户手势才能播放媒体（语音/提示用）。
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
