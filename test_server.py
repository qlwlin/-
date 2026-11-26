"""隔离临时数据库的端到端接口验证：python -E -m unittest -v test_server。"""
import http.cookiejar
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import build_opener, HTTPCookieProcessor, Request
from urllib.error import HTTPError
import server


class MockModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer test-secret-only":
            self.send_response(401)
            self.end_headers()
            return
        result = json.dumps({"choices": [{"message": {"content": "我记得月亮湾，也谢谢你记得我。"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(result)))
        self.end_headers()
        self.wfile.write(result)


class FullFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.old_db = server.DB
        server.DB = Path(cls.temp.name) / "game.sqlite3"
        server.initialize()
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.http.login_attempts = {}
        cls.mock = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        for instance in (cls.http, cls.mock):
            threading.Thread(target=instance.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"
        cls.model_base = f"http://127.0.0.1:{cls.mock.server_port}/v1"

    @classmethod
    def tearDownClass(cls):
        for instance in (cls.http, cls.mock):
            instance.shutdown()
            instance.server_close()
        server.DB = cls.old_db
        cls.temp.cleanup()

    def client(self):
        return build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, client, path, data=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        req = Request(self.base + "/api/" + path, data=None if data is None else json.dumps(data).encode(),
                      headers=headers)
        try:
            with client.open(req, timeout=35) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_complete_account_modes_and_save_flow(self):
        a, b = self.client(), self.client()
        account = {"username": "WinterPlayer", "password": "winter12345"}
        self.assertEqual(self.request(a, "action", {"action": "collect", "revision": 0})[0], 401)
        status, state = self.request(a, "register", account)
        self.assertEqual(status, 200)
        self.assertEqual(state["settings"]["mode"], "pending")
        self.assertEqual(self.request(b, "register", {**account, "username": "winterplayer"})[0], 409)
        status, message = self.request(b, "login", {**account, "password": "badpassword"})
        self.assertEqual(status, 401)
        self.assertIn("密码输入错误", message["error"])
        self.assertEqual(self.request(b, "login", {**account, "username": "NoSuchPlayer"})[0], 404)
        self.assertEqual(self.request(a, "mode", {"mode": "offline"}, "https://evil.example")[0], 403)
        self.assertEqual(self.request(a, "mode", {"mode": "local"})[0], 400)
        status, state = self.request(a, "mode", {"mode": "offline"})
        self.assertEqual(state["settings"]["mode"], "offline")

        def action(kind, **data):
            nonlocal state
            status, result = self.request(a, "action", {"action": kind, "revision": state["revision"], **data})
            self.assertEqual(status, 200, result)
            state = result

        action("collect")
        action("journal", text="发现了一位等钟声的小孩。")
        self.assertEqual(self.request(a, "action", {"action": "collect", "revision": 0})[0], 409)
        action("chat", text="钟怎么不响了？")
        self.assertIn("阁楼", state["progress"]["chat"][-1]["content"])
        for location in ("hall", "gears", "attic", "dock"):
            action("travel", location=location)
            action("collect")
        self.assertEqual(self.request(a, "action", {"action": "wish", "wish": "travel", "revision": state["revision"]})[0], 400)
        action("wish", wish="remember")
        self.assertTrue(state["progress"]["ending"])
        saved = state["progress"].copy()
        self.assertEqual(self.request(a, "logout", {})[0], 200)
        self.assertFalse(self.request(a, "session")[1]["authenticated"])
        server.initialize()  # 重复启动不清除已有存档。
        status, state = self.request(a, "login", account)
        self.assertEqual(status, 200)
        self.assertEqual(state["progress"], saved)
        self.assertTrue(state["choose_mode"])
        self.request(b, "register", {"username": "AnotherPlayer", "password": "winter12345"})
        self.assertEqual(self.request(b, "session")[1]["progress"]["clues"], [])
        self.request(b, "mode", {"mode": "offline"})
        self.request(b, "action", {"action": "journal", "text": "另一个账号的日记", "revision": 0})
        self.assertEqual(self.request(a, "session")[1]["progress"], saved)
        with server.connect() as conn:
            row = conn.execute("SELECT password_hash,salt FROM users WHERE username=?", (account["username"],)).fetchone()
            self.assertNotEqual(row["password_hash"], account["password"])

        status, error = self.request(a, "config", {"base_url": self.model_base, "model": "mock-model", "key": "wrong-key"})
        self.assertEqual(status, 502)
        self.assertIn("密钥无效", error["error"])
        self.assertEqual(self.request(a, "session")[1]["settings"]["mode"], "offline")
        status, state = self.request(a, "config", {"base_url": self.model_base, "model": "mock-model", "key": "test-secret-only"})
        self.assertEqual(status, 200, state)
        self.assertEqual(state["settings"]["mode"], "local")
        self.assertNotIn("key", json.dumps(state))
        with server.connect() as conn:
            value = conn.execute("SELECT encrypted_key FROM settings WHERE mode='local'").fetchone()[0]
            self.assertNotIn("test-secret-only", value)
            self.assertEqual(server.protect_key(value, True), "test-secret-only")
        action("chat", text="你还记得月亮湾吗？")
        self.assertEqual(state["progress"]["chat"][-1]["content"], "我记得月亮湾，也谢谢你记得我。")
        self.assertEqual(self.request(a, "session")[1]["progress"]["chat"], state["progress"]["chat"])
        self.request(a, "mode", {"mode": "offline"})
        self.assertEqual(self.request(a, "session")[1]["settings"]["mode"], "offline")


if __name__ == "__main__":
    unittest.main()
