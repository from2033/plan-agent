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

def login_ok():
    req = urllib.request.Request(API + "/get_login_info", data=b"{}", headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.load(r).get("data") or {}
    return bool(data.get("user_id")), str(data.get("nickname") or data.get("user_id") or "QQ")

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
            mail("QQ群采集已恢复", f"QQ 群采集账号（{name}）已重新登录，消息同步已恢复。")
            last = {"ok": True, "last_alert": now, "qr_mtime": qr_mtime}
        elif not ok:
            # 二维码会刷新；即使一直未登录，也按冷却时间重复提醒，避免邮件中的二维码过期后无人处理。
            stale = now - float(last.get("last_alert") or 0) >= 1800
            refreshed = qr_mtime and qr_mtime != last.get("qr_mtime")
            if last.get("ok") is not False or stale or refreshed:
                mail("QQ群采集需要重新登录（请扫码）", "QQ 群采集账号已掉线或登录态失效，请扫描附件二维码并授权登录。", True)
                last = {"ok": False, "last_alert": now, "qr_mtime": qr_mtime}
        STATE.parent.mkdir(parents=True, exist_ok=True); STATE.write_text(json.dumps(last))
        time.sleep(60)

if __name__ == "__main__": main()
