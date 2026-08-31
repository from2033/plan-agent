import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { strToU8, zipSync } from "fflate";

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-finance-test-"));
process.env.DB_PATH = path.join(temporaryDir, "data.db");
process.env.FINANCE_UPLOAD_DIR = path.join(temporaryDir, "finance-uploads");
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const {
  deleteFinanceAccountData,
  getFinanceCategoryTransactions,
  getFinanceOverview,
  importAlipayBill,
  parseAlipayBill,
} = await import("../src/finance.js");

const header = [
  "交易号", "商家订单号", "交易创建时间", "付款时间", "最近修改时间", "交易来源地",
  "类型", "交易对方", "商品名称", "金额（元）", "收/支", "交易状态", "服务费（元）",
  "成功退款（元）", "备注", "资金状态", "",
].join(",");

function row(values: string[]): string {
  return [...values, ""].join(",");
}

function csv(rows: string[]): string {
  return [
    "支付宝交易记录明细查询",
    "账号:[owner@example.com]",
    "起始日期:[2026-06-01 00:00:00]    终止日期:[2026-08-31 23:59:59]",
    "---------------------------------交易记录明细列表------------------------------------",
    header,
    ...rows,
    "------------------------------------------------------------------------------------",
    `共${rows.length}笔记录`,
  ].join("\r\n");
}

function billZip(rows: string[]): Buffer {
  return Buffer.from(zipSync({ "alipay-record.csv": strToU8(csv(rows)) }));
}

const initialRows = [
  row(["A1", "O1", "2026-08-01 12:00:00", "2026-08-01 12:00:01", "2026-08-02 10:00:00", "支付宝", "即时到账交易", "美团", "午餐外卖", "100.00", "支出", "交易成功", "0.00", "20.00", "", "已支出"]),
  row(["A2", "O2", "2026-08-02 18:00:00", "2026-08-02 18:00:01", "2026-08-02 18:00:01", "支付宝", "即时到账交易", "停车场", "停车缴费", "30.00", "支出", "支付成功", "0.00", "0.00", "", "已支出"]),
  row(["A3", "O3", "2026-08-03 09:00:00", "2026-08-03 09:00:01", "2026-08-04 09:00:01", "支付宝", "即时到账交易", "淘宝", "网购退款", "50.00", "支出", "交易关闭", "0.00", "50.00", "", "已支出"]),
  row(["R1", "O3", "2026-08-04 09:00:00", "", "2026-08-04 09:00:01", "支付宝", "即时到账交易", "淘宝", "退款", "70.00", "不计收支", "退款成功", "0.00", "0.00", "", "已收入"]),
  row(["I1", "O4", "2026-08-05 10:00:00", "2026-08-05 10:00:01", "2026-08-05 10:00:01", "支付宝", "即时到账交易", "客户", "收款", "200.00", "收入", "交易成功", "0.00", "0.00", "", "已收入"]),
  row(["T1", "O6", "2026-08-05 11:00:00", "2026-08-05 11:00:01", "2026-08-05 11:00:01", "支付宝", "即时到账交易", "支付宝小荷包(备用)", "支付宝小荷包-转入", "500.00", "支出", "交易成功", "0.00", "0.00", "", "已支出"]),
];

test("支付宝 ZIP 账单可解析、分类，并按交易号增量去重", () => {
  const firstFile = billZip(initialRows);
  const parsed = parseAlipayBill("支付宝账单.zip", firstFile);
  assert.equal(parsed.transactions.length, 6);
  assert.equal(parsed.transactions[0]?.category, "餐饮外卖");
  assert.equal(parsed.transactions[1]?.category, "交通出行");

  const first = importAlipayBill("owner", "支付宝账单.zip", firstFile);
  assert.equal(first.insertedCount, 6);
  assert.equal(first.updatedCount, 0);
  assert.equal(first.duplicateCount, 0);
  assert.equal(fs.readdirSync(process.env.FINANCE_UPLOAD_DIR!).length, 1);

  const repeated = importAlipayBill("owner", "支付宝账单.zip", firstFile);
  assert.equal(repeated.alreadyImported, true);
  assert.equal(fs.readdirSync(process.env.FINANCE_UPLOAD_DIR!).length, 1);

  const initialOverview = getFinanceOverview("owner", 12);
  assert.equal(initialOverview.summary.netExpense, 110);
  assert.equal(initialOverview.summary.grossExpense, 180);
  assert.equal(initialOverview.summary.refunds, 70);
  assert.equal(initialOverview.summary.income, 200);
  assert.equal(initialOverview.summary.transfersOut, 500);
  assert.equal(initialOverview.summary.paymentCount, 2);

  const overlapRows = [
    initialRows[0]!,
    row(["A2", "O2", "2026-08-02 18:00:00", "2026-08-02 18:00:01", "2026-08-10 18:00:01", "支付宝", "即时到账交易", "停车场", "停车缴费", "35.00", "支出", "支付成功", "0.00", "0.00", "", "已支出"]),
    row(["A4", "O5", "2026-08-06 11:00:00", "2026-08-06 11:00:01", "2026-08-06 11:00:01", "支付宝", "即时到账交易", "社区药房", "购药", "40.00", "支出", "交易成功", "0.00", "0.00", "", "已支出"]),
  ];
  const second = importAlipayBill("owner", "支付宝账单-增量.zip", billZip(overlapRows));
  assert.equal(second.insertedCount, 1);
  assert.equal(second.updatedCount, 1);
  assert.equal(second.duplicateCount, 1);

  const updatedOverview = getFinanceOverview("owner", 12);
  assert.equal(updatedOverview.summary.netExpense, 155);
  assert.equal(updatedOverview.summary.paymentCount, 3);
  assert.equal(updatedOverview.categories.find((item) => item.category === "医疗健康")?.amount, 40);

  const other = importAlipayBill("other", "支付宝账单.zip", firstFile);
  assert.equal(other.insertedCount, 6);
  assert.equal(getFinanceOverview("other", 12).summary.netExpense, 110);
  assert.equal(getFinanceOverview("owner", 12).summary.netExpense, 155);

  deleteFinanceAccountData("owner");
  assert.equal(getFinanceOverview("owner", 12).summary.netExpense, 0);
  assert.equal(getFinanceOverview("other", 12).summary.netExpense, 110);
});

test("可按分类取得账单明细，供 Agent 回答具体消费问题", () => {
  const digitalRows = [
    row(["D1", "DO1", "2026-08-17 07:48:18", "2026-08-17 07:48:19", "2026-08-17 07:48:19", "支付宝", "即时到账交易", "Yuansfer Inc", "App Store & iTunes US - Pockyt GiftCard", "135.37", "支出", "交易成功", "0.00", "0.00", "", "已支出"]),
    row(["D2", "DO2", "2026-08-18 07:48:18", "2026-08-18 07:48:19", "2026-08-18 07:48:19", "支付宝", "即时到账交易", "Apple", "软件订阅", "20.00", "支出", "交易关闭", "0.00", "0.00", "", "已支出"]),
  ];
  importAlipayBill("digital-owner", "数码账单.zip", billZip(digitalRows));
  const details = getFinanceCategoryTransactions("digital-owner", "数码订阅", 24);
  assert.equal(details.length, 1);
  assert.equal(details[0]?.itemName, "App Store & iTunes US - Pockyt GiftCard");
  assert.equal(getFinanceCategoryTransactions("other-owner", "数码订阅", 24).length, 0);
});

test.after(() => {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});
