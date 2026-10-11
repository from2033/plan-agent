"""Monitor NapCat login state and email QR/recovery notifications."""
import json, os, smtplib, time, urllib.request
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path

API = os.getenv("NAPCAT_API_URL", "http://qq-group-napcat:3000").rstrip("/")
TOKEN = os.getenv("ONEBOT_ACCESS_TOKEN", "")
TO = os.getenv("ALERT_EMAIL", "")
QR = Path(os.getenv("QR_PATH", "/app/napcat/cache/qrcode.png"))
STATE = Path(os.getenv("STATE_PATH", "/data/qq-monitor-state.json"))
ASSISTANT_STATUS_URL = os.getenv("ASSISTANT_STATUS_URL", "").strip()
ASSISTANT_STATUS_SECRET = os.getenv("ASSISTANT_STATUS_SECRET", "").strip()
ONEBOT_EVENT_URL = os.getenv(
    "ONEBOT_EVENT_URL",
    "http://qq-group-center:8000/api/integrations/onebot/events",
).strip()
QQ_GROUP_IDS = [value.strip() for value in os.getenv("QQ_GROUP_IDS", "").split(",") if value.strip()]
QQ_RECOVERY_BACKFILL_DAYS = max(1, min(7, int(os.getenv("QQ_RECOVERY_BACKFILL_DAYS", "3"))))
OFFLINE_REMINDER_DELAYS = (1800, 3600, 7200, 14400, 28800, 43200, 86400)


def offline_reminder_delay(alert_count):
    """Return the next delay after the current number of offline alerts."""
    index = max(0, min(int(alert_count or 1) - 1, len(OFFLINE_REMINDER_DELAYS) - 1))
    return OFFLINE_REMINDER_DELAYS[index]


def post_json(url, payload, timeout=25):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def napcat_api(action, payload=None):
    response = post_json(API + "/" + action, payload or {}, 10)
    if response.get("status") != "ok" or int(response.get("retcode") or 0) != 0:
        raise RuntimeError(f"NapCat {action} failed")
    return response.get("data") or {}

def login_ok():
    """Return the real connection state, not cached account information.

    NapCat keeps returning user_id from get_login_info after QQ has emitted a
    KickedOffLine event. get_status.online is the authoritative signal used by
    OneBot clients and correctly becomes false in that state.
    """
    status = napcat_api("get_status")
    try:
        account = napcat_api("get_login_info")
    except Exception:
        account = {}
    name = str(account.get("nickname") or account.get("user_id") or "QQ")
    return status.get("online") is True, name


def recent_group_messages(group_id, cutoff):
    """Read recent group history from newest to oldest with a bounded crawl."""
    collected, seen_ids, seen_sequences = [], set(), set()
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
            if message_id and message_id not in seen_ids and int(message.get("time") or 0) >= cutoff:
                collected.append(message)
                seen_ids.add(message_id)
        oldest = messages[0]
        oldest_time = int(oldest.get("time") or 0)
        oldest_sequence = oldest.get("message_seq")
        if oldest_time < cutoff or not oldest_sequence or oldest_sequence in seen_sequences:
            break
        seen_sequences.add(oldest_sequence)
        sequence = oldest_sequence
    return sorted(collected, key=lambda item: int(item.get("time") or 0))


def recent_group_files(group_id, cutoff):
    """List recently modified group files, including files inside folders."""
    collected, seen, pending_folders = [], set(), []

    def collect_page(result):
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
    visited_folders = set()
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


def group_file_event(group_id, file_info, self_id):
    """Convert a group-file listing entry into the normal OneBot upload event."""
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


