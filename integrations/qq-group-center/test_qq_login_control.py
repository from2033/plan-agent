import unittest
from unittest.mock import patch

import qq_login_control
from qq_login_control import without_login_credentials


class LoginControlTest(unittest.TestCase):
    def test_only_login_fields_are_blank(self):
        source = "ACCOUNT=123456\nNAPCAT_QUICK_PASSWORD_MD5=secret\nOTHER=value\n"
        self.assertEqual(
            without_login_credentials(source),
            "ACCOUNT=\nNAPCAT_QUICK_PASSWORD_MD5=\nOTHER=value\n",
        )

    def test_missing_login_fields_are_added(self):
        self.assertEqual(
            without_login_credentials("OTHER=value\n"),
            "OTHER=value\nACCOUNT=\nNAPCAT_QUICK_PASSWORD_MD5=\n",
        )

    def test_manual_sync_replays_history_through_idempotent_endpoint(self):
        message = {
            "message_id": 7,
            "message_seq": 7,
            "time": 200,
            "sender": {"user_id": 8, "card": "王老师"},
            "message": [{"type": "text", "data": {"text": "作业"}}],
        }

        def napcat(action, _payload=None):
            if action == "get_login_info":
                return {"user_id": 9}
            return {"online": True}

        with patch.object(qq_login_control, "QQ_GROUP_IDS", ["123"]), \
             patch.object(qq_login_control, "ONEBOT_TOKEN", "test-token"), \
             patch.object(qq_login_control, "is_online", return_value=True), \
             patch.object(qq_login_control, "napcat_api", side_effect=napcat), \
             patch.object(qq_login_control, "recent_group_messages", return_value=[message]), \
             patch.object(qq_login_control, "post_json", return_value={"status": "duplicate"}) as send:
            result = qq_login_control.sync_missed_messages()

        self.assertEqual(result["duplicates"], 1)
        event = send.call_args.args[1]
        self.assertEqual(event["group_id"], 123)
        self.assertEqual(event["message_id"], 7)

    def test_manual_sync_replays_recent_group_file(self):
        file_info = {
            "file_id": "file-1", "file_name": "homework.docx", "file_size": 123,
            "modify_time": 200, "uploader": 8, "uploader_name": "Teacher",
        }
        with patch.object(qq_login_control, "QQ_GROUP_IDS", ["123"]), \
             patch.object(qq_login_control, "ONEBOT_TOKEN", "test-token"), \
             patch.object(qq_login_control, "is_online", return_value=True), \
             patch.object(qq_login_control, "napcat_api", return_value={"user_id": 9}), \
             patch.object(qq_login_control, "recent_group_messages", return_value=[]), \
             patch.object(qq_login_control, "recent_group_files", return_value=[file_info]), \
             patch.object(qq_login_control, "post_json", return_value={"status": "ok"}) as send:
            result = qq_login_control.sync_missed_messages()
        self.assertEqual(result["file_created"], 1)
        event = send.call_args.args[1]
        self.assertEqual(event["notice_type"], "group_upload")
        self.assertEqual(event["file"]["name"], "homework.docx")


if __name__ == "__main__":
    unittest.main()
