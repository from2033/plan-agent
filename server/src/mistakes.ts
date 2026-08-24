import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { decField, decOpt, encField, encOpt } from "./crypto-field.js";

const DB_PATH = process.env.DB_PATH || "./data.db";
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    user_id   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mistakes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    child_name      TEXT NOT NULL,
    subject         TEXT NOT NULL,
    grade           TEXT,
    knowledge_point TEXT,
    problem         TEXT NOT NULL,
    wrong_answer    TEXT,
    correct_answer  TEXT,
    explanation     TEXT,
    error_type      TEXT NOT NULL,
    mastery         TEXT NOT NULL,
    document_id     TEXT,
    review_count    INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mistakes_user_created
    ON mistakes(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mistakes_user_child
    ON mistakes(user_id, child_name, subject);

  CREATE TABLE IF NOT EXISTS mistake_reviews (
    id          TEXT PRIMARY KEY,
    mistake_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    result      TEXT NOT NULL,
    note        TEXT,
    reviewed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mistake_reviews_mistake
    ON mistake_reviews(user_id, mistake_id, reviewed_at DESC);
`);

export type MistakeMastery = "learning" | "review" | "mastered";
export type ReviewResult = "again" | "hard" | "good";

export interface MistakeReview {
  id: string;
  result: ReviewResult;
  note: string;
  reviewedAt: string;
}

export interface Mistake {
  id: string;
  childName: string;
  subject: string;
  grade: string;
  knowledgePoint: string;
  problem: string;
  wrongAnswer: string;
  correctAnswer: string;
  explanation: string;
  errorType: string;
  mastery: MistakeMastery;
  documentId: string | null;
  reviewCount: number;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviews: MistakeReview[];
}

export interface MistakeInput {
  childName: string;
  subject: string;
  grade?: string;
  knowledgePoint?: string;
  problem: string;
  wrongAnswer?: string;
  correctAnswer?: string;
  explanation?: string;
  errorType: string;
  mastery?: MistakeMastery;
  documentId?: string | null;
}

interface MistakeRow {
  id: string;
  child_name: string;
  subject: string;
  grade: string | null;
  knowledge_point: string | null;
  problem: string;
  wrong_answer: string | null;
  correct_answer: string | null;
  explanation: string | null;
  error_type: string;
  mastery: MistakeMastery;
  document_id: string | null;
  review_count: number;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewRow {
  id: string;
  result: ReviewResult;
  note: string | null;
  reviewed_at: string;
}

function listReviews(id: string, userId: string): MistakeReview[] {
  return (db.prepare(`SELECT id,result,note,reviewed_at FROM mistake_reviews
    WHERE mistake_id=? AND user_id=? ORDER BY reviewed_at DESC`).all(id, userId) as unknown as ReviewRow[])
    .map((row) => ({
      id: row.id,
      result: row.result,
      note: decOpt(row.note) || "",
      reviewedAt: row.reviewed_at,
    }));
}

function rowToMistake(row: MistakeRow, userId: string): Mistake {
  return {
    id: row.id,
    childName: decField(row.child_name),
    subject: decField(row.subject),
    grade: decOpt(row.grade) || "",
    knowledgePoint: decOpt(row.knowledge_point) || "",
    problem: decField(row.problem),
    wrongAnswer: decOpt(row.wrong_answer) || "",
    correctAnswer: decOpt(row.correct_answer) || "",
    explanation: decOpt(row.explanation) || "",
    errorType: decField(row.error_type),
    mastery: row.mastery,
    documentId: row.document_id,
    reviewCount: row.review_count,
    lastReviewedAt: row.last_reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviews: listReviews(row.id, userId),
  };
}

export function listMistakes(userId: string): Mistake[] {
  const rows = db.prepare("SELECT * FROM mistakes WHERE user_id=? ORDER BY created_at DESC")
    .all(userId) as unknown as MistakeRow[];
  return rows.map((row) => rowToMistake(row, userId));
}

export function getMistake(id: string, userId: string): Mistake | null {
  const row = db.prepare("SELECT * FROM mistakes WHERE id=? AND user_id=?")
    .get(id, userId) as unknown as MistakeRow | undefined;
  return row ? rowToMistake(row, userId) : null;
}

export function insertMistake(userId: string, input: MistakeInput): Mistake {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mastery = input.mastery || "learning";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO mistakes
      (id,user_id,child_name,subject,grade,knowledge_point,problem,wrong_answer,
        correct_answer,explanation,error_type,mastery,document_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,
        userId,
        encField(input.childName),
        encField(input.subject),
        encOpt(input.grade),
        encOpt(input.knowledgePoint),
        encField(input.problem),
        encOpt(input.wrongAnswer),
        encOpt(input.correctAnswer),
        encOpt(input.explanation),
        encField(input.errorType),
        mastery,
        input.documentId || null,
        now,
        now,
      );
    db.prepare("INSERT INTO knowledge (id,title,content,timestamp,user_id) VALUES (?,?,?,?,?)").run(
      id,
      encField(mistakeKnowledgeTitle(input)),
      encField(mistakeKnowledgeContent(input, mastery, 0)),
      now,
      userId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getMistake(id, userId)!;
}

function mistakeKnowledgeTitle(input: MistakeInput): string {
  return `错题｜${input.childName}｜${input.subject}${input.knowledgePoint ? `｜${input.knowledgePoint}` : ""}`;
}

function mistakeKnowledgeContent(
  input: MistakeInput,
  mastery: MistakeMastery,
  reviewCount: number,
): string {
  const status = mastery === "mastered" ? "已掌握" : mastery === "review" ? "需复习" : "待巩固";
  return [
    `学生：${input.childName}`,
    `年级：${input.grade || "未填写"}`,
    `学科：${input.subject}`,
    `知识点：${input.knowledgePoint || "待整理"}`,
    `题目：${input.problem}`,
    `错误答案：${input.wrongAnswer || "未填写"}`,
    `正确答案：${input.correctAnswer || "未填写"}`,
    `解题说明：${input.explanation || "未填写"}`,
    `错误原因：${input.errorType}`,
    `掌握状态：${status}`,
    `复习次数：${reviewCount}`,
    ...(input.documentId ? [`关联原题资料：${input.documentId}`] : []),
  ].join("\n");
}

export function deleteMistake(id: string, userId: string): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM mistake_reviews WHERE mistake_id=? AND user_id=?").run(id, userId);
    const result = db.prepare("DELETE FROM mistakes WHERE id=? AND user_id=?").run(id, userId);
    if (Number(result.changes) > 0) {
      db.prepare("DELETE FROM knowledge WHERE id=? AND user_id=?").run(id, userId);
    }
    db.exec("COMMIT");
    return Number(result.changes) > 0;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function reviewMistake(
  id: string,
  userId: string,
  result: ReviewResult,
  note = "",
): Mistake | null {
  const existing = getMistake(id, userId);
  if (!existing) return null;
  const now = new Date().toISOString();
  const mastery: MistakeMastery = result === "good" ? "mastered" : result === "hard" ? "review" : "learning";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO mistake_reviews (id,mistake_id,user_id,result,note,reviewed_at)
      VALUES (?,?,?,?,?,?)`).run(crypto.randomUUID(), id, userId, result, encOpt(note), now);
    db.prepare(`UPDATE mistakes SET review_count=review_count+1,last_reviewed_at=?,mastery=?,updated_at=?
      WHERE id=? AND user_id=?`).run(now, mastery, now, id, userId);
    db.prepare("UPDATE knowledge SET title=?,content=? WHERE id=? AND user_id=?").run(
      encField(mistakeKnowledgeTitle(existing)),
      encField(mistakeKnowledgeContent(existing, mastery, existing.reviewCount + 1)),
      id,
      userId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getMistake(id, userId);
}
