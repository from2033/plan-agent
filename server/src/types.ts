// 与前端 src/app/App.tsx 的 Entry 接口保持一致（timestamp 在 API 上用 ISO 字符串）。

export type EntryType = "activity" | "expense" | "memo" | "wish";
export type Priority = "low" | "medium" | "high";

export interface Entry {
  id: string;
  type: EntryType;
  raw: string;
  time: string; // 显示用 'HH:MM'
  timeRange?: { start: string; end: string };
  description: string;
  category: string;
  amount?: number;
  currency?: string;
  priority?: Priority;
  done?: boolean;
  reminderAt?: string; // ISO 8601，备忘到点提醒
  timestamp: string; // ISO 8601
}

// Claude / 正则解析产出的部分（不含 id / time / timestamp，由后端生成）。
export type ParsedFields = Pick<
  Entry,
  "type" | "description" | "category" | "amount" | "currency" | "timeRange" | "priority"
> & { date?: string; reminderTime?: string };

// 知识库条目（长期参考型知识，独立于日常 entries）。
export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  timestamp: string; // ISO 8601
}
