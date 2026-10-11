"""Add already-captured QQ message images to the date-scoped print area."""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import time
from pathlib import Path

SUBJECT_KEYWORDS = {
    "语文": ("语文", "生字", "词语", "古诗", "作文", "习作"),
    "数学": ("数学", "口算", "计算", "方程", "几何"),
    "英语": ("英语", "单词", "拼读"),
    "物理": ("物理",),
    "化学": ("化学",),
    "生物": ("生物",),
    "道法": ("道法", "道德与法治"),
    "历史": ("历史",),
    "地理": ("地理",),
    "科学": ("科学",),
}


def guess_subject(text: str) -> str | None:
    for subject, keywords in SUBJECT_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return subject
    return None


def backfill(root: Path) -> tuple[int, int]:
    database_path = root / "data/app.db"
    backup = root / "data/backups" / (
        f"app-{time.strftime('%Y%m%dT%H%M%S')}-before-print-images.db"
    )
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(database_path, backup)

    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    inserted = 0
    rows = connection.execute(
        "SELECT id,content,date,time,group_id,group_name,images_json "
        "FROM messages WHERE images_json IS NOT NULL AND images_json != '[]'"
    ).fetchall()
    for row in rows:
        try:
            images = json.loads(row["images_json"] or "[]")
        except (TypeError, json.JSONDecodeError):
            continue
        for index, url in enumerate(images):
            path = root / "data/uploads" / Path(str(url)).name
            if not path.exists():
                continue
            if connection.execute(
                "SELECT 1 FROM downloads WHERE file_path = ?", (str(path),)
            ).fetchone():
                continue
            subject = guess_subject(f"{row['content'] or ''} {path.name}")
            day = row["date"] or "1970-01-01"
            clock = row["time"] or "00:00"
            suffix = path.suffix.lower() or ".jpg"
            name = f"{subject or '群图片'}-{day}-{row['id']}-{index + 1}{suffix}"
            connection.execute(
                "INSERT INTO downloads "
                "(name,subject,size_bytes,file_path,group_id,group_name,created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    name,
                    subject,
                    path.stat().st_size,
                    str(path),
                    row["group_id"],
                    row["group_name"],
                    f"{day} {clock}:00",
                ),
            )
            inserted += 1
    connection.commit()
    printable_days = connection.execute(
        "SELECT COUNT(DISTINCT date(created_at)) FROM downloads"
    ).fetchone()[0]
    connection.close()
    return inserted, printable_days


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    added, days = backfill(args.root)
    print(f"historical_images_added={added} printable_days={days}")
