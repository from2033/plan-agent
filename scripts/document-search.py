#!/usr/bin/env python3
"""Build and query a private FTS5 index for the local Obsidian family vault."""

import argparse
import json
import os
import re
import sqlite3
from pathlib import Path


def frontmatter_value(text: str, key: str, default: str = "") -> str:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*(.+?)\s*$", text)
    if not match:
        return default
    raw = match.group(1)
    try:
        value = json.loads(raw)
        return str(value) if value is not None else default
    except json.JSONDecodeError:
        return raw.strip(' "')


def note_body(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            return text[end + 5 :].strip()
    return text.strip()


def connect(index_path: Path) -> sqlite3.Connection:
    index_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    connection = sqlite3.connect(str(index_path))
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS documents (
          path TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          body TEXT NOT NULL,
          mtime_ns INTEGER NOT NULL,
          byte_size INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          path UNINDEXED,
          document_id UNINDEXED,
          title,
          category,
          body,
          tokenize='trigram'
        );
        """
    )
    try:
        os.chmod(index_path, 0o600)
    except OSError:
        pass
    return connection


def refresh_index(connection: sqlite3.Connection, vault: Path) -> None:
    notes_root = vault / "资料"
    note_paths = sorted(notes_root.rglob("*.md")) if notes_root.exists() else []
    live_paths = set()
    for note_path in note_paths:
        relative = note_path.relative_to(vault).as_posix()
        live_paths.add(relative)
        stat = note_path.stat()
        current = connection.execute(
            "SELECT mtime_ns, byte_size FROM documents WHERE path=?", (relative,)
        ).fetchone()
        if current == (stat.st_mtime_ns, stat.st_size):
            continue
        text = note_path.read_text(encoding="utf-8", errors="replace")
        title = frontmatter_value(text, "title", note_path.stem)
        category = frontmatter_value(text, "category", note_path.parent.name)
        document_id = frontmatter_value(text, "document_id")
        body = note_body(text)
        connection.execute("DELETE FROM documents_fts WHERE path=?", (relative,))
        connection.execute("DELETE FROM documents WHERE path=?", (relative,))
        connection.execute(
            "INSERT INTO documents VALUES (?,?,?,?,?,?,?)",
            (relative, document_id, title, category, body, stat.st_mtime_ns, stat.st_size),
        )
        connection.execute(
            "INSERT INTO documents_fts(path,document_id,title,category,body) VALUES (?,?,?,?,?)",
            (relative, document_id, title, category, body),
        )
    stored_paths = {
        row[0] for row in connection.execute("SELECT path FROM documents").fetchall()
    }
    for removed in stored_paths - live_paths:
        connection.execute("DELETE FROM documents_fts WHERE path=?", (removed,))
        connection.execute("DELETE FROM documents WHERE path=?", (removed,))
    connection.commit()


def compact_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def trigrams(question: str):
    compact = re.sub(r"[^0-9A-Za-z\u3400-\u9fff]+", "", question)
    seen = set()
    values = []
    for index in range(max(0, len(compact) - 2)):
        value = compact[index : index + 3]
        if value not in seen:
            seen.add(value)
            values.append(value)
    return values[:40]


def meaningful_characters(question: str):
    compact = re.sub(r"[^0-9A-Za-z\u3400-\u9fff]+", "", question)
    noise = set("的了呢吗嘛啊呀吧是有在和与跟把被给从到里中上下一些那些这个那个一个怎么什么干嘛请问想要知道帮我查开的过")
    return {character for character in compact if character not in noise}


def excerpt(body: str, grams) -> str:
    compact = compact_text(body)
    positions = [compact.find(gram) for gram in grams if gram in compact]
    center = min(positions) if positions else 0
    start = max(0, center - 240)
    end = min(len(compact), start + 1400)
    prefix = "…" if start else ""
    suffix = "…" if end < len(compact) else ""
    return prefix + compact[start:end] + suffix


def search(connection: sqlite3.Connection, question: str, limit: int):
    grams = trigrams(question)
    rows = []
    if grams:
        match_query = " OR ".join('"' + gram.replace('"', '""') + '"' for gram in grams)
        rows = connection.execute(
            """
            SELECT path,document_id,title,category,body,
                   bm25(documents_fts,0.0,0.0,8.0,3.0,1.0) AS rank
            FROM documents_fts
            WHERE documents_fts MATCH ?
            ORDER BY rank
            LIMIT 30
            """,
            (match_query,),
        ).fetchall()
    by_path = {row[0]: row for row in rows}
    # Speech recognition often changes one character in a person's name, and
    # natural questions use words such as “药品” while a note says “药物”. Add a
    # bounded character-overlap fallback; the answering model remains the final
    # evidence check, so weak matches cannot become unsupported facts.
    for row in connection.execute(
        "SELECT path,document_id,title,category,body,0.0 FROM documents ORDER BY mtime_ns DESC LIMIT 500"
    ).fetchall():
        by_path.setdefault(row[0], row)
    meaningful = meaningful_characters(question)
    scored = []
    for path, document_id, title, category, body, rank in by_path.values():
        haystack = f"{title} {category} {body}"
        matches = sum(1 for gram in grams if gram in haystack)
        title_matches = sum(1 for gram in grams if gram in title)
        category_matches = sum(1 for gram in grams if gram in category)
        character_matches = sum(1 for character in meaningful if character in haystack)
        if matches == 0 and character_matches < min(2, max(1, len(meaningful))):
            continue
        score = matches * 10 + title_matches * 25 + category_matches * 12 + character_matches * 8 - float(rank)
        scored.append(
            {
                "documentId": document_id,
                "title": title,
                "category": category,
                "vaultPath": path,
                "excerpt": excerpt(body, grams),
                "score": round(score, 4),
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--limit", type=int, default=6)
    args = parser.parse_args()
    vault = Path(args.vault).expanduser().resolve()
    connection = connect(vault / ".assistant" / "document-index.db")
    try:
        refresh_index(connection, vault)
        print(json.dumps(search(connection, args.question, max(1, min(args.limit, 10))), ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
