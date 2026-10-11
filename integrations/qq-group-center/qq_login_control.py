"""Private host-side control endpoint for generating and emailing a fresh QQ QR code."""

from __future__ import annotations

import fcntl
import hmac
import json
import os
import shutil
import smtplib
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlparse
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BIND_HOST = os.getenv("QQ_LOGIN_CONTROL_HOST", "172.19.0.1")
BIND_PORT = int(os.getenv("QQ_LOGIN_CONTROL_PORT", "4711"))
SECRET = os.getenv("QQ_LOGIN_CONTROL_SECRET", "")
NAPCAT_API = os.getenv("NAPCAT_API_URL", "http://172.19.0.1:3000").rstrip("/")
ONEBOT_TOKEN = os.getenv("ONEBOT_ACCESS_TOKEN", "")
ENV_PATH = Path(os.getenv("NAPCAT_ENV_PATH", "/opt/qq-group-center/runtime/napcat.env"))
COMPOSE_PATH = Path(os.getenv("NAPCAT_COMPOSE_PATH", "/opt/qq-group-center/runtime/docker-compose.qq-linux.yml"))
QR_PATH = Path(os.getenv("NAPCAT_HOST_QR_PATH", "/opt/qq-group-center/napcat/cache/qrcode.png"))
LOCK_PATH = Path(os.getenv("QQ_LOGIN_CONTROL_LOCK", "/run/qq-login-control.lock"))
SYNC_LOCK_PATH = Path(os.getenv("QQ_MISSED_SYNC_LOCK", "/run/qq-missed-sync.lock"))
BACKUP_ROOT = Path(os.getenv("QQ_LOGIN_BACKUP_ROOT", "/opt/qq-group-center/backups"))
ONEBOT_EVENT_URL = os.getenv(
    "ONEBOT_EVENT_URL",
    "http://qq-group-center:8000/api/integrations/onebot/events",
).strip()
QQ_GROUP_IDS = [
    value.strip()
    for value in os.getenv("QQ_GROUP_IDS", "").split(",")
    if value.strip()
]
QQ_MANUAL_SYNC_DAYS = max(
    1, min(7, int(os.getenv("QQ_MANUAL_SYNC_DAYS", "3")))
)


