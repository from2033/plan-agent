import unittest
from unittest.mock import patch

import qq_monitor


class LoginStateTest(unittest.TestCase):
    def test_offline_reminder_delay_grows_and_caps_at_one_day(self):
        self.assertEqual(qq_monitor.offline_reminder_delay(1), 1800)
        self.assertEqual(qq_monitor.offline_reminder_delay(2), 3600)
        self.assertEqual(qq_monitor.offline_reminder_delay(3), 7200)
        self.assertEqual(qq_monitor.offline_reminder_delay(6), 43200)
        self.assertEqual(qq_monitor.offline_reminder_delay(7), 86400)
        self.assertEqual(qq_monitor.offline_reminder_delay(20), 86400)

    def test_cached_account_does_not_mask_offline_status(self):
        def response(action):
            if action == "get_status":
                return {"online": False, "good": True}
            return {"user_id": 12345, "nickname": "课程咨询"}

        with patch.object(qq_monitor, "napcat_api", side_effect=response):
            self.assertEqual(qq_monitor.login_ok(), (False, "课程咨询"))

    def test_online_status_keeps_account_label(self):
        def response(action):
            if action == "get_status":
                return {"online": True, "good": True}
            return {"user_id": 12345, "nickname": "课程咨询"}

        with patch.object(qq_monitor, "napcat_api", side_effect=response):
            self.assertEqual(qq_monitor.login_ok(), (True, "课程咨询"))

    def test_account_lookup_failure_does_not_hide_online_state(self):
        def response(action):
            if action == "get_status":
                return {"online": True, "good": True}
            raise TimeoutError("login info timed out")

        with patch.object(qq_monitor, "napcat_api", side_effect=response):
            self.assertEqual(qq_monitor.login_ok(), (True, "QQ"))

    def test_recent_history_stops_at_cutoff_and_deduplicates(self):
        pages = [
            {"messages": [
                {"message_id": 2, "message_seq": 20, "time": 200},
                {"message_id": 3, "message_seq": 30, "time": 300},
            ]},
            {"messages": [
                {"message_id": 1, "message_seq": 10, "time": 50},
                {"message_id": 2, "message_seq": 20, "time": 200},
            ]},
        ]
        with patch.object(qq_monitor, "napcat_api", side_effect=pages):
            messages = qq_monitor.recent_group_messages("123", 100)
        self.assertEqual([item["message_id"] for item in messages], [2, 3])

    def test_recovery_backfill_replays_through_normal_onebot_endpoint(self):
        message = {
            "message_id": 7, "message_seq": 7, "time": 200,
            "sender": {"user_id": 8, "card": "王老师"},
            "message": [{"type": "text", "data": {"text": "作业"}}],
        }
        with patch.object(qq_monitor, "QQ_GROUP_IDS", ["123"]), \
             patch.object(qq_monitor, "TOKEN", "test-token"), \
             patch.object(qq_monitor.time, "time", return_value=300), \
             patch.object(qq_monitor, "napcat_api", return_value={"user_id": 9}), \
             patch.object(qq_monitor, "recent_group_messages", return_value=[message]), \
             patch.object(qq_monitor, "post_json", return_value={"status": "duplicate"}) as send:
            result = qq_monitor.backfill_after_recovery()
        self.assertEqual(result["duplicates"], 1)
        event = send.call_args.args[1]
        self.assertEqual(event["group_id"], 123)
        self.assertEqual(event["message_id"], 7)

    def test_recent_group_files_filters_old_files_and_walks_folders(self):
        root = {
            "files": [{"file_name": "old.docx", "size": 1, "modify_time": 90}],
            "folders": [{"folder_id": "homework"}],
        }
        folder = {
            "files": [{"file_name": "new.docx", "size": 2, "modify_time": 110}],
            "folders": [],
        }
        with patch.object(qq_monitor, "napcat_api", side_effect=[root, folder]):
            files = qq_monitor.recent_group_files("123", 100)
        self.assertEqual([item["file_name"] for item in files], ["new.docx"])

    def test_recovery_backfill_replays_recent_group_file(self):
        file_info = {
            "file_id": "file-1", "file_name": "homework.docx", "file_size": 123,
            "modify_time": 200, "uploader": 8, "uploader_name": "Teacher",
        }
        with patch.object(qq_monitor, "QQ_GROUP_IDS", ["123"]), \
             patch.object(qq_monitor, "TOKEN", "test-token"), \
             patch.object(qq_monitor.time, "time", return_value=300), \
             patch.object(qq_monitor, "napcat_api", return_value={"user_id": 9}), \
             patch.object(qq_monitor, "recent_group_messages", return_value=[]), \
             patch.object(qq_monitor, "recent_group_files", return_value=[file_info]), \
             patch.object(qq_monitor, "post_json", return_value={"status": "ok"}) as send:
            result = qq_monitor.backfill_after_recovery()
        self.assertEqual(result["file_created"], 1)
        event = send.call_args.args[1]
        self.assertEqual(event["notice_type"], "group_upload")
        self.assertEqual(event["file"]["name"], "homework.docx")


if __name__ == "__main__":
    unittest.main()
