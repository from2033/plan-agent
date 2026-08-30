"""接收 OneBot 11 事件（NapCat 等桥接器推送）。

- 群消息(message/group)：老师过滤 → 文本入 messages；图片下载到 /uploads 并在小程序显示。
- 群文件(notice/group_upload)：老师上传的文件下载到服务器 → 进 downloads 表（下载/打印区）。

不登录 QQ，只接收桥接器主动 POST 的事件。请用群白名单 + access token，优先专门小号。
"""
from __future__ import annotations

import json
import logging
import time
import mimetypes
import base64
from datetime import datetime, timezone
from pathlib import Path
from secrets import compare_digest
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Request

import config
from db import db

router = APIRouter(prefix="/api/integrations/onebot", tags=["onebot"])
log = logging.getLogger("onebot")

TYPE_KEYWORDS = {
    "homework": ["作业", "练习", "周记", "打卡", "课本"],
    "notice": ["通知", "家长会", "会议", "放假", "请假"],
    "praise": ["表扬", "优秀", "出色", "值得", "点赞"],
    "reminder": ["提醒", "订正", "检查", "注意", "截止"],
}


def _classify(content: str) -> str:
    for message_type, keywords in TYPE_KEYWORDS.items():
        if any(keyword in content for keyword in keywords):
            return message_type
    return "notice"


def _parse_message(event: dict[str, Any]) -> tuple[str, list[dict], list[dict]]:
    """返回 (文本, 图片段列表, 文件段列表)。"""
    message = event.get("message")
    if isinstance(message, str):
        return message.strip(), [], []
    if not isinstance(message, list):
        return str(event.get("raw_message") or "").strip(), [], []

    texts: list[str] = []
    images: list[dict] = []
    files: list[dict] = []
    for seg in message:
        if not isinstance(seg, dict):
            continue
        kind = seg.get("type")
        data = seg.get("data") or {}
        if kind == "text":
            texts.append(str(data.get("text") or ""))
        elif kind == "image":
            images.append(data)
        elif kind == "file":
            files.append(data)
        elif kind == "reply":
            texts.append("")
    return "".join(texts).strip(), images, files


async def _download(
    url: str, dest_dir: Path, stem: str, default_ext: str,
    max_bytes: Optional[int] = None,
) -> Optional[str]:
    """流式下载 url 到目录，返回保存的文件名；失败返回 None。

    - 用流式写盘而非一次性读进内存，避免大文件 OOM。
    - 用分项超时（连接 15s / 读 120s）而非一刀切总超时，避免大文件被 30s 总超时误杀。
    - max_bytes 不为空时，下载超过上限即中止并删除半成品。
    """
    timeout = httpx.Timeout(connect=15.0, read=120.0, write=120.0, pool=15.0)
    path: Optional[Path] = None
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", url) as r:
                r.raise_for_status()
                ext = Path(url.split("?")[0]).suffix
                if not ext:
                    ext = mimetypes.guess_extension(
                        r.headers.get("content-type", "").split(";")[0]) or default_ext
                name = f"{stem}{ext}"
                path = dest_dir / name
                total = 0
                with open(path, "wb") as fh:
                    async for chunk in r.aiter_bytes(65536):
                        total += len(chunk)
                        if max_bytes and total > max_bytes:
                            log.warning("download aborted (>%d bytes): %s", max_bytes, name)
                            fh.close()
                            path.unlink(missing_ok=True)
                            return None
                        fh.write(chunk)
            return name
    except Exception as e:  # noqa: BLE001
        log.warning("download failed %s: %s", url[:80], e)
        if path is not None:
            path.unlink(missing_ok=True)
        return None


async def _napcat(action: str, payload: dict) -> dict:
    headers = {"Content-Type": "application/json"}
    if config.ONEBOT_ACCESS_TOKEN:
        headers["Authorization"] = f"Bearer {config.ONEBOT_ACCESS_TOKEN}"
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{config.NAPCAT_API_URL}/{action}", json=payload, headers=headers)
        return r.json()


