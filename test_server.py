"""规则与账户接口回归。临时数据库、模型和时钟均隔离于真实存档。"""
import http.cookiejar
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import build_opener, HTTPCookieProcessor, Request
from urllib.error import HTTPError
from unittest.mock import patch
import game
import server


class RuleFlow(unittest.TestCase):
    def setUp(self):
        self.p = game.new_game()
        self.now = 1000

    def do(self, action, **data):
        self.now += 1
        game.act(self.p, dict(action=action, **data), now=self.now)

    def hit(self, key, **data):
        obj = next(o for o in game.objects(self.p) if o["id"] == key)
        self.p["position"] = [obj["x"], obj["y"]]  # 隔离规则测试：移动校验另测。
        self.do("interact", target=key, **data)

    def enter_town(self):
        self.do("alias", text="艾拉")
        self.hit("down")
        with self.assertRaises(game.RuleError):
            self.hit("park")
        self.hit("glasses")
        self.assertFalse(self.p["glasses"])
        self.do("glasses")
        self.hit("park")
        self.hit("square")
        self.hit("nora")
        self.assertTrue(self.p["met_nora"])
        self.hit("lanes")

    def visit(self, scene):
        if self.p["scene"] == scene:
            return
        if self.p["scene"] != "lanes":
            self.hit("out")
        self.hit(scene)

    def preparation(self, order):
        for module in order:
            if module == "puppets":
                self.visit("workshop"); self.hit("socks")
                self.visit("library"); self.hit("thread")
                self.visit("bakery"); self.hit("cotton")
                self.visit("flower"); self.hit("buttons")
                self.visit("workshop")
                for _ in range(7):
                    self.hit("sew")
                self.assertEqual(self.p["puppet_count"], 3)
                self.visit("community"); self.hit("puppet_stage")
            elif module == "backdrop":
                self.visit("flower"); self.hit("stairs"); self.hit("diary"); self.hit("stairs")
                self.visit("library"); self.hit("paint")
                self.visit("bakery"); self.hit("cardboard")
                with self.assertRaises(game.RuleError):
                    self.hit("upstairs")
                self.visit("community"); self.hit("backdrop")
            elif module == "curtain":
                self.visit("flower"); self.hit("rose")
                self.visit("community"); self.hit("curtain")
            elif module == "lights":
                self.visit("community"); self.hit("lightbox")
                self.visit("workshop"); self.hit("pliers"); self.hit("pliers")
                self.visit("community"); self.hit("install_lights")
            elif module == "cookies":
                self.visit("bakery")
                with self.assertRaises(game.RuleError):
                    self.hit("tray")
                for key in ("dough", "flatten", "tray", "oven"):
                    self.hit(key)
                self.now += 4
                self.hit("oven")
                self.visit("community"); self.hit("cookie_table")
            self.assertTrue(self.p["prepared"][module])
            self.assertLessEqual(len(self.p["inventory"]), 6)

    def test_full_story_two_preparation_orders(self):
        for order in (["puppets", "backdrop", "curtain", "lights", "cookies"],
                      ["lights", "cookies", "curtain", "backdrop", "puppets"]):
            with self.subTest(order=order):
                self.setUp()
                self.enter_town()
                self.preparation(order)
                self.assertEqual(self.p["phase"], "dusk")
                self.visit("flower")
                self.hit("wrapping", choice="星星")
                self.hit("wrapping")
                self.hit("wrapping")
                self.assertEqual(self.p["phase"], "night")
                self.assertIn("card", self.p["inventory"])
                self.hit("out"); self.hit("chimney")
                self.hit("stairs")
                self.hit("bedroom")
                self.hit("bedside")
                self.do("hold_card")
                with self.assertRaises(game.RuleError):
                    self.do("hold_card")
                self.do("hold_card")
                self.assertTrue(self.p["card_placed"])
                self.hit("out"); self.hit("down"); self.hit("chimney_out")
                self.assertEqual(self.p["phase"], "christmas")
                self.assertFalse(self.p["ending"])
                self.now += 40
                self.do("tick")
                self.assertTrue(self.p["ending"])
                self.do("restart")
                self.assertFalse(self.p["met_nora"])
                self.assertEqual(self.p["alias"], "艾拉")

    def test_tutorial_blocking_and_six_slots(self):
        self.enter_town()
        self.p["scene"], self.p["position"] = "park", [7, 7]
        self.do("glasses")
        with self.assertRaises(game.RuleError):
            self.do("move", position=[7.2, 7])
        self.do("glasses")
        self.do("move", position=[7.2, 7])
        for item in ("socks", "thread", "cotton", "buttons", "paint"):
            game.put(self.p, item)
        with self.assertRaises(game.RuleError):
            game.put(self.p, "coin")
        with self.assertRaises(game.RuleError):
            self.do("move", position=[1, 1])

    def test_card_noise_and_detection_preserve_progress(self):
        self.p.update(alias="艾拉", scene="night_bedroom", phase="night", position=[8.4, 3.2])
        game.put(self.p, "card")
        self.do("hold_card")
        self.hit("bed_glass")
        self.assertIsNone(self.p["hold_at"])
        self.p["position"] = [8.4, 3.2]
        self.do("hold_card", start=True)
        self.now += 10
        self.do("hold_card", start=True)  # 松开后重新按，不能沿用上次计时。
        with self.assertRaises(game.RuleError):
            self.do("hold_card")
        self.do("hold_card")
        self.assertTrue(self.p["card_placed"])
        self.p.update(scene="night_flower", position=[4, 1.8], night_entered_at=self.now)
        self.do("tick")
        self.assertEqual(self.p["detected"], 1)
        self.assertTrue(self.p["card_placed"])
        self.assertEqual(self.p["position"], [2, 8])
        self.p.update(hiding="hide_counter", position=[4, 1.8])
        self.do("tick")
        self.assertEqual(self.p["detected"], 1)
        self.assertTrue(game.occluded([3, 2], [3, 6], game.OBSTACLES["night_flower"]))
        self.p.update(scene="night_hall", hall_at=self.now - 15)
        self.assertIsNone(game.guard(self.p, self.now))

    def test_nora_fallback_and_no_backstage_context(self):
        self.p.update(alias="艾拉", scene="square", position=[4.2, 6.6])
        game.chat(self.p, "在写什么")
        with patch("game.fallback", wraps=game.fallback):
            def broken(*args):
                raise OSError("disconnected")
            game.chat(self.p, "舞台", broken)
            self.assertEqual(self.p["message"], "那个舞台是空的。我觉得空着有点可惜。")
        prompts = []
        def model(prompt, history, text):
            prompts.append(prompt)
            return "因为纸板能画成山。然后木偶就能走过去。"
        game.chat(self.p, "你会演吗", model)
        self.assertEqual(len(prompts), 1)
        self.assertNotIn("prepared", prompts[0])
        self.assertEqual(game.nora_scene(self.p), "park")


