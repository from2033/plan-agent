import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { unzipSync } from "fflate";

import { decField, encField, encryptBuffer } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const FINANCE_UPLOAD_DIR = process.env.FINANCE_UPLOAD_DIR
  || path.join(path.dirname(path.resolve(DB_PATH)), "finance-uploads");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS finance_imports (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    source          TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    archive_file    TEXT NOT NULL,
    period_start    TEXT,
    period_end      TEXT,
    row_count       INTEGER NOT NULL,
    inserted_count  INTEGER NOT NULL,
    updated_count   INTEGER NOT NULL,
    duplicate_count INTEGER NOT NULL,
    imported_at     TEXT NOT NULL,
    UNIQUE(user_id, source, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_finance_imports_user
    ON finance_imports(user_id, imported_at DESC);

  CREATE TABLE IF NOT EXISTS finance_transactions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    source            TEXT NOT NULL,
    dedupe_key        TEXT NOT NULL,
    record_hash       TEXT NOT NULL,
    external_id       TEXT NOT NULL,
    merchant_order_id TEXT,
    created_at        TEXT NOT NULL,
    paid_at           TEXT,
    modified_at       TEXT,
    origin            TEXT,
    transaction_type  TEXT,
    counterparty      TEXT,
    item_name         TEXT,
    amount            TEXT NOT NULL,
    direction         TEXT NOT NULL,
    status            TEXT NOT NULL,
    service_fee       TEXT,
    refunded_amount   TEXT,
    note              TEXT,
    fund_status       TEXT,
    category          TEXT NOT NULL,
    import_id         TEXT NOT NULL,
    UNIQUE(user_id, source, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS idx_finance_transactions_user_created
    ON finance_transactions(user_id, created_at DESC);
`);

export interface ParsedFinanceTransaction {
  externalId: string;
  merchantOrderId: string;
  createdAt: string;
  paidAt: string;
  modifiedAt: string;
  origin: string;
  transactionType: string;
  counterparty: string;
  itemName: string;
  amount: number;
  direction: string;
  status: string;
  serviceFee: number;
  refundedAmount: number;
  note: string;
  fundStatus: string;
  category: string;
}

export interface ParsedAlipayBill {
  accountLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  transactions: ParsedFinanceTransaction[];
}

export interface FinanceImportResult {
  importId: string;
  alreadyImported: boolean;
  source: "alipay";
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  insertedCount: number;
  updatedCount: number;
  duplicateCount: number;
  importedAt: string;
}

export interface FinanceOverview {
  rangeMonths: number;
  periodStart: string | null;
  periodEnd: string | null;
  summary: {
    netExpense: number;
    grossExpense: number;
    refunds: number;
    income: number;
    paymentCount: number;
    activeDays: number;
    averagePayment: number;
    averageActiveDay: number;
  };
  categories: Array<{ category: string; amount: number; share: number; count: number }>;
  monthlyTrend: Array<{ month: string; amount: number; count: number }>;
  topCounterparties: Array<{ name: string; amount: number; count: number }>;
  insights: string[];
  recentTransactions: Array<{
    id: string;
    createdAt: string;
    counterparty: string;
    itemName: string;
    amount: number;
    refundedAmount: number;
    category: string;
    status: string;
  }>;
  imports: FinanceImportResult[];
}

interface FinanceTransactionRow {
  id: string;
  record_hash: string;
  external_id: string;
  merchant_order_id: string | null;
  created_at: string;
  paid_at: string | null;
  modified_at: string | null;
  origin: string | null;
  transaction_type: string | null;
  counterparty: string | null;
  item_name: string | null;
  amount: string;
  direction: string;
  status: string;
  service_fee: string | null;
  refunded_amount: string | null;
  note: string | null;
  fund_status: string | null;
  category: string;
}

interface FinanceImportRow {
  id: string;
  source: string;
  file_name: string;
  content_hash: string;
  archive_file: string;
  period_start: string | null;
  period_end: string | null;
  row_count: number;
  inserted_count: number;
  updated_count: number;
  duplicate_count: number;
  imported_at: string;
}

function clean(value: string | undefined): string {
  return String(value || "").replace(/^\uFEFF/, "").replace(/\t/g, "").trim();
}

function money(value: string | undefined): number {
  const parsed = Number(clean(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isoShanghai(value: string): string {
  const normalized = clean(value);
  if (!normalized) return "";
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  return match ? `${match[1]}T${match[2]}+08:00` : normalized;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => clean(value))) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => clean(value))) rows.push(row);
  }
  return rows;
}

function extractCsv(fileName: string, content: Buffer): Buffer {
  const isZip = fileName.toLowerCase().endsWith(".zip")
    || (content[0] === 0x50 && content[1] === 0x4b);
  if (!isZip) return content;
  const files = unzipSync(new Uint8Array(content));
  const csvName = Object.keys(files).find((name) => name.toLowerCase().endsWith(".csv"));
  if (!csvName) throw new Error("支付宝压缩包中没有 CSV 账单");
  return Buffer.from(files[csvName]);
}

function decodeCsv(content: Buffer): string {
  const utf8 = new TextDecoder("utf-8").decode(content);
  if (utf8.includes("交易号") && !utf8.includes("�")) return utf8;
  return new TextDecoder("gb18030").decode(content);
}

const CATEGORY_RULES: Array<{ category: string; pattern: RegExp }> = [
  { category: "餐饮外卖", pattern: /外卖|餐饮|餐厅|饭店|小吃|火锅|烧烤|面馆|粉丝汤|馄饨|锅贴|咖啡|茶饮|奶茶|瑞幸|星巴克|肯德基|麦当劳|饿了么/ },
  { category: "交通出行", pattern: /停车|地铁|公交|滴滴|高德打车|出租车|网约车|加油|充电桩|高速|铁路|火车|机票|航空|出行/ },
  { category: "医疗健康", pattern: /药房|药店|医院|医疗|诊所|体检|挂号|保健|健康/ },
  { category: "生活缴费", pattern: /物业|水费|电费|燃气|宽带|话费|通信|移动|联通|电信|有线电视/ },
  { category: "日用商超", pattern: /超市|便利店|屈臣氏|无印良品|MUJI|百货|生鲜|小象|盒马|苏果|永辉|沃尔玛|山姆/ },
  { category: "个人护理", pattern: /理发|美容|美发|洗浴|足疗|按摩|护理|美甲/ },
  { category: "教育学习", pattern: /学校|教育|培训|课程|书店|图书|文具|学费|考试/ },
  { category: "娱乐休闲", pattern: /电影|影院|游戏|演出|门票|乐园|KTV|视频会员|音乐会员/ },
  { category: "数码订阅", pattern: /Apple|苹果|App Store|云服务|软件|订阅|会员服务|充值中心/ },
  { category: "网络购物", pattern: /淘宝|天猫|京东|拼多多|抖音|快手|闲鱼|唯品会|闪购/ },
  { category: "转账往来", pattern: /转账|红包|收款|付款码|亲情卡|代付/ },
];

export function classifyFinanceTransaction(transaction: Pick<
  ParsedFinanceTransaction,
  "counterparty" | "itemName" | "transactionType" | "direction"
>): string {
  if (transaction.direction === "收入") return "收入";
  const searchable = `${transaction.counterparty} ${transaction.itemName} ${transaction.transactionType}`;
  return CATEGORY_RULES.find((rule) => rule.pattern.test(searchable))?.category || "其他消费";
}

export function parseAlipayBill(fileName: string, content: Buffer): ParsedAlipayBill {
  const text = decodeCsv(extractCsv(fileName, content));
  const headerMatch = /^交易号\s*,/m.exec(text);
  if (!headerMatch || headerMatch.index == null) throw new Error("未识别到支付宝交易明细表头");
  const tableText = text.slice(headerMatch.index).split(/^[-]{20,}\s*$/m)[0];
  const rows = parseCsvRows(tableText);
  const headers = rows.shift()?.map(clean) || [];
  const column = (name: string): number => headers.indexOf(name);
  const required = ["交易号", "交易创建时间", "金额（元）", "收/支", "交易状态"];
  if (required.some((name) => column(name) < 0)) throw new Error("支付宝账单缺少必要字段");

  const transactions = rows.flatMap((row): ParsedFinanceTransaction[] => {
    const value = (name: string): string => clean(row[column(name)]);
    const externalId = value("交易号");
    if (!externalId) return [];
    const transaction: ParsedFinanceTransaction = {
      externalId,
      merchantOrderId: value("商家订单号"),
      createdAt: isoShanghai(value("交易创建时间")),
      paidAt: isoShanghai(value("付款时间")),
      modifiedAt: isoShanghai(value("最近修改时间")),
      origin: value("交易来源地"),
      transactionType: value("类型"),
      counterparty: value("交易对方"),
      itemName: value("商品名称"),
      amount: money(value("金额（元）")),
      direction: value("收/支"),
      status: value("交易状态"),
      serviceFee: money(value("服务费（元）")),
      refundedAmount: money(value("成功退款（元）")),
      note: value("备注"),
      fundStatus: value("资金状态"),
      category: "其他消费",
    };
    transaction.category = classifyFinanceTransaction(transaction);
    return [transaction];
  });

  const account = text.match(/^账号:\[(.+?)\]/m)?.[1]?.trim() || "";
  const range = text.match(/^起始日期:\[(.+?)\]\s+终止日期:\[(.+?)\]/m);
  return {
    accountLabel: account,
    periodStart: range?.[1] ? isoShanghai(range[1]) : transactions.at(-1)?.createdAt || null,
    periodEnd: range?.[2] ? isoShanghai(range[2]) : transactions[0]?.createdAt || null,
    transactions,
  };
}

function transactionDedupeKey(transaction: ParsedFinanceTransaction): string {
  const stable = transaction.externalId || [
    transaction.merchantOrderId,
    transaction.createdAt,
    transaction.amount.toFixed(2),
    transaction.direction,
    transaction.counterparty,
    transaction.itemName,
  ].join("|");
  return sha256(`alipay:${stable}`);
}

function transactionRecordHash(transaction: ParsedFinanceTransaction): string {
  return sha256(JSON.stringify(transaction));
}

function importRow(row: FinanceImportRow, alreadyImported = false): FinanceImportResult {
  return {
    importId: row.id,
    alreadyImported,
    source: "alipay",
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rowCount: row.row_count,
    insertedCount: row.inserted_count,
    updatedCount: row.updated_count,
    duplicateCount: row.duplicate_count,
    importedAt: row.imported_at,
  };
}

export function importAlipayBill(
  userId: string,
  fileName: string,
  content: Buffer,
): FinanceImportResult {
  const safeName = path.basename(fileName || "alipay-bill.zip").slice(0, 240);
  const contentHash = sha256(content);
  const existingImport = db.prepare(`SELECT * FROM finance_imports
    WHERE user_id=? AND source='alipay' AND content_hash=? LIMIT 1`)
    .get(userId, contentHash) as unknown as FinanceImportRow | undefined;
  if (existingImport) return importRow(existingImport, true);

  const parsed = parseAlipayBill(safeName, content);
  if (!parsed.transactions.length) throw new Error("支付宝账单中没有可导入的交易");
  const importId = crypto.randomUUID();
  const importedAt = new Date().toISOString();
  fs.mkdirSync(FINANCE_UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const archiveFile = path.join(FINANCE_UPLOAD_DIR, `${importId}.paf`);
  fs.writeFileSync(archiveFile, encryptBuffer(content), { mode: 0o600, flag: "wx" });

  const findTransaction = db.prepare(`SELECT id,record_hash FROM finance_transactions
    WHERE user_id=? AND source='alipay' AND dedupe_key=? LIMIT 1`);
  const insertTransaction = db.prepare(`INSERT INTO finance_transactions
    (id,user_id,source,dedupe_key,record_hash,external_id,merchant_order_id,created_at,paid_at,
     modified_at,origin,transaction_type,counterparty,item_name,amount,direction,status,
     service_fee,refunded_amount,note,fund_status,category,import_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateTransaction = db.prepare(`UPDATE finance_transactions SET
    record_hash=?,external_id=?,merchant_order_id=?,created_at=?,paid_at=?,modified_at=?,origin=?,
    transaction_type=?,counterparty=?,item_name=?,amount=?,direction=?,status=?,service_fee=?,
    refunded_amount=?,note=?,fund_status=?,category=?,import_id=? WHERE id=? AND user_id=?`);

  let insertedCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const transaction of parsed.transactions) {
      const dedupeKey = transactionDedupeKey(transaction);
      const recordHash = transactionRecordHash(transaction);
      const existing = findTransaction.get(userId, dedupeKey) as
        | { id: string; record_hash: string }
        | undefined;
      if (existing?.record_hash === recordHash) {
        duplicateCount += 1;
        continue;
      }
      const encrypted = {
        externalId: encField(transaction.externalId),
        merchantOrderId: transaction.merchantOrderId ? encField(transaction.merchantOrderId) : null,
        origin: transaction.origin ? encField(transaction.origin) : null,
        transactionType: transaction.transactionType ? encField(transaction.transactionType) : null,
        counterparty: transaction.counterparty ? encField(transaction.counterparty) : null,
        itemName: transaction.itemName ? encField(transaction.itemName) : null,
        amount: encField(transaction.amount.toFixed(2)),
        serviceFee: encField(transaction.serviceFee.toFixed(2)),
        refundedAmount: encField(transaction.refundedAmount.toFixed(2)),
        note: transaction.note ? encField(transaction.note) : null,
        category: encField(transaction.category),
      };
      if (!existing) {
        insertTransaction.run(
          crypto.randomUUID(), userId, "alipay", dedupeKey, recordHash,
          encrypted.externalId, encrypted.merchantOrderId, transaction.createdAt,
          transaction.paidAt || null, transaction.modifiedAt || null, encrypted.origin,
          encrypted.transactionType, encrypted.counterparty, encrypted.itemName, encrypted.amount,
          transaction.direction, transaction.status, encrypted.serviceFee, encrypted.refundedAmount,
          encrypted.note, transaction.fundStatus || null, encrypted.category, importId,
        );
        insertedCount += 1;
      } else {
        updateTransaction.run(
          recordHash, encrypted.externalId, encrypted.merchantOrderId, transaction.createdAt,
          transaction.paidAt || null, transaction.modifiedAt || null, encrypted.origin,
          encrypted.transactionType, encrypted.counterparty, encrypted.itemName, encrypted.amount,
          transaction.direction, transaction.status, encrypted.serviceFee, encrypted.refundedAmount,
          encrypted.note, transaction.fundStatus || null, encrypted.category, importId,
          existing.id, userId,
        );
        updatedCount += 1;
      }
    }
    db.prepare(`INSERT INTO finance_imports
      (id,user_id,source,file_name,content_hash,archive_file,period_start,period_end,row_count,
       inserted_count,updated_count,duplicate_count,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        importId,
        userId,
        "alipay",
        encField(safeName),
        contentHash,
        archiveFile,
        parsed.periodStart,
        parsed.periodEnd,
        parsed.transactions.length,
        insertedCount,
        updatedCount,
        duplicateCount,
        importedAt,
      );
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no-op */ }
    try { fs.unlinkSync(archiveFile); } catch { /* no-op */ }
    throw error;
  }

  return {
    importId,
    alreadyImported: false,
    source: "alipay",
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    rowCount: parsed.transactions.length,
    insertedCount,
    updatedCount,
    duplicateCount,
    importedAt,
  };
}

function listImports(userId: string): FinanceImportResult[] {
  return (db.prepare(`SELECT * FROM finance_imports WHERE user_id=?
    ORDER BY imported_at DESC LIMIT 20`).all(userId) as unknown as FinanceImportRow[])
    .map((row) => importRow(row));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function monthCutoff(months: number): string {
  const now = new Date();
  const shanghai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const cutoff = new Date(shanghai.getFullYear(), shanghai.getMonth() - months + 1, 1);
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-01`;
}

function readableTransaction(row: FinanceTransactionRow): ParsedFinanceTransaction & { id: string } {
  return {
    id: row.id,
    externalId: decField(row.external_id),
    merchantOrderId: row.merchant_order_id ? decField(row.merchant_order_id) : "",
    createdAt: row.created_at,
    paidAt: row.paid_at || "",
    modifiedAt: row.modified_at || "",
    origin: row.origin ? decField(row.origin) : "",
    transactionType: row.transaction_type ? decField(row.transaction_type) : "",
    counterparty: row.counterparty ? decField(row.counterparty) : "",
    itemName: row.item_name ? decField(row.item_name) : "",
    amount: money(decField(row.amount)),
    direction: row.direction,
    status: row.status,
    serviceFee: row.service_fee ? money(decField(row.service_fee)) : 0,
    refundedAmount: row.refunded_amount ? money(decField(row.refunded_amount)) : 0,
    note: row.note ? decField(row.note) : "",
    fundStatus: row.fund_status || "",
    category: decField(row.category),
  };
}

export function getFinanceOverview(userId: string, requestedMonths = 3): FinanceOverview {
  const rangeMonths = Math.max(1, Math.min(24, Math.round(requestedMonths || 3)));
  const cutoff = monthCutoff(rangeMonths);
  const rows = db.prepare(`SELECT * FROM finance_transactions
    WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 20000`)
    .all(userId, cutoff) as unknown as FinanceTransactionRow[];
  const transactions = rows.map(readableTransaction);
  const successfulExpenses = transactions.filter((transaction) =>
    transaction.direction === "支出" && /^(交易成功|支付成功)$/.test(transaction.status));
  const closedExpenses = transactions.filter((transaction) =>
    transaction.direction === "支出" && /关闭/.test(transaction.status));
  const netAmount = (transaction: ParsedFinanceTransaction): number =>
    Math.max(0, transaction.amount - transaction.refundedAmount);
  const netExpense = roundMoney(successfulExpenses.reduce((sum, item) => sum + netAmount(item), 0));
  const grossExpense = roundMoney(
    [...successfulExpenses, ...closedExpenses].reduce((sum, item) => sum + item.amount, 0),
  );
  const refunds = roundMoney(
    [...successfulExpenses, ...closedExpenses].reduce((sum, item) => sum + item.refundedAmount, 0),
  );
  const income = roundMoney(transactions
    .filter((item) => item.direction === "收入" && /成功/.test(item.status))
    .reduce((sum, item) => sum + item.amount, 0));
  const activeDays = new Set(successfulExpenses.map((item) => item.createdAt.slice(0, 10))).size;

  const categoryMap = new Map<string, { amount: number; count: number }>();
  const monthMap = new Map<string, { amount: number; count: number }>();
  const counterpartyMap = new Map<string, { amount: number; count: number }>();
  for (const transaction of successfulExpenses) {
    const value = netAmount(transaction);
    const category = categoryMap.get(transaction.category) || { amount: 0, count: 0 };
    category.amount += value;
    category.count += 1;
    categoryMap.set(transaction.category, category);
    const monthKey = transaction.createdAt.slice(0, 7);
    const month = monthMap.get(monthKey) || { amount: 0, count: 0 };
    month.amount += value;
    month.count += 1;
    monthMap.set(monthKey, month);
    const counterpartyName = transaction.counterparty || "未标明商户";
    const counterparty = counterpartyMap.get(counterpartyName) || { amount: 0, count: 0 };
    counterparty.amount += value;
    counterparty.count += 1;
    counterpartyMap.set(counterpartyName, counterparty);
  }
  const categories = [...categoryMap.entries()]
    .map(([category, value]) => ({
      category,
      amount: roundMoney(value.amount),
      share: netExpense ? Math.round((value.amount / netExpense) * 1000) / 1000 : 0,
      count: value.count,
    }))
    .sort((left, right) => right.amount - left.amount);
  const monthlyTrend = [...monthMap.entries()]
    .map(([month, value]) => ({ month, amount: roundMoney(value.amount), count: value.count }))
    .sort((left, right) => left.month.localeCompare(right.month));
  const topCounterparties = [...counterpartyMap.entries()]
    .map(([name, value]) => ({ name, amount: roundMoney(value.amount), count: value.count }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 8);

  const insights: string[] = [];
  const topCategory = categories[0];
  if (topCategory) {
    insights.push(`「${topCategory.category}」是这段时间最大的消费板块，占净支出的 ${(topCategory.share * 100).toFixed(0)}%。`);
  }
  const smallPayments = successfulExpenses.filter((item) => netAmount(item) > 0 && netAmount(item) < 50);
  if (smallPayments.length) {
    const share = successfulExpenses.length
      ? Math.round((smallPayments.length / successfulExpenses.length) * 100)
      : 0;
    insights.push(`50 元以下的小额支付有 ${smallPayments.length} 笔，占成功支付的 ${share}%；频率比单笔金额更值得持续观察。`);
  }
  const frequent = [...counterpartyMap.entries()]
    .sort((left, right) => right[1].count - left[1].count)[0];
  if (frequent) {
    insights.push(`最常出现的交易对方是「${frequent[0]}」，共 ${frequent[1].count} 笔，合计 ¥${roundMoney(frequent[1].amount).toFixed(2)}。`);
  }
  if (monthlyTrend.length >= 2) {
    const previous = monthlyTrend.at(-2)!;
    const latest = monthlyTrend.at(-1)!;
    const difference = roundMoney(latest.amount - previous.amount);
    const direction = difference >= 0 ? "增加" : "减少";
    insights.push(`${latest.month} 的净支出较 ${previous.month} ${direction} ¥${Math.abs(difference).toFixed(2)}；若月份尚未结束，应把它视为阶段性变化。`);
  }

  return {
    rangeMonths,
    periodStart: transactions.at(-1)?.createdAt || null,
    periodEnd: transactions[0]?.createdAt || null,
    summary: {
      netExpense,
      grossExpense,
      refunds,
      income,
      paymentCount: successfulExpenses.length,
      activeDays,
      averagePayment: successfulExpenses.length ? roundMoney(netExpense / successfulExpenses.length) : 0,
      averageActiveDay: activeDays ? roundMoney(netExpense / activeDays) : 0,
    },
    categories,
    monthlyTrend,
    topCounterparties,
    insights,
    recentTransactions: successfulExpenses.slice(0, 20).map((transaction) => ({
      id: transaction.id,
      createdAt: transaction.createdAt,
      counterparty: transaction.counterparty,
      itemName: transaction.itemName,
      amount: transaction.amount,
      refundedAmount: transaction.refundedAmount,
      category: transaction.category,
      status: transaction.status,
    })),
    imports: listImports(userId),
  };
}

export function deleteFinanceAccountData(userId: string): void {
  const archives = db.prepare("SELECT archive_file FROM finance_imports WHERE user_id=?")
    .all(userId) as unknown as Array<{ archive_file: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM finance_transactions WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM finance_imports WHERE user_id=?").run(userId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no-op */ }
    throw error;
  }
  for (const archive of archives) {
    try { fs.unlinkSync(archive.archive_file); } catch { /* already absent */ }
  }
}