def backfill_after_recovery():
    """Replay recent messages and group files through the idempotent endpoint."""
    if not QQ_GROUP_IDS or not ONEBOT_EVENT_URL or not TOKEN:
        return {
            "replayed": 0, "created": 0, "duplicates": 0, "ignored": 0,
            "errors": 0, "file_replayed": 0, "file_created": 0,
        }
    cutoff = int(time.time()) - QQ_RECOVERY_BACKFILL_DAYS * 86400
    counts = {
        "replayed": 0, "created": 0, "duplicates": 0, "ignored": 0,
        "errors": 0, "file_replayed": 0, "file_created": 0,
    }
    try:
        self_id = int(napcat_api("get_login_info").get("user_id") or 0)
    except Exception:
        self_id = 0
    for group_id in QQ_GROUP_IDS:
        try:
            messages = recent_group_messages(group_id, cutoff)
        except Exception as exc:
            counts["errors"] += 1
            print(f"QQ recovery history read failed for group {group_id}: {type(exc).__name__}", flush=True)
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
            except Exception as exc:
                counts["errors"] += 1
                print(f"QQ recovery replay failed: {type(exc).__name__}", flush=True)
        try:
            files = recent_group_files(group_id, cutoff)
        except Exception as exc:
            counts["errors"] += 1
            print(f"QQ recovery file list failed for group {group_id}: {type(exc).__name__}", flush=True)
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
            except Exception as exc:
                counts["errors"] += 1
                print(f"QQ recovery file replay failed: {type(exc).__name__}", flush=True)
    return counts

def mail(subject, text, attach=False):
    if not TO or not os.getenv("SMTP_PASS"):
        print("alert email not configured", flush=True); return
    msg = EmailMessage(); msg["Subject"] = subject; msg["From"] = os.getenv("SMTP_FROM", "5656AI <" + os.getenv("SMTP_USER", "") + ">"); msg["To"] = TO; msg.set_content(text)
    if attach and QR.exists(): msg.add_attachment(QR.read_bytes(), maintype="image", subtype="png", filename="qq-login-qrcode.png")
    with smtplib.SMTP_SSL(os.getenv("SMTP_HOST", "smtpdm.aliyun.com"), int(os.getenv("SMTP_PORT", "465")), timeout=20) as s:
        s.login(os.getenv("SMTP_USER", ""), os.getenv("SMTP_PASS")); s.send_message(msg)

def report_status(ok, name, detail=""):
    """向个人助手上报采集心跳；失败不能影响 QQ 登录监控和告警。"""
    if not ASSISTANT_STATUS_URL or not ASSISTANT_STATUS_SECRET:
        return
    payload = json.dumps({
        "connected": bool(ok),
        "accountLabel": str(name or "QQ")[:100],
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "detail": str(detail or "")[:300],
    }).encode("utf-8")
    req = urllib.request.Request(
        ASSISTANT_STATUS_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Integration-Token": ASSISTANT_STATUS_SECRET,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as exc:
        print(f"assistant status heartbeat failed: {exc}", flush=True)

def main():
    last = json.loads(STATE.read_text()) if STATE.exists() else {"ok": None}
    while True:
        detail = ""
        try: ok, name = login_ok()
        except Exception as e:
            ok, name, detail = False, "QQ", type(e).__name__
        report_status(ok, name, detail)
        now = time.time()
        qr_mtime = QR.stat().st_mtime if QR.exists() else 0
        if ok and not last.get("ok"):
            backfill = backfill_after_recovery()
            mail(
                "QQ群采集已恢复",
                f"QQ 群采集账号（{name}）已重新登录，实时消息同步已恢复。"
                f"\n已自动检查最近 {QQ_RECOVERY_BACKFILL_DAYS} 天的群消息："
                f"补入 {backfill['created']} 条，已有 {backfill['duplicates']} 条，"
                f"其中群文件补入 {backfill['file_created']} 个，"
                f"忽略 {backfill['ignored']} 条，错误 {backfill['errors']} 条。",
            )
            last = {"ok": True, "last_alert": now, "qr_mtime": qr_mtime, "offline_alert_count": 0}
        elif not ok:
            # 首次掉线立即提醒；持续离线时逐步延长到每天一次，避免固定频率打扰。
            alert_count = int(last.get("offline_alert_count") or 0)
            reminder_due = (
                last.get("ok") is not False
                or now - float(last.get("last_alert") or 0) >= offline_reminder_delay(alert_count)
            )
            if reminder_due:
                mail("QQ群采集需要重新登录（请扫码）", "QQ 群采集账号已掉线或登录态失效，请扫描附件二维码并授权登录。", True)
                last = {
                    "ok": False,
                    "last_alert": now,
                    "qr_mtime": qr_mtime,
                    "offline_alert_count": alert_count + 1,
                }
            elif qr_mtime and qr_mtime != last.get("qr_mtime"):
                last["qr_mtime"] = qr_mtime
        STATE.parent.mkdir(parents=True, exist_ok=True); STATE.write_text(json.dumps(last))
        time.sleep(60)

if __name__ == "__main__": main()
