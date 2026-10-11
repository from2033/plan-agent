import type { QqSyncStatus } from "./qq-sync-status.js";

export interface AssistantSystemContext {
  topic: string;
  facts: string[];
}

export function assistantSystemContext(qq: QqSyncStatus): AssistantSystemContext[] {
  return [{
    topic: "QQ 群消息同步",
    facts: [
      `当前 QQ 采集状态：${qq.state === "online" ? "在线" : qq.state === "offline" ? "离线" : qq.state === "stale" ? "状态心跳过期" : "未知"}。`,
      "QQ 掉线时监控服务会发送带新登录二维码的告警邮件；持续离线会按冷却时间再次提醒，登录恢复后也会发送恢复通知。",
      "QQ 重新登录成功后，NapCat 会恢复 OneBot 实时事件推送，个人助手会自动继续同步此后新收到的群消息，不需要再手动启动同步。",
      "检测到 QQ 从离线恢复为在线时，系统会自动检查并回放最近 3 天的群消息，复用正常的群白名单、老师过滤、附件处理和去重流程；超出回补窗口或 QQ 接口未返回的消息仍不能保证补齐。",
      "重复收到的同一条消息会按外部消息编号去重，不会因为重新登录而重复创建记录。",
      ...(qq.lastSuccessfulSyncAt ? [`最近一次成功写入个人助手的同步时间：${qq.lastSuccessfulSyncAt}。`] : []),
      ...(qq.lastMessageAt ? [`最近一次已同步群消息的发送时间：${qq.lastMessageAt}。`] : []),
    ],
  }];
}
