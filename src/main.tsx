
import { createRoot } from "react-dom/client";

async function mount(): Promise<void> {
  if (import.meta.env.MODE === "native") {
    await import("./styles/index.css");
    const { default: App } = await import("./app/App.tsx");
    createRoot(document.getElementById("root")!).render(<App />);
    return;
  }
  // 清理旧网页 App 留下的 PWA worker/cache，避免 /app 被离线缓存继续打开。
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then((items) => Promise.all(items.map((item) => item.unregister())));
  }
  if ("caches" in window) {
    void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
  }
  const { default: DesktopIntakeApp } = await import("./app/DesktopIntakeApp.tsx");
  createRoot(document.getElementById("root")!).render(<DesktopIntakeApp />);
}

void mount();