def host_reachable_url(url: str) -> str:
    """Resolve a Docker service URL when this controller runs on the host."""
    parsed = urlparse(url)
    if parsed.hostname in {"qq-group-napcat", "qq-group-center"}:
        container = parsed.hostname
        address = subprocess.run(
            ["docker", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        if not address:
            raise RuntimeError("container_address_missing")
        return parsed._replace(netloc=f"{address}:{parsed.port or 80}").geturl()
    return url


def post_json(url: str, payload: dict, timeout: int = 25) -> dict:
    request = urllib.request.Request(
        host_reachable_url(url),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {ONEBOT_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def napcat_api(action: str, payload: dict | None = None) -> dict:
    result = post_json(f"{NAPCAT_API}/{action}", payload or {}, 10)
    if result.get("status") != "ok" or int(result.get("retcode") or 0) != 0:
        raise RuntimeError("napcat_status_failed")
    return result.get("data") or {}


def is_online() -> bool:
    try:
        return napcat_api("get_status").get("online") is True
    except Exception:
        return False


def recent_group_messages(group_id: str, cutoff: int) -> list[dict]:
    """Read bounded group history from newest to oldest without duplicates."""
    collected: list[dict] = []
    seen_ids: set[str] = set()
    seen_sequences: set[int] = set()
    sequence = 0
    for _ in range(20):
        result = napcat_api("get_group_msg_history", {
            "group_id": int(group_id),
            "message_seq": sequence,
            "count": 50,
            "reverseOrder": False,
        })
        messages = result.get("messages") or []
        if not messages:
            break
        for message in messages:
            message_id = str(message.get("message_id") or "")
            if (
                message_id
                and message_id not in seen_ids
                and int(message.get("time") or 0) >= cutoff
            ):
                collected.append(message)
                seen_ids.add(message_id)
        oldest = messages[0]
        oldest_time = int(oldest.get("time") or 0)
        oldest_sequence = int(oldest.get("message_seq") or 0)
        if (
            oldest_time < cutoff
            or not oldest_sequence
            or oldest_sequence in seen_sequences
        ):
            break
        seen_sequences.add(oldest_sequence)
        sequence = oldest_sequence
    return sorted(collected, key=lambda item: int(item.get("time") or 0))


def recent_group_files(group_id: str, cutoff: int) -> list[dict]:
    """List recently modified group files, including files inside folders."""
    collected: list[dict] = []
    seen: set[tuple[str, int, int]] = set()
    pending_folders: list[dict] = []

    def collect_page(result: dict) -> None:
        for item in result.get("files") or []:
            modified = int(item.get("modify_time") or item.get("upload_time") or 0)
            key = (
                str(item.get("file_name") or item.get("name") or ""),
                int(item.get("file_size") or item.get("size") or 0),
                modified,
            )
            if modified >= cutoff and key not in seen:
                collected.append(item)
                seen.add(key)
        pending_folders.extend(result.get("folders") or [])

    collect_page(napcat_api("get_group_root_files", {
        "group_id": int(group_id), "file_count": 200,
    }))
    visited_folders: set[str] = set()
    while pending_folders and len(visited_folders) < 50:
        folder = pending_folders.pop(0)
        folder_id = str(folder.get("folder_id") or folder.get("id") or "")
        if not folder_id or folder_id in visited_folders:
            continue
        visited_folders.add(folder_id)
        collect_page(napcat_api("get_group_files_by_folder", {
            "group_id": int(group_id), "folder_id": folder_id, "file_count": 200,
        }))
    return sorted(
        collected,
        key=lambda item: int(item.get("modify_time") or item.get("upload_time") or 0),
    )


def group_file_event(group_id: str, file_info: dict, self_id: int) -> dict:
    timestamp = int(file_info.get("modify_time") or file_info.get("upload_time") or time.time())
    uploader = file_info.get("uploader") or file_info.get("user_id") or 0
    uploader_name = str(file_info.get("uploader_name") or "")
    return {
        "post_type": "notice",
        "notice_type": "group_upload",
        "time": timestamp,
        "self_id": self_id,
        "group_id": int(group_id),
        "user_id": uploader,
        "sender": {"user_id": uploader, "nickname": uploader_name, "card": uploader_name},
        "file": {
            "id": file_info.get("file_id") or file_info.get("id"),
            "name": file_info.get("file_name") or file_info.get("name") or "群文件",
            "size": file_info.get("file_size") or file_info.get("size") or 0,
            "busid": file_info.get("busid"),
            "modify_time": timestamp,
            "upload_time": file_info.get("upload_time") or timestamp,
        },
    }


def sync_missed_messages() -> dict:
    """Replay recent messages and group files through the idempotent endpoint."""
    if not is_online():
        raise RuntimeError("qq_offline")
    if not QQ_GROUP_IDS or not ONEBOT_EVENT_URL or not ONEBOT_TOKEN:
        raise RuntimeError("sync_not_configured")

    cutoff = int(time.time()) - QQ_MANUAL_SYNC_DAYS * 86400
    counts = {
        "replayed": 0, "created": 0, "duplicates": 0,
        "ignored": 0, "errors": 0, "file_replayed": 0, "file_created": 0,
    }
    self_id = int(napcat_api("get_login_info").get("user_id") or 0)
    for group_id in QQ_GROUP_IDS:
        try:
            messages = recent_group_messages(group_id, cutoff)
        except Exception as error:
            counts["errors"] += 1
            print(
                f"QQ manual history read failed group={group_id} reason={type(error).__name__}",
                flush=True,
            )
            continue
        for message in messages:
            sender = message.get("sender") or {}
            event = {
                "post_type": "message",
                "message_type": "group",
                "time": message.get("time"),
                "self_id": self_id,
                "group_id": int(group_id),
                "user_id": sender.get("user_id") or message.get("user_id"),
                "message_id": message.get("message_id"),
                "sender": sender,
                "message": message.get("message"),
                "raw_message": message.get("raw_message", ""),
            }
            try:
                result = post_json(ONEBOT_EVENT_URL, event)
                status = str(result.get("status") or "ignored")
                counts["replayed"] += 1
                if status == "ok":
                    counts["created"] += 1
                elif status == "duplicate":
                    counts["duplicates"] += 1
                else:
                    counts["ignored"] += 1
            except Exception as error:
                counts["errors"] += 1
                print(
                    f"QQ manual replay failed reason={type(error).__name__}",
                    flush=True,
                )
        try:
            files = recent_group_files(group_id, cutoff)
        except Exception as error:
            counts["errors"] += 1
            print(
                f"QQ manual file list failed group={group_id} reason={type(error).__name__}",
                flush=True,
            )
            continue
        for file_info in files:
            try:
                result = post_json(
                    ONEBOT_EVENT_URL,
                    group_file_event(group_id, file_info, self_id),
                )
                status = str(result.get("status") or "ignored")
                counts["replayed"] += 1
                counts["file_replayed"] += 1
                if status == "ok":
                    counts["created"] += 1
                    counts["file_created"] += 1
                elif status == "duplicate":
                    counts["duplicates"] += 1
                else:
                    counts["ignored"] += 1
            except Exception as error:
                counts["errors"] += 1
                print(
                    f"QQ manual file replay failed reason={type(error).__name__}",
                    flush=True,
                )
    counts["days"] = QQ_MANUAL_SYNC_DAYS
    counts["message"] = (
        f"已检查最近 {QQ_MANUAL_SYNC_DAYS} 天：补回 {counts['created']} 条，"
        f"其中群文件 {counts['file_created']} 个，已有 {counts['duplicates']} 条，"
        f"忽略 {counts['ignored']} 条"
        + (f"，失败 {counts['errors']} 条" if counts["errors"] else "")
    )
    return counts


def without_login_credentials(content: str) -> str:
    output: list[str] = []
    found = set()
    for line in content.splitlines():
        key = line.split("=", 1)[0].strip()
        if key in {"ACCOUNT", "NAPCAT_QUICK_PASSWORD_MD5"}:
            output.append(f"{key}=")
            found.add(key)
        else:
            output.append(line)
    for key in ("ACCOUNT", "NAPCAT_QUICK_PASSWORD_MD5"):
        if key not in found:
            output.append(f"{key}=")
    return "\n".join(output) + "\n"


def atomic_write(path: Path, content: str, mode: int) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def send_qr_email(qr_path: Path) -> None:
    recipient = os.getenv("ALERT_EMAIL", "").strip()
    smtp_user = os.getenv("SMTP_USER", "").strip()
    smtp_password = os.getenv("SMTP_PASS", "")
    if not recipient or not smtp_user or not smtp_password:
        raise RuntimeError("email_not_configured")
    message = EmailMessage()
    message["Subject"] = "QQ 登录二维码（刚刚生成）"
    message["From"] = os.getenv("SMTP_FROM", f"5656AI <{smtp_user}>")
    message["To"] = recipient
    message.set_content("这是刚刚生成的 QQ 登录二维码，请尽快使用手机 QQ 扫描。二维码过期后请在 App 中重新点击发送。")
    message.add_attachment(qr_path.read_bytes(), maintype="image", subtype="png", filename="qq-login-qrcode.png")
    with smtplib.SMTP_SSL(
        os.getenv("SMTP_HOST", "smtpdm.aliyun.com"),
        int(os.getenv("SMTP_PORT", "465")),
        timeout=20,
    ) as smtp:
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(message)


def request_fresh_qr_email() -> dict:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if is_online():
            return {"status": "already_online", "message": "QQ 当前已经在线，无需重新登录。"}
        if not ENV_PATH.exists() or not COMPOSE_PATH.exists():
            raise RuntimeError("napcat_runtime_missing")

        original = ENV_PATH.read_text(encoding="utf-8")
        mode = ENV_PATH.stat().st_mode & 0o777
        BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
        backup = BACKUP_ROOT / f"napcat.env-before-qr-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
        shutil.copy2(ENV_PATH, backup)
        started = time.time()
        try:
            atomic_write(ENV_PATH, without_login_credentials(original), mode)
            subprocess.run(["docker", "rm", "-f", "qq-group-napcat"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(
                ["docker", "compose", "-f", str(COMPOSE_PATH), "up", "-d", "--no-deps", "napcat"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
            )
        finally:
            atomic_write(ENV_PATH, original, mode)

        deadline = time.time() + 90
        while time.time() < deadline:
            if QR_PATH.exists() and QR_PATH.stat().st_mtime >= started and QR_PATH.stat().st_size > 100:
                send_qr_email(QR_PATH)
                return {"status": "sent", "message": "新的 QQ 登录二维码已发送到通知邮箱，请尽快扫码。"}
            time.sleep(2)
        raise RuntimeError("fresh_qr_not_generated")


class Handler(BaseHTTPRequestHandler):
    server_version = "QqLoginControl/1.0"

    def log_message(self, format: str, *args: object) -> None:
        print(f"qq_login_control {self.address_string()} {format % args}", flush=True)

    def respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {SECRET}"
        if not SECRET or not hmac.compare_digest(supplied, expected):
            self.respond(401, {"error": "unauthorized"})
            return
        if self.path not in {"/request-login-email", "/sync-missed"}:
            self.respond(404, {"error": "not_found"})
            return
        try:
            if self.path == "/sync-missed":
                SYNC_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
                with SYNC_LOCK_PATH.open("a+") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    self.respond(200, sync_missed_messages())
            else:
                self.respond(200, request_fresh_qr_email())
        except Exception as error:
            print(f"qq_login_control_failed reason={type(error).__name__}", flush=True)
            message = (
                "QQ 当前不在线，请先重新登录。"
                if str(error) == "qq_offline"
                else "同步遗漏消息失败，请稍后重试。"
                if self.path == "/sync-missed"
                else "暂时无法生成新的 QQ 登录二维码，请稍后重试。"
            )
            self.respond(503, {"error": message})


def main() -> None:
    if len(SECRET) < 32:
        raise RuntimeError("QQ_LOGIN_CONTROL_SECRET must contain at least 32 characters")
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    print(f"qq_login_control_started address={BIND_HOST}:{BIND_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
