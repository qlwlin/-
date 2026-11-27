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
import ipaddress
from urllib.parse import quote, urlsplit, urlunsplit
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
        columns = {row[1] for row in conn.execute("PRAGMA table_info(settings)")}
        if "provider" not in columns:
            conn.execute("ALTER TABLE settings ADD COLUMN provider TEXT NOT NULL DEFAULT 'auto'")
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


PROVIDERS = ("auto", "openai", "anthropic", "gemini", "ollama")


def local_target(hostname):
    name = (hostname or "").strip("[]").lower()
    if name == "localhost":
        return True
    try:
        address = ipaddress.ip_address(name)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def conversation_endpoint(base_url, provider, model):
    """把基础地址或完整对话地址收成某一种模型接口。"""
    parts = urlsplit((base_url or "").strip())
    if (parts.scheme not in ("https", "http") or not parts.hostname
            or parts.username or parts.password or parts.fragment):
        raise GameError("请输入有效的接口地址。可以填服务商的基础地址，或完整的对话地址。")
    if parts.scheme == "http" and not local_target(parts.hostname):
        raise GameError("远程接口必须使用 HTTPS。本机或局域网的模型可以使用 HTTP。")
    kind = (provider or "auto").strip().lower()
    if kind not in PROVIDERS:
        raise GameError("不认识这种接口。请选择自动识别、OpenAI 兼容、Anthropic、Gemini 或 Ollama。")
    path = (parts.path or "").rstrip("/")
    low_host, low_path = parts.hostname.lower(), path.lower()
    if kind == "auto":
        if "anthropic.com" in low_host or low_path.endswith("/messages"):
            kind = "anthropic"
        elif ("googleapis.com" in low_host or "generativelanguage" in low_host
              or "generatecontent" in low_path):
            kind = "gemini"
        elif low_path.endswith("/api/chat"):
            kind = "ollama"
        else:
            kind = "openai"
    if kind == "openai" and not low_path.endswith("/chat/completions"):
        path += "/chat/completions"
    elif kind == "anthropic" and not low_path.endswith("/messages"):
        path += "/messages"
    elif kind == "ollama" and not low_path.endswith("/api/chat"):
        path += "/api/chat"
    elif kind == "gemini" and "generatecontent" not in low_path:
        if path in ("", "/v1", "/v1beta"):
            path = (path or "/v1beta") + "/models"
        elif not low_path.endswith("/models"):
            path += "/models"
        path += "/" + quote((model or "").strip(), safe="") + ":generateContent"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, "")), kind


