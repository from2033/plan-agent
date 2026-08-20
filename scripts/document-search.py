#!/usr/bin/env python3
"""Build and query a private hybrid text/vector index for one account vault."""

import argparse
from array import array
import hashlib
import json
import math
import os
import re
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path


VECTOR_INDEX_VERSION = "2026-08-20.1"
QUERY_INSTRUCTION = (
    "Instruct: Given a Chinese personal knowledge-base query, retrieve relevant passages "
    "that answer the query\nQuery: "
)


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
        CREATE TABLE IF NOT EXISTS vector_chunks (
          path TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          document_id TEXT NOT NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          chunk_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          dimension INTEGER NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY(path, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_vector_chunks_model ON vector_chunks(model);
        CREATE TABLE IF NOT EXISTS vector_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        """
    )
    try:
        os.chmod(index_path, 0o600)
    except OSError:
        pass
    return connection


def refresh_text_index(connection: sqlite3.Connection, vault: Path) -> None:
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
        connection.execute("DELETE FROM vector_chunks WHERE path=?", (removed,))
    connection.commit()


def compact_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def split_section(value: str, maximum: int = 700, overlap: int = 100):
    compact = compact_text(value)
    if not compact:
        return []
    if len(compact) <= maximum:
        return [compact]
    chunks = []
    start = 0
    while start < len(compact):
        end = min(len(compact), start + maximum)
        if end < len(compact):
            boundary = max(compact.rfind("。", start + maximum // 2, end), compact.rfind("；", start, end))
            if boundary > start:
                end = boundary + 1
        chunks.append(compact[start:end])
        if end >= len(compact):
            break
        start = max(start + 1, end - overlap)
    return chunks


def document_chunks(title: str, category: str, body: str):
    sections = re.split(r"(?m)(?=^#{1,4}\s+)", body)
    chunks = []
    for section in sections:
        chunks.extend(split_section(section))
    if not chunks:
        chunks = split_section(body)
    prefix = f"标题：{title}\n分类：{category}\n"
    return [
        {
            "text": chunk,
            "embedding_text": prefix + chunk,
            "hash": hashlib.sha256((prefix + chunk).encode("utf-8")).hexdigest(),
        }
        for chunk in chunks
    ]


def normalize_vector(values):
    vector = [float(value) for value in values]
    magnitude = math.sqrt(sum(value * value for value in vector))
    if not vector or not math.isfinite(magnitude) or magnitude <= 0:
        raise ValueError("embedding_invalid_vector")
    return [value / magnitude for value in vector]


def request_embeddings(url: str, model: str, inputs, timeout: float = 60.0):
    if not inputs:
        return []
    endpoint = url.rstrip("/") + "/api/embed"
    body = json.dumps(
        {"model": model, "input": inputs, "truncate": True, "keep_alive": "10m"},
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    embeddings = payload.get("embeddings")
    if not isinstance(embeddings, list) or len(embeddings) != len(inputs):
        raise ValueError("embedding_invalid_response")
    normalized = [normalize_vector(values) for values in embeddings]
    dimensions = {len(values) for values in normalized}
    if len(dimensions) != 1 or next(iter(dimensions), 0) <= 0:
        raise ValueError("embedding_dimension_mismatch")
    return normalized


def vector_blob(values) -> bytes:
    return array("f", values).tobytes()


def vector_from_blob(blob: bytes, dimension: int):
    values = array("f")
    values.frombytes(blob)
    if len(values) != dimension:
        raise ValueError("embedding_corrupt")
    return values


def refresh_vector_index(connection: sqlite3.Connection, embedding_url: str, model: str) -> None:
    version = connection.execute(
        "SELECT value FROM vector_meta WHERE key='index_version'"
    ).fetchone()
    stored_model = connection.execute(
        "SELECT value FROM vector_meta WHERE key='model'"
    ).fetchone()
    if version != (VECTOR_INDEX_VERSION,) or stored_model != (model,):
        connection.execute("DELETE FROM vector_chunks")
        connection.execute(
            "INSERT INTO vector_meta(key,value) VALUES('index_version',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (VECTOR_INDEX_VERSION,),
        )
        connection.execute(
            "INSERT INTO vector_meta(key,value) VALUES('model',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (model,),
        )
        connection.commit()

    documents = connection.execute(
        "SELECT path,document_id,title,category,body FROM documents ORDER BY path"
    ).fetchall()
    for path, document_id, title, category, body in documents:
        chunks = document_chunks(title, category, body)
        stored = connection.execute(
            "SELECT chunk_index,content_hash,model FROM vector_chunks WHERE path=? ORDER BY chunk_index",
            (path,),
        ).fetchall()
        expected = [(index, chunk["hash"], model) for index, chunk in enumerate(chunks)]
        if stored == expected:
            continue
        try:
            embeddings = request_embeddings(
                embedding_url, model, [chunk["embedding_text"] for chunk in chunks]
            )
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            connection.execute("DELETE FROM vector_chunks WHERE path=?", (path,))
            connection.commit()
            continue
        connection.execute("DELETE FROM vector_chunks WHERE path=?", (path,))
        for index, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            connection.execute(
                "INSERT INTO vector_chunks VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    path, index, document_id, title, category, chunk["text"], chunk["hash"],
                    model, len(embedding), vector_blob(embedding),
                ),
            )
        connection.commit()


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


def lexical_search(connection: sqlite3.Connection, question: str, maximum: int = 30):
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
                "lexicalScore": round(score, 4),
            }
        )
    scored.sort(key=lambda item: item["lexicalScore"], reverse=True)
    return scored[:maximum]


def dot_product(first, second):
    return sum(left * right for left, right in zip(first, second))


def vector_search(
    connection: sqlite3.Connection,
    question: str,
    embedding_url: str,
    model: str,
    maximum: int = 30,
):
    try:
        query = request_embeddings(embedding_url, model, [QUERY_INSTRUCTION + question])[0]
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
        return []
    best_by_path = {}
    rows = connection.execute(
        "SELECT path,document_id,title,category,chunk_text,dimension,embedding "
        "FROM vector_chunks WHERE model=?",
        (model,),
    ).fetchall()
    for path, document_id, title, category, chunk_text, dimension, blob in rows:
        if dimension != len(query):
            continue
        try:
            score = dot_product(query, vector_from_blob(blob, dimension))
        except ValueError:
            continue
        current = best_by_path.get(path)
        if current is None or score > current["vectorScore"]:
            best_by_path[path] = {
                "documentId": document_id,
                "title": title,
                "category": category,
                "vaultPath": path,
                "excerpt": chunk_text[:1400],
                "vectorScore": round(score, 6),
            }
    results = sorted(best_by_path.values(), key=lambda item: item["vectorScore"], reverse=True)
    return [item for item in results if item["vectorScore"] >= 0.35][:maximum]


def hybrid_search(connection: sqlite3.Connection, question: str, limit: int, embedding_url: str, model: str):
    lexical = lexical_search(connection, question)
    semantic = vector_search(connection, question, embedding_url, model) if embedding_url and model else []
    combined = {}
    for rank, item in enumerate(lexical, start=1):
        entry = combined.setdefault(item["vaultPath"], dict(item))
        entry["fusionScore"] = entry.get("fusionScore", 0.0) + 1.0 / (60 + rank)
        entry["lexicalRank"] = rank
    for rank, item in enumerate(semantic, start=1):
        entry = combined.setdefault(item["vaultPath"], dict(item))
        entry.update({"vectorScore": item["vectorScore"], "excerpt": item["excerpt"]})
        entry["fusionScore"] = entry.get("fusionScore", 0.0) + 1.0 / (60 + rank)
        entry["vectorRank"] = rank
    for entry in combined.values():
        if "lexicalRank" in entry and "vectorRank" in entry:
            entry["fusionScore"] += 0.01
    ranked = sorted(
        combined.values(),
        key=lambda item: (item.get("fusionScore", 0.0), item.get("vectorScore", -1.0)),
        reverse=True,
    )
    return [
        {
            "documentId": item["documentId"],
            "title": item["title"],
            "category": item["category"],
            "vaultPath": item["vaultPath"],
            "excerpt": item["excerpt"],
            "score": round(item.get("fusionScore", 0.0), 6),
            "matchType": "hybrid" if "lexicalRank" in item and "vectorRank" in item
            else "vector" if "vectorRank" in item else "text",
        }
        for item in ranked[:limit]
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    parser.add_argument("--question", default="")
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--embedding-url", default="")
    parser.add_argument("--embedding-model", default="")
    parser.add_argument("--refresh-only", action="store_true")
    args = parser.parse_args()
    vault = Path(args.vault).expanduser().resolve()
    connection = connect(vault / ".assistant" / "document-index.db")
    try:
        refresh_text_index(connection, vault)
        if args.embedding_url and args.embedding_model:
            refresh_vector_index(connection, args.embedding_url, args.embedding_model)
        if args.refresh_only:
            print(json.dumps({"ok": True}, ensure_ascii=False))
            return
        if not args.question.strip():
            raise ValueError("question_required")
        results = hybrid_search(
            connection,
            args.question,
            max(1, min(args.limit, 10)),
            args.embedding_url,
            args.embedding_model,
        )
        print(json.dumps(results, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