def _authorized(authorization: Optional[str], x_access_token: Optional[str]) -> bool:
    expected = config.ONEBOT_ACCESS_TOKEN
    if not expected:
        return True
    candidate = x_access_token or ""
    if authorization and authorization.lower().startswith("bearer "):
        candidate = authorization[7:].strip()
    return compare_digest(candidate, expected)


def _is_teacher(sender_id: str, name: str) -> bool:
    if config.QQ_CAPTURE_ALL:
        return True
    if config.QQ_TEACHER_IDS and sender_id in config.QQ_TEACHER_IDS:
        return True
    return any(k in name for k in config.QQ_TEACHER_NAME_KEYWORDS)


def _group_name(event: dict, group_id: str) -> str:
    return str(event.get("group_name") or config.QQ_GROUP_NAMES.get(group_id) or f"QQ群 {group_id}")


async def _sync_assistant_task(
    *, external_id: str, group_id: str, group_name: str,
    sender: str, content: str, timestamp: Any,
) -> None:
    """把原始群消息交给个人助手识别；失败不影响群消息采集。"""
    if not config.ASSISTANT_TASK_SYNC_URL or not config.ASSISTANT_TASK_SYNC_SECRET or not content:
        return
    try:
        sent_at = datetime.fromtimestamp(int(timestamp), timezone.utc)
    except (TypeError, ValueError, OSError):
        sent_at = datetime.now(timezone.utc)
    payload = {
        "externalId": f"{group_id}:{external_id}",
        "groupId": group_id,
        "groupName": group_name,
        "sender": sender,
        "content": content,
        "sentAt": sent_at.isoformat().replace("+00:00", "Z"),
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(
                config.ASSISTANT_TASK_SYNC_URL,
                json=payload,
                headers={"X-Integration-Token": config.ASSISTANT_TASK_SYNC_SECRET},
            )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        log.warning("personal assistant task sync failed for %s: %s", external_id, exc)


async def _sync_assistant_media(
    *, file_path: Path, file_name: str, external_id: str, group_id: str,
    group_name: str, sender: str, timestamp: Any,
) -> None:
    """把 QQ 图片/文件送入个人助手的资料 OCR 与统一索引；失败不影响采集。"""
    if not config.ASSISTANT_TASK_SYNC_URL or not config.ASSISTANT_TASK_SYNC_SECRET:
        return
    if not file_path.exists() or file_path.stat().st_size > 20 * 1024 * 1024:
        return
    try:
        sent_at = datetime.fromtimestamp(int(timestamp), timezone.utc)
    except (TypeError, ValueError, OSError):
        sent_at = datetime.now(timezone.utc)
    metadata = {
        "externalId": f"{group_id}:{external_id}",
        "groupId": group_id,
        "groupName": group_name,
        "sender": sender,
        "fileName": file_name,
        "sentAt": sent_at.isoformat().replace("+00:00", "Z"),
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(metadata, ensure_ascii=False).encode("utf-8")
    ).decode("ascii").rstrip("=")
    media_url = config.ASSISTANT_TASK_SYNC_URL.rsplit("/", 1)[0] + "/qq-media"
    mime_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            with open(file_path, "rb") as handle:
                response = await client.post(
                    media_url,
                    content=handle.read(),
                    headers={
                        "Content-Type": mime_type,
                        "X-Integration-Token": config.ASSISTANT_TASK_SYNC_SECRET,
                        "X-QQ-Media-Metadata": encoded,
                    },
                )
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        log.warning("personal assistant media sync failed for %s: %s", external_id, exc)


async def _handle_group_upload(event: dict) -> dict:
    """老师在群里上传的文件 → 下载到服务器 → 进 downloads 表（打印区）。"""
    group_id = str(event.get("group_id") or "")
    group_name = _group_name(event, group_id)
    sender_id = str(event.get("user_id") or "")
    uploader = event.get("sender") or {}
    uploader_name = str(uploader.get("card") or uploader.get("nickname") or "")
    if config.QQ_GROUP_IDS and group_id not in config.QQ_GROUP_IDS:
        return {"status": "ignored", "reason": "group_not_allowed"}
    if not _is_teacher(sender_id, uploader_name):
        return {"status": "ignored", "reason": "not_teacher"}

    finfo = event.get("file") or {}
    fid = str(finfo.get("id") or finfo.get("file_id") or "")
    fname = str(finfo.get("name") or "群文件")
    size = int(finfo.get("size") or 0)
    busid = finfo.get("busid")

    max_bytes = config.QQ_MAX_FILE_MB * 1024 * 1024
    if size and size > max_bytes:
        log.info("skip oversized file %s (%.1f MB > %d MB)",
                 fname, size / 1024 / 1024, config.QQ_MAX_FILE_MB)
        return {"status": "ignored", "reason": "too_large"}
    # 文件的真实上传/修改时间（回填时由群文件列表带入），用作 created_at
    upload_ts = finfo.get("modify_time") or finfo.get("upload_time") or event.get("time")
    try:
        created_at = datetime.fromtimestamp(int(upload_ts)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with db() as conn:
        if conn.execute("SELECT id FROM downloads WHERE name = ? AND size_bytes = ?",
                        (fname, int(size))).fetchone():
            return {"status": "duplicate"}

    # 取下载直链
    url = finfo.get("url")
    if not url and fid:
        payload = {"group_id": int(group_id), "file_id": fid}
        if busid is not None:
            payload["busid"] = busid
        try:
            url = ((await _napcat("get_group_file_url", payload)).get("data") or {}).get("url")
        except Exception:  # noqa: BLE001
            url = None
    if not url:
        log.warning("no download url for file %s (fid=%s)", fname, fid)
        return {"status": "ignored", "reason": "no_file_url"}

    saved = await _download(url, config.FILES_DIR, f"g{group_id}_{fid}", ".bin",
                            max_bytes=max_bytes)
    if not saved:
        log.warning("download failed for file %s", fname)
        return {"status": "ignored", "reason": "download_failed"}
    log.info("saved group file: %s (%.1f MB)", fname, (size or 0) / 1024 / 1024)
    full = str(config.FILES_DIR / saved)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO downloads (name, subject, size_bytes, file_path, group_id, group_name, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (fname, None, size or (config.FILES_DIR / saved).stat().st_size, full,
             group_id, group_name, created_at),
        )
        row_id = cur.lastrowid
    await _sync_assistant_task(
        external_id=f"file:{fid or row_id}", group_id=group_id, group_name=group_name,
        sender=uploader_name or sender_id or "QQ群成员", content=f"[群文件：{fname}]",
        timestamp=upload_ts,
    )
    await _sync_assistant_media(
        file_path=config.FILES_DIR / saved, file_name=fname,
        external_id=f"file:{fid or row_id}", group_id=group_id, group_name=group_name,
        sender=uploader_name or sender_id or "QQ群成员", timestamp=upload_ts,
    )
    return {"status": "ok", "id": row_id, "kind": "file", "name": fname}


@router.post("/events")
async def receive_event(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_access_token: Optional[str] = Header(default=None),
):
    if not _authorized(authorization, x_access_token):
        raise HTTPException(status_code=401, detail="OneBot access token 无效")

    event = await request.json()
    post_type = event.get("post_type")

    # 群文件上传
    if post_type == "notice" and event.get("notice_type") == "group_upload":
        return await _handle_group_upload(event)

    if post_type != "message" or event.get("message_type") != "group":
        return {"status": "ignored", "reason": "not_group_message"}

    group_id = str(event.get("group_id") or "")
    group_name = _group_name(event, group_id)
    sender_id = str(event.get("user_id") or "")
    message_id = str(event.get("message_id") or "")
    if config.QQ_GROUP_IDS and group_id not in config.QQ_GROUP_IDS:
        return {"status": "ignored", "reason": "group_not_allowed"}
    if sender_id and sender_id == str(event.get("self_id") or ""):
        return {"status": "ignored", "reason": "self_message"}

    sender = event.get("sender") or {}
    teacher = str(sender.get("card") or sender.get("nickname") or sender_id or "QQ 群成员").strip()
    if not _is_teacher(sender_id, teacher):
        return {"status": "ignored", "reason": "not_teacher"}

    text, image_segs, file_segs = _parse_message(event)
    # 文本：纯文本 + 文件占位
    parts = [text] if text else []
    for f in file_segs:
        parts.append(f"[文件：{f.get('file') or f.get('name') or '未命名'}]")
    content = " ".join(p for p in parts if p).strip()
    if not content and not image_segs and not file_segs:
        return {"status": "ignored", "reason": "empty_message"}

    timestamp = event.get("time")
    try:
        _dt = datetime.fromtimestamp(int(timestamp))
    except (TypeError, ValueError, OSError):
        _dt = datetime.now()
    display_time = _dt.strftime("%H:%M")
    msg_date = _dt.strftime("%Y-%m-%d")

    message_type = _classify(content)
    important = int(message_type in {"homework", "notice"})
    external_id = message_id or f"{group_id}:{sender_id}:{timestamp}:{hash(content)}"

    with db() as conn:
        exists = conn.execute(
            "SELECT id FROM messages WHERE source = 'onebot' AND external_id = ?",
            (external_id,),
        ).fetchone()
        if exists:
            await _sync_assistant_task(
                external_id=external_id, group_id=group_id, group_name=group_name,
                sender=teacher, content=content, timestamp=timestamp,
            )
            return {"status": "duplicate", "id": exists["id"]}

    # 下载图片到 /uploads
    image_urls: list[str] = []
    downloaded_images: list[tuple[Path, str]] = []
    for i, seg in enumerate(image_segs):
        url = seg.get("url") or seg.get("file")
        if not url or not str(url).startswith("http"):
            continue
        saved = await _download(url, config.UPLOAD_DIR, f"msg_{external_id}_{i}", ".jpg")
        if saved:
            image_urls.append(f"/uploads/{saved}")
            downloaded_images.append((config.UPLOAD_DIR / saved, saved))

    if not content and not image_urls:
        return {"status": "ignored", "reason": "empty_after_download"}

    with db() as conn:
        cur = conn.execute(
            "INSERT INTO messages "
            "(teacher, avatar, content, time, date, type, important, source, external_id, "
            "group_id, group_name, sender_id, images_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                teacher, teacher[:1] or "Q", content or "[图片]", display_time, msg_date,
                message_type, important, "onebot", external_id, group_id, group_name, sender_id,
                json.dumps(image_urls, ensure_ascii=False),
            ),
        )
        row_id = cur.lastrowid

    sync_content = content or " ".join(f"[图片附件：{name}]" for _, name in downloaded_images)
    await _sync_assistant_task(
        external_id=external_id, group_id=group_id, group_name=group_name,
        sender=teacher, content=sync_content, timestamp=timestamp,
    )
    for image_path, image_name in downloaded_images:
        await _sync_assistant_media(
            file_path=image_path, file_name=image_name,
            external_id=f"{external_id}:image:{image_name}", group_id=group_id,
            group_name=group_name, sender=teacher, timestamp=timestamp,
        )

    return {"status": "ok", "id": row_id, "type": message_type, "images": len(image_urls)}


@router.get("/status")
def status():
    return {
        "enabled": bool(config.ONEBOT_ACCESS_TOKEN),
        "group_whitelist_count": len(config.QQ_GROUP_IDS),
        "teacher_whitelist_count": len(config.QQ_TEACHER_IDS),
        "capture_all": config.QQ_CAPTURE_ALL,
    }
