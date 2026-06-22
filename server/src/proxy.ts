// 若设置了 PROXY_URL，则让 Node 全局 fetch（含 Anthropic SDK）走该 HTTP 代理。
// 用于中国大陆服务器经本地代理客户端访问 api.anthropic.com。
import { setGlobalDispatcher, ProxyAgent } from "undici";

const proxyUrl = process.env.PROXY_URL;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[proxy] 出站请求走代理: ${proxyUrl}`);
  // 预热：本地代理客户端首次连接常失败，启动时先打几枪建立隧道（忽略结果）。
  const warm = () =>
    fetch("https://api.anthropic.com/v1/models", { method: "GET" }).catch(() => {});
  (async () => {
    for (let i = 0; i < 3; i++) {
      await warm();
    }
    console.log("[proxy] 代理预热完成");
  })();
}
