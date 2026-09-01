import hashlib
import hmac
import unittest

from onebot_auth import authorize_onebot


class OneBotAuthenticationTest(unittest.TestCase):
    def setUp(self):
        self.token = "test-onebot-token"
        self.body = b'{"post_type":"message","message_id":1}'

    def test_accepts_napcat_hmac_signature(self):
        signature = hmac.new(
            self.token.encode(), self.body, hashlib.sha1
        ).hexdigest()
        self.assertTrue(
            authorize_onebot(
                self.token, self.body, x_signature=f"sha1={signature}"
            )
        )

    def test_rejects_signature_for_modified_body(self):
        signature = hmac.new(
            self.token.encode(), self.body, hashlib.sha1
        ).hexdigest()
        self.assertFalse(
            authorize_onebot(
                self.token,
                self.body + b" ",
                x_signature=f"sha1={signature}",
            )
        )

    def test_keeps_bearer_and_access_token_compatibility(self):
        self.assertTrue(
            authorize_onebot(
                self.token, self.body, authorization=f"Bearer {self.token}"
            )
        )
        self.assertTrue(
            authorize_onebot(
                self.token, self.body, x_access_token=self.token
            )
        )

    def test_rejects_missing_or_invalid_credentials(self):
        self.assertFalse(authorize_onebot(self.token, self.body))
        self.assertFalse(
            authorize_onebot(
                self.token, self.body, x_signature="sha1=not-valid"
            )
        )


if __name__ == "__main__":
    unittest.main()