class MockModel(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        if self.headers.get("Authorization") != "Bearer test-secret-only":
            self.send_response(401); self.end_headers(); return
        body = json.dumps({"choices": [{"message": {"content": "因为纸板能画成山。然后木偶就能走过去。"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class AccountFlow(unittest.TestCase):
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

    @classmethod
    def tearDownClass(cls):
        for instance in (cls.http, cls.mock):
            instance.shutdown(); instance.server_close()
        server.DB = cls.old_db
        cls.temp.cleanup()

    def request(self, client, path, data=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        req = Request(self.base + "/api/" + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            with client.open(req, timeout=35) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_auth_config_three_slots_isolation_and_revisions(self):
        a = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        b = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        account = dict(username="WinterPlayer", password="winter12345")
        self.assertEqual(self.request(a, "action", dict(action="tick", revision=0))[0], 401)
        code, state = self.request(a, "register", account)
        self.assertEqual(code, 200)
        self.assertEqual(state["settings"]["mode"], "pending")
        self.assertEqual(self.request(b, "register", {**account, "username": "winterplayer"})[0], 409)
        self.assertEqual(self.request(b, "login", {**account, "password": "wrongwrong"})[0], 401)
        self.assertEqual(self.request(a, "mode", dict(mode="offline"), "https://evil.example")[0], 403)
        _, state = self.request(a, "mode", dict(mode="offline"))

        def action(kind, **data):
            nonlocal state
            code, state = self.request(a, "action", dict(action=kind, revision=state["revision"], **data))
            self.assertEqual(code, 200, state)

        action("alias", text="艾拉")
        # 移动请求逐步走到三幅挂画；冻结模拟时钟只用于测试。
        with patch("game.time.time", side_effect=iter(range(10000, 20000))):
            for slot, x in ((1, 1.4), (2, 3.6), (3, 5.8)):
                while True:
                    pos = state["progress"]["position"]
                    dist = ((pos[0]-x)**2+(pos[1]-1.2)**2)**.5
                    if dist < 1:
                        break
                    scale = min(1, 1.2 / dist)
                    action("move", position=[pos[0]+(x-pos[0])*scale, pos[1]+(1.2-pos[1])*scale])
                action("save_slot", slot=slot)
            action("journal", text="三幅画都有存档了")
            action("load_slot", slot=3)
        self.assertEqual(len(state["slots"]), 3)
        self.assertEqual(state["progress"]["journal"], "")
        self.assertEqual(self.request(a, "action", dict(action="tick", revision=0))[0], 409)
        saved = state["progress"].copy()
        self.request(a, "logout", {})
        self.assertFalse(self.request(a, "session")[1]["authenticated"])
        server.initialize()
        _, state = self.request(a, "login", account)
        self.assertEqual(saved, state["progress"])
        self.request(b, "register", dict(username="AnotherPlayer", password="winter12345"))
        self.assertEqual(self.request(b, "session")[1]["slots"], [])
        self.assertEqual(self.request(b, "session")[1]["progress"]["alias"], "")
        model_base = f"http://127.0.0.1:{self.mock.server_port}/v1"
        code, _ = self.request(a, "config", dict(base_url=model_base, model="mock-model", key="wrong"))
        self.assertEqual(code, 502)
        code, state = self.request(a, "config", dict(base_url=model_base, model="mock-model", key="test-secret-only"))
        self.assertEqual(code, 200)
        self.assertEqual(state["settings"]["mode"], "local")
        self.assertNotIn("test-secret-only", json.dumps(state))
        with server.connect() as conn:
            encrypted = conn.execute("SELECT encrypted_key FROM settings WHERE mode='local'").fetchone()[0]
            self.assertNotIn("test-secret-only", encrypted)
            self.assertEqual(server.protect_key(encrypted, True), "test-secret-only")
            row = conn.execute("SELECT password_hash FROM users WHERE username='WinterPlayer'").fetchone()
            self.assertNotEqual(row[0], account["password"])
            fixture = state["progress"].copy()
            fixture.update(scene="square", position=[4.2, 6.6], met_nora=True)
            conn.execute("UPDATE saves SET progress=? WHERE user_id=(SELECT id FROM users WHERE username='WinterPlayer')",
                         (json.dumps(fixture),))
        _, state = self.request(a, "session")
        action("chat", text="你会演吗")
        self.assertEqual(state["progress"]["chat"][-1]["content"], "因为纸板能画成山。然后木偶就能走过去。")

    def test_legacy_migration_preserves_users_settings_and_backup(self):
        with server.connect() as conn:
            conn.execute("INSERT INTO users(username,salt,password_hash,created_at) VALUES('LegacyPlayer','00','00',1)")
            uid = conn.execute("SELECT id FROM users WHERE username='LegacyPlayer'").fetchone()[0]
            conn.execute("INSERT INTO settings(user_id,mode) VALUES(?,'offline')", (uid,))
            old = json.dumps(dict(location="attic", clues=["C1"], journal="旧故事"))
            conn.execute("INSERT INTO saves(user_id,progress,updated_at) VALUES(?,?,1)", (uid, old))
        server.initialize()
        with server.connect() as conn:
            self.assertEqual(conn.execute("SELECT progress FROM legacy_saves WHERE user_id=?", (uid,)).fetchone()[0], old)
            current = json.loads(conn.execute("SELECT progress FROM saves WHERE user_id=?", (uid,)).fetchone()[0])
            self.assertEqual(current["story"], "puppet")
            self.assertEqual(conn.execute("SELECT mode FROM settings WHERE user_id=?", (uid,)).fetchone()[0], "offline")


if __name__ == "__main__":
    unittest.main()
