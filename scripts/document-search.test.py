#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).with_name("document-search.py")


class EmbeddingHandler(BaseHTTPRequestHandler):
    requests = []

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        inputs = payload.get("input", [])
        if isinstance(inputs, str):
            inputs = [inputs]
        type(self).requests.append(inputs)
        embeddings = []
        for value in inputs:
            if any(term in value for term in ["舒筋健络油", "祛风活血", "运动后浑身难受"]):
                embeddings.append([1.0, 0.0, 0.0])
            elif any(term in value for term in ["租赁合同", "房租", "到期"]):
                embeddings.append([0.0, 1.0, 0.0])
            else:
                embeddings.append([0.0, 0.0, 1.0])
        response = json.dumps({"embeddings": embeddings}).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format, *_args):
        pass


class HybridSearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        EmbeddingHandler.requests = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), EmbeddingHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.embedding_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-hybrid-search-")
        self.vault = Path(self.temporary.name)
        notes = self.vault / "资料"
        notes.mkdir(parents=True)
        (notes / "药品.md").write_text(
            "---\ndocument_id: \"drug-1\"\ntitle: \"舒筋健络油说明\"\ncategory: \"医疗健康\"\n---\n"
            "# 摘要\n这是一种外用药，原文记载具有祛风活血、消肿止痛的作用。\n",
            encoding="utf-8",
        )
        (notes / "合同.md").write_text(
            "---\ndocument_id: \"contract-1\"\ntitle: \"房屋租赁合同\"\ncategory: \"合同\"\n---\n"
            "# 租期\n房屋租赁期限到 2027 年 8 月 31 日。\n",
            encoding="utf-8",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def search(self, question, vector=True, vault=None):
        command = [
            sys.executable,
            str(SCRIPT),
            "--vault", str(vault or self.vault),
            "--question", question,
            "--limit", "6",
        ]
        if vector:
            command.extend([
                "--embedding-url", self.embedding_url,
                "--embedding-model", "test-embedding",
            ])
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
        return json.loads(completed.stdout)

    def test_semantic_query_finds_a_document_without_shared_keywords(self):
        results = self.search("运动后浑身难受时擦的是什么？")
        self.assertEqual(results[0]["documentId"], "drug-1")
        self.assertIn(results[0]["matchType"], ["vector", "hybrid"])

    def test_unchanged_documents_are_not_embedded_again(self):
        self.search("运动后浑身难受时擦的是什么？")
        before = len(EmbeddingHandler.requests)
        self.search("运动后浑身难受时擦的是什么？")
        new_requests = EmbeddingHandler.requests[before:]
        self.assertEqual(len(new_requests), 1)
        self.assertEqual(len(new_requests[0]), 1)

    def test_exact_text_search_still_works_without_vector_service(self):
        results = self.search("合同到期日期", vector=False)
        self.assertEqual(results[0]["documentId"], "contract-1")
        self.assertEqual(results[0]["matchType"], "text")

    def test_another_account_vault_cannot_see_indexed_documents(self):
        other_vault = self.vault / "other-account"
        other_vault.mkdir()
        results = self.search("运动后浑身难受时擦的是什么？", vault=other_vault)
        self.assertEqual(results, [])


if __name__ == "__main__":
    unittest.main()
