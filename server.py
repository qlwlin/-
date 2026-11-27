"""苹果镇本地服务：Python 3.12+，无第三方依赖。"""
import argparse
import base64
import ctypes
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import Request
from urllib.error import HTTPError, URLError
import game

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "apple-town.sqlite3"


class GameError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


@contextmanager
def connect():
    conn = sqlite3.connect(DB, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    DB.parent.mkdir(exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
            expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id), mode TEXT NOT NULL DEFAULT 'pending',
            base_url TEXT, model TEXT, encrypted_key TEXT);
        CREATE TABLE IF NOT EXISTS saves (
            user_id INTEGER PRIMARY KEY REFERENCES users(id), progress TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS manual_slots (
            user_id INTEGER NOT NULL REFERENCES users(id), slot INTEGER NOT NULL,
            progress TEXT NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(user_id,slot));
        CREATE TABLE IF NOT EXISTS legacy_saves (
            user_id INTEGER PRIMARY KEY REFERENCES users(id), progress TEXT NOT NULL,
            updated_at INTEGER NOT NULL);
        """)
        for row in conn.execute("SELECT * FROM saves").fetchall():
            progress = json.loads(row["progress"])
            if progress.get("schema") != game.VERSION:
                conn.execute("INSERT OR IGNORE INTO legacy_saves VALUES(?,?,?)",
                             (row["user_id"], row["progress"], row["updated_at"]))
                conn.execute("UPDATE saves SET progress=?, revision=revision+1 WHERE user_id=?",
                             (json.dumps(game.new_game(), ensure_ascii=False), row["user_id"]))


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600000).hex()


def protect_key(value, decrypt=False):
    """使用 Windows DPAPI；密钥仅能由当前 Windows 用户解密。"""
    if os.name != "nt":
        raise GameError("保存 API 密钥目前需要 Windows；你仍可使用离线模式。")

    class Blob(ctypes.Structure):
        _fields_ = [("size", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    raw = base64.b64decode(value) if decrypt else value.encode()
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    if not ok:
        raise GameError("无法读取或保存密钥，请重新配置 API。")
    try:
        data = ctypes.string_at(result.data, result.size)
        return data.decode() if decrypt else base64.b64encode(data).decode()
    finally:
        ctypes.windll.kernel32.LocalFree(result.data)


def api_url(base_url):
    parts = urlsplit(base_url)
    if (parts.scheme not in ("https", "http") or not parts.hostname or parts.username
            or parts.password or parts.query or parts.fragment):
        raise GameError("请输入有效的 API 基础地址，例如 https://api.openai.com/v1。")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise GameError("远程 API 地址必须使用 HTTPS；本机模型可以使用 HTTP。")
    return base_url.rstrip("/") + "/chat/completions"


def completion(base_url, model, key, messages, max_tokens=220):
    endpoint = api_url(base_url)
    body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens,
                       "stream": False}).encode()
    req = Request(endpoint, data=body, headers={"Authorization": f"Bearer {key}",
                                              "Content-Type": "application/json"}, method="POST")
    # 不跟随重定向，避免密钥被转发到其他地址。
    from urllib.request import build_opener, HTTPRedirectHandler
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with build_opener(NoRedirect).open(req, timeout=30) as response:
            data = json.loads(response.read(1024 * 1024))
        content = data["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError()
        return content.strip()[:4000]
    except HTTPError as exc:
        messages_by_code = {401: "API 密钥无效或已过期。", 403: "API 无访问权限，请检查密钥和模型。",
                            404: "API 地址或模型不存在。", 429: "API 配额不足或请求过于频繁。"}
        raise GameError(messages_by_code.get(exc.code, f"API 返回错误（HTTP {exc.code}），请检查配置。"), 502)
    except (URLError, TimeoutError, OSError):
        raise GameError("无法连接 API，请检查地址、网络或本机模型服务。", 502)
    except (ValueError, KeyError, IndexError, TypeError):
        raise GameError("API 返回格式不兼容，需要 OpenAI Chat Completions 接口。", 502)


def new_progress():
    return game.new_game()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # 不输出请求正文、账号或密钥。
        pass

    def send_json(self, data, status=200, cookie=None):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def body(self):
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise GameError("请求格式不正确。", 415)
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 20000:
            raise GameError("请求内容过长或为空。")
        try:
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (ValueError, UnicodeError):
            raise GameError("请求内容无效。")

    def user_id(self, conn):
        cookie = self.headers.get("Cookie", "")
        token = next((part.strip()[8:] for part in cookie.split(";")
                      if part.strip().startswith("session=")), "")
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        row = conn.execute("SELECT user_id FROM sessions WHERE token_hash=? AND expires>?",
                           (token_hash, int(time.time()))).fetchone()
        if not row:
            raise GameError("请先登录，或重新登录已过期的账号。", 401)
        return row["user_id"]

    def state(self, conn, uid):
        user = conn.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
        settings = conn.execute("SELECT mode,base_url,model FROM settings WHERE user_id=?", (uid,)).fetchone()
        save = conn.execute("SELECT * FROM saves WHERE user_id=?", (uid,)).fetchone()
        progress = json.loads(save["progress"])
        slots = []
        for slot in conn.execute("SELECT * FROM manual_slots WHERE user_id=? ORDER BY slot", (uid,)):
            sp = json.loads(slot["progress"])
            slots.append(dict(slot=slot["slot"], alias=sp["alias"],
                              phase=game.PHASES[sp["phase"]], updated_at=slot["updated_at"]))
        return {"username": user["username"], "settings": dict(settings),
                "progress": progress, "revision": save["revision"], "world": game.view(progress), "slots": slots,
                "updated_at": save["updated_at"]}

    def check_origin(self):
        host = self.headers.get("Host", "")
        if host not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"):
            raise GameError("只允许从本机地址访问。", 403)
        origin = self.headers.get("Origin")
        if origin and origin not in (f"http://127.0.0.1:{self.server.server_port}",
                                     f"http://localhost:{self.server.server_port}"):
            raise GameError("不允许跨站访问。", 403)

    def do_GET(self):
        try:
            self.check_origin()
            path = urlsplit(self.path).path
            if path == "/api/session":
                with connect() as conn:
                    try:
                        self.send_json(self.state(conn, self.user_id(conn)))
                    except GameError as exc:
                        if exc.status != 401:
                            raise
                        self.send_json({"authenticated": False})
                return
            files = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                     "/style.css": ("style.css", "text/css"),
                     "/login.css": ("login.css", "text/css"),
                     "/login-scene.js": ("login-scene.js", "text/javascript"),
                     "/scene.js": ("scene.js", "text/javascript")}
            if path not in files:
                raise GameError("页面不存在。", 404)
            name, content_type = files[path]
            data = (ROOT / "web" / name).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(data)
        except GameError as exc:
            self.send_json({"error": exc.message}, exc.status)

    def do_POST(self):
        try:
            self.check_origin()
            data = self.body()
            path = urlsplit(self.path).path
            with connect() as conn:
                if path in ("/api/register", "/api/login"):
                    self.authenticate(conn, path, data)
                    return
                uid = self.user_id(conn)
                if path == "/api/logout":
                    token = next((p.strip()[8:] for p in self.headers.get("Cookie", "").split(";")
                                  if p.strip().startswith("session=")), "")
                    conn.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
                    conn.commit()
                    self.send_json({"ok": True}, cookie="session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
                elif path == "/api/mode":
                    if data.get("mode") != "offline":
                        raise GameError("请选择离线模式，或验证 API 后进入本地模式。")
                    conn.execute("UPDATE settings SET mode='offline' WHERE user_id=?", (uid,))
                    conn.commit()
                    self.send_json(self.state(conn, uid))
                elif path == "/api/config":
                    base = str(data.get("base_url", "")).strip()
                    model = str(data.get("model", "")).strip()
                    key = str(data.get("key", "")).strip()
                    if not model or len(model) > 200 or not key or len(key) > 4096 or len(base) > 1000:
                        raise GameError("请填写 API 地址、模型名称和密钥。")
                    completion(base, model, key, [{"role": "user", "content": "请简短回复：连接成功。"}], 32)
                    encrypted = protect_key(key)
                    conn.execute("UPDATE settings SET mode='local',base_url=?,model=?,encrypted_key=? WHERE user_id=?",
                                 (base.rstrip("/"), model, encrypted, uid))
                    conn.commit()
                    self.send_json(self.state(conn, uid))
                elif path == "/api/action":
                    self.action(conn, uid, data)
                else:
                    raise GameError("接口不存在。", 404)
        except GameError as exc:
            self.send_json({"error": exc.message}, exc.status)
        except (ValueError, sqlite3.Error):
            self.send_json({"error": "请求无法完成，请刷新后重试。"}, 400)
        except Exception:
            self.send_json({"error": "服务暂时无法完成请求，请重试。"}, 500)

    def authenticate(self, conn, path, data):
        username, password = data.get("username", ""), data.get("password", "")
        if not isinstance(username, str) or not isinstance(password, str):
            raise GameError("账号和密码格式无效。")
        username = username.strip()
        if not re.fullmatch(r"[\w\u4e00-\u9fff-]{3,24}", username):
            raise GameError("账号需为 3–24 位中文、字母、数字、下划线或短横线。")
        if not 8 <= len(password) <= 128:
            raise GameError("密码需为 8–128 位。")
        now = int(time.time())
        if path == "/api/register":
            salt = secrets.token_hex(16)
            hashed = password_hash(password, salt)
            try:
                cursor = conn.execute("INSERT INTO users(username,salt,password_hash,created_at) VALUES(?,?,?,?)",
                                      (username, salt, hashed, now))
            except sqlite3.IntegrityError:
                raise GameError("该账号已经注册，请切换到登录。", 409)
            uid = cursor.lastrowid
            conn.execute("INSERT INTO settings(user_id) VALUES(?)", (uid,))
            conn.execute("INSERT INTO saves(user_id,progress,updated_at) VALUES(?,?,?)",
                         (uid, json.dumps(new_progress(), ensure_ascii=False), now))
        else:
            # 有限登录节流，避免本机密码暴力尝试。
            attempts = self.server.login_attempts
            bucket = username.casefold()
            recent = [t for t in attempts.get(bucket, []) if now - t < 60]
            if len(recent) >= 8:
                raise GameError("尝试次数过多，请一分钟后再试。", 429)
            row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
            if not row:
                attempts[bucket] = recent + [now]
                raise GameError("该账号尚未注册，请先创建账号。", 404)
            if not hmac.compare_digest(password_hash(password, row["salt"]), row["password_hash"]):
                attempts[bucket] = recent + [now]
                raise GameError("密码输入错误，请重新输入。", 401)
            attempts.pop(bucket, None)
            uid = row["id"]
        token = secrets.token_urlsafe(32)
        conn.execute("DELETE FROM sessions WHERE expires<=?", (now,))
        conn.execute("INSERT INTO sessions VALUES(?,?,?)",
                     (hashlib.sha256(token.encode()).hexdigest(), uid, now + 7 * 86400))
        conn.commit()
        state = self.state(conn, uid)
        state["choose_mode"] = True
        self.send_json(state, cookie=f"session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800")

    def action(self, conn, uid, data):
        state = self.state(conn, uid)
        if state["settings"]["mode"] == "pending":
            raise GameError("请先选择游戏模式。")
        if data.get("revision") != state["revision"]:
            raise GameError("存档已在其他窗口更新，请刷新读取最新进度。", 409)
        progress = state["progress"]
        action = data.get("action")
        try:
            if action in ("save_slot", "load_slot"):
                slot = data.get("slot")
                if slot not in (1, 2, 3):
                    raise GameError("请选择三幅挂画中的一幅。")
                game.get_object(progress, "save" + str(slot))
                if action == "save_slot":
                    conn.execute("INSERT INTO manual_slots VALUES(?,?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET progress=excluded.progress,updated_at=excluded.updated_at",
                                 (uid, slot, json.dumps(progress, ensure_ascii=False), int(time.time())))
                    game.say(progress, "这一刻已存进挂画。")
                else:
                    saved = conn.execute("SELECT progress FROM manual_slots WHERE user_id=? AND slot=?", (uid, slot)).fetchone()
                    if not saved:
                        raise GameError("这幅挂画还没有存档。")
                    progress = json.loads(saved["progress"])
                    # 实时过程重新计时，关卡进度保留。
                    now = time.time()
                    for field in ("night_entered_at", "hall_at", "cutscene_at", "carousel_at", "oven_at"):
                        if progress.get(field):
                            progress[field] = now
                    progress.update(hold_at=None, noise=None, last_move=0)
                    game.say(progress, "已读入挂画里的故事。")
            else:
                ai = None
                if state["settings"]["mode"] == "local":
                    settings = conn.execute("SELECT * FROM settings WHERE user_id=?", (uid,)).fetchone()
                    def ai(prompt, history, text):
                        return completion(settings["base_url"], settings["model"],
                                          protect_key(settings["encrypted_key"], True),
                                          [{"role": "system", "content": prompt}] + history
                                          + [{"role": "user", "content": text}], 160)
                game.act(progress, data, ai)
        except game.RuleError as exc:
            raise GameError(str(exc))
        # 条件更新防止多个窗口/慢速 API 请求覆盖较新存档。
        cursor = conn.execute("UPDATE saves SET progress=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?",
                              (json.dumps(progress, ensure_ascii=False), int(time.time()), uid, state["revision"]))
        if cursor.rowcount != 1:
            raise GameError("存档已更新，请刷新后重试。", 409)
        conn.commit()
        self.send_json(self.state(conn, uid))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    initialize()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.login_attempts = {}
    print(f"苹果镇已启动：http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