def plain_messages(messages):
    cleaned = []
    for item in messages or []:
        if not isinstance(item, dict):
            continue
        role, content = item.get("role"), item.get("content")
        if role not in ("system", "user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content.strip()[:4000]})
    return cleaned


def merge_turns(turns):
    merged = []
    for turn in turns:
        if merged and merged[-1]["role"] == turn["role"]:
            merged[-1]["content"] += "\n" + turn["content"]
        else:
            merged.append(dict(turn))
    if merged and merged[0]["role"] != "user":
        merged.insert(0, {"role": "user", "content": "……"})
    return merged


def build_payloads(kind, model, messages, max_tokens):
    msgs = plain_messages(messages)
    if kind == "anthropic":
        system = "\n".join(item["content"] for item in msgs if item["role"] == "system")
        dialog = merge_turns([item for item in msgs if item["role"] != "system"])
        return [{"model": model, "max_tokens": max_tokens, "system": system, "messages": dialog}]
    if kind == "gemini":
        system = "\n".join(item["content"] for item in msgs if item["role"] == "system")
        dialog = []
        for item in msgs:
            if item["role"] == "system":
                continue
            role = "model" if item["role"] == "assistant" else "user"
            dialog.append({"role": role, "content": item["content"]})
        dialog = merge_turns(dialog)
        contents = [{"role": item["role"], "parts": [{"text": item["content"]}]} for item in dialog]
        body = {"contents": contents, "generationConfig": {"maxOutputTokens": max_tokens, "temperature": 0.8}}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        return [body]
    if kind == "ollama":
        return [{"model": model, "messages": msgs, "stream": False,
                 "options": {"temperature": 0.8, "num_predict": max_tokens}}]
    base = {"model": model, "messages": msgs, "stream": False}
    return [{**base, "max_tokens": max_tokens, "temperature": 0.8},
            {**base, "max_completion_tokens": max_tokens}]


def join_content(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    bits = []
    for part in content:
        if isinstance(part, str):
            bits.append(part)
        elif isinstance(part, dict):
            if isinstance(part.get("text"), str):
                bits.append(part["text"])
            elif isinstance(part.get("content"), str):
                bits.append(part["content"])
    return "".join(bits)


def message_text(data):
    if not isinstance(data, dict):
        raise ValueError()
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        first = choices[0]
        message = first.get("message") if isinstance(first.get("message"), dict) else {}
        text = join_content(message.get("content"))
        if text.strip():
            return text
        if isinstance(first.get("text"), str) and first["text"].strip():
            return first["text"]
    if isinstance(data.get("content"), list):
        text = join_content(data["content"])
        if text.strip():
            return text
    candidates = data.get("candidates")
    if isinstance(candidates, list) and candidates and isinstance(candidates[0], dict):
        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        text = join_content(parts)
        if text.strip():
            return text
    message = data.get("message")
    if isinstance(message, dict):
        text = join_content(message.get("content"))
        if text.strip():
            return text
    if isinstance(data.get("response"), str) and data["response"].strip():
        return data["response"]
    raise ValueError()


def completion(base_url, model, key, messages, max_tokens=220, provider="auto"):
    endpoint, kind = conversation_endpoint(base_url, provider, model)
    headers = {"Content-Type": "application/json"}
    if key:
        if kind == "anthropic":
            headers["x-api-key"] = key
            headers["anthropic-version"] = "2023-06-01"
        elif kind == "gemini":
            headers["x-goog-api-key"] = key
        else:
            headers["Authorization"] = "Bearer " + key
            if "azure" in (urlsplit(endpoint).hostname or ""):
                headers["api-key"] = key
    payloads = build_payloads(kind, model, messages, max_tokens)
    # 不跟随重定向，避免密钥被转发到其他地址。
    from urllib.request import build_opener, HTTPRedirectHandler
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = build_opener(NoRedirect)
    last_format_error = False
    for index, payload in enumerate(payloads):
        req = Request(endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with opener.open(req, timeout=45) as response:
                data = json.loads(response.read(1024 * 1024))
            content = message_text(data)
            if not content.strip():
                raise ValueError()
            return content.strip()[:4000]
        except HTTPError as exc:
            if exc.code == 400 and index < len(payloads) - 1:
                continue
            messages_by_code = {401: "API 密钥无效或已过期。", 403: "API 无访问权限，请检查密钥和模型。",
                                404: "API 地址或模型不存在。", 429: "API 配额不足或请求过于频繁。"}
            raise GameError(messages_by_code.get(exc.code, f"API 返回错误（HTTP {exc.code}），请检查配置。"), 502)
        except (URLError, TimeoutError, OSError):
            raise GameError("无法连接 API，请检查地址、网络或本机模型服务。", 502)
        except (ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError):
            last_format_error = True
            if index < len(payloads) - 1:
                continue
    if last_format_error:
        raise GameError("API 返回格式无法识别。可以换一种接口，或改填服务商给的完整对话地址。", 502)
    raise GameError("API 没有返回可用的回答。", 502)


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
        settings = conn.execute("SELECT mode,base_url,model,provider FROM settings WHERE user_id=?", (uid,)).fetchone()
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
                     "/i18n.js": ("i18n.js", "text/javascript"),
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
                    provider = str(data.get("provider") or "auto").strip().lower()
                    if provider not in PROVIDERS:
                        raise GameError("不认识这种接口。请选择自动识别、OpenAI 兼容、Anthropic、Gemini 或 Ollama。")
                    if not model or len(model) > 200 or len(key) > 4096 or not base or len(base) > 1000:
                        raise GameError("请填写接口地址和模型名称。")
                    kind = conversation_endpoint(base, provider, model)[1]
                    if not key and kind != "ollama" and not local_target(urlsplit(base).hostname):
                        raise GameError("请填写 API 密钥。本机或局域网的模型可以留空。")
                    completion(base, model, key, [{"role": "user", "content": "请简短回复：连接成功。"}], 32, provider)
                    encrypted = protect_key(key) if key else ""
                    conn.execute("UPDATE settings SET mode='local',base_url=?,model=?,encrypted_key=?,provider=? WHERE user_id=?",
                                 (base.rstrip("/"), model, encrypted, provider, uid))
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
                        secret = protect_key(settings["encrypted_key"], True) if settings["encrypted_key"] else ""
                        return completion(settings["base_url"], settings["model"], secret,
                                          [{"role": "system", "content": prompt}] + history
                                          + [{"role": "user", "content": text}], 280,
                                          settings["provider"] or "auto")
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
