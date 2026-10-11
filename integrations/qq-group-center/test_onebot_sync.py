import contextlib
from datetime import datetime
import importlib.util
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path


class _Router:
    def post(self, *_args, **_kwargs):
        return lambda fn: fn

    def get(self, *_args, **_kwargs):
        return lambda fn: fn


class _Response:
    def __init__(self, client):
        self.client = client

    def raise_for_status(self):
        if self.client.failures:
            self.client.failures -= 1
            raise RuntimeError("temporary failure")


class _AsyncClient:
    calls = 0
    failures = 0

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, *_args, **_kwargs):
        type(self).calls += 1
        return _Response(type(self))


def _load_onebot(database_path: Path):
    @contextlib.contextmanager
    def database():
        connection = sqlite3.connect(database_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    config = types.SimpleNamespace(
        ASSISTANT_TASK_SYNC_URL="https://assistant.example/api/integrations/qq-tasks",
        ASSISTANT_TASK_SYNC_SECRET="secret",
        QQ_GROUP_NAMES={},
    )
    fastapi = types.SimpleNamespace(
        APIRouter=lambda **_kwargs: _Router(),
        Header=lambda default=None: default,
        HTTPException=RuntimeError,
        Request=object,
    )
    httpx = types.SimpleNamespace(AsyncClient=_AsyncClient)
    db_module = types.SimpleNamespace(db=database)
    module_path = Path(__file__).with_name("onebot.py")
    spec = importlib.util.spec_from_file_location("onebot_sync_test_module", module_path)
    module = importlib.util.module_from_spec(spec)
    with unittest.mock.patch.dict(sys.modules, {
        "config": config,
        "db": db_module,
        "fastapi": fastapi,
        "httpx": httpx,
    }):
        sys.path.insert(0, str(module_path.parent))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
    return module


class AssistantSyncReceiptTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.module = _load_onebot(Path(self.tempdir.name) / "app.db")
        _AsyncClient.calls = 0
        _AsyncClient.failures = 0

    def tearDown(self):
        self.tempdir.cleanup()

    async def _sync(self):
        return await self.module._sync_assistant_task(
            receipt_key="message:42:task",
            external_id="qq-message-42",
            group_id="100",
            group_name="测试群",
            sender="老师",
            content="明天交作业",
            timestamp=1788200000,
        )

    async def test_successful_sync_is_sent_only_once(self):
        self.assertTrue(await self._sync())
        self.assertTrue(await self._sync())
        self.assertEqual(_AsyncClient.calls, 1)

    async def test_failed_sync_remains_retryable(self):
        _AsyncClient.failures = 1
        self.assertFalse(await self._sync())
        self.assertTrue(await self._sync())
        self.assertEqual(_AsyncClient.calls, 2)


class SubjectExtractionTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.module = _load_onebot(Path(self.tempdir.name) / "app.db")

    def tearDown(self):
        self.tempdir.cleanup()

    def test_subject_is_inferred_for_printable_message_image(self):
        self.assertEqual(self.module._guess_subject("今天数学作业：口算第 3 页"), "数学")
        self.assertEqual(self.module._guess_subject("默写 1-20 号单词"), "英语")
        self.assertIsNone(self.module._guess_subject("明天带水杯"))

    def test_qq_timestamp_is_rendered_in_shanghai_time(self):
        value = datetime.fromtimestamp(0, self.module.SHANGHAI_TZ)
        self.assertEqual(value.strftime("%Y-%m-%d %H:%M"), "1970-01-01 08:00")


if __name__ == "__main__":
    unittest.main()
