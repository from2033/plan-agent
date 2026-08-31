import unittest
from unittest.mock import patch

import qq_monitor


class LoginStateTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
