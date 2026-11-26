"use strict";
const $ = id => document.getElementById(id);
const places = {
  square: ["钟楼广场", "C1", "托比的等待", "托比说，他每年都来听这口钟。今年，他已经等了很久。", "⌂"],
  hall: ["一楼大厅", "C2", "旧合影", "年轻的西奥多站在船边，笑得像一个即将出发的人。", "▥"],
  gears: ["机芯层", "C3", "完好的齿轮", "齿轮没有损坏。也许让钟开口的，还缺少别的东西。", "⚙"],
  attic: ["阁楼", "C4", "未使用的船票", "一张去月亮湾的船票，被小心地夹在旧海图里。", "◇"],
  dock: ["小镇码头", "C5", "月亮湾的约定", "西奥多曾想去月亮湾。他留下来守钟，也把那个年轻的自己留在了心里。", "⚓"],
  library: ["图书馆", "C6", "泛黄的记录", "镇子的钟响过许多次，记录里却很少有人提起守钟人的名字。", "▤"],
  stall: ["围巾摊子", "C7", "暖和的外套", "一件厚外套，为守了一夜钟的人留着。被惦记也可以是一份礼物。", "♧"],
  top: ["钟顶平台", "C8", "两个人的位置", "钟边留下两双脚印的位置。一口钟，也想有人陪它听自己的歌。", "♜"]
};

class Api {
  async request(path, data) {
    let response;
    try {
      response = await fetch(`/api/${path}`, data === undefined ? {} : {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)
      });
    } catch {
      throw new Error("连接本地服务失败，请确认服务正在运行。");
    }
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "请求失败，请重试。");
      error.status = response.status;
      throw error;
    }
    return result;
  }
}

class AppleTown {
  constructor() {
    this.api = new Api();
    this.state = null;
    this.registering = false;
    this.busy = false;
    this.journalDirty = false;
    this.bind();
    this.boot();
  }

  async boot() {
    try {
      const state = await this.api.request("session");
      if (state.authenticated === false) this.screen("entry");
      else {
        this.state = state;
        state.settings.mode === "pending" ? this.showModes() : this.showGame(true);
      }
    } catch (error) { $("auth-error").textContent = error.message; }
  }

  screen(id) {
    document.body.classList.toggle("login-view", id === "entry");
    for (const screen of ["entry", "mode-screen", "game-screen"]) $(screen).hidden = screen !== id;
    $("logout").hidden = !this.state;
  }

  bind() {
    $("login-tab").onclick = () => this.authTab(false);
    $("register-tab").onclick = () => this.authTab(true);
    $("toggle-password").onclick = () => {
      const visible = $("password").type === "password";
      $("password").type = visible ? "text" : "password";
      $("toggle-password").textContent = visible ? "隐藏" : "显示";
      $("toggle-password").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    };
    $("auth-form").onsubmit = event => { event.preventDefault(); this.authenticate(); };
    $("logout").onclick = () => this.run("game-error", async () => {
      if (this.journalDirty) await this.action("journal", {text: $("journal").value});
      await this.api.request("logout", {});
      this.state = null;
      $("password").value = $("confirm").value = "";
      this.screen("entry");
      this.toast("已退出，游戏进度保存在本机。");
    });
    $("choose-api").onclick = () => {
      $("base-url").value = this.state.settings.base_url || "https://api.openai.com/v1";
      $("model").value = this.state.settings.model || "";
      $("api-key").value = "";
      $("api-error").textContent = "";
      $("api-dialog").showModal();
    };
    $("close-api").onclick = () => $("api-dialog").close();
    $("api-dialog").addEventListener("close", () => { $("api-key").value = ""; });
    $("api-form").onsubmit = event => {
      event.preventDefault();
      this.run("api-error", async () => {
        $("activate-api").textContent = "正在验证连接，请稍候…";
        try {
          this.state = await this.api.request("config", {
            base_url: $("base-url").value, model: $("model").value, key: $("api-key").value
          });
          $("api-dialog").close();
          this.showGame(true);
          this.toast("API 已激活，西奥多准备好听你说话了。");
        } finally { $("activate-api").textContent = "验证并激活 API →"; }
      });
    };
    $("choose-offline").onclick = () => this.run("mode-error", async () => {
      this.state = await this.api.request("mode", {mode: "offline"});
      this.showGame(true);
    });
    $("resume").onclick = () => this.showGame(true);
    $("change-mode").onclick = () => this.run("game-error", async () => {
      if (this.journalDirty) await this.action("journal", {text: $("journal").value});
      this.showModes();
    });
    for (const [id, place] of Object.entries(places)) {
      const button = document.createElement("button");
      button.className = "place-button";
      button.dataset.location = id;
      const icon = document.createElement("span"); icon.textContent = place[4];
      const text = document.createTextNode(place[0]);
      const mark = document.createElement("em");
      button.append(icon, text, mark);
      button.onclick = () => this.run("game-error", async () => {
        if (this.journalDirty) await this.action("journal", {text: $("journal").value});
        await this.action("travel", {location: id});
      });
      $("locations").append(button);
    }
    $("collect").onclick = () => this.run("game-error", () => this.action("collect"));
    $("journal").oninput = () => {
      this.journalDirty = true;
      $("save-status").textContent = "日记尚未保存";
      clearTimeout(this.journalTimer);
      this.journalTimer = setTimeout(() => this.flushJournal(), 1200);
    };
    $("save-journal").onclick = () => this.run("game-error", async () => {
      await this.action("journal", {text: $("journal").value});
      this.toast("日记与进度已保存。");
    });
    $("chat-form").onsubmit = event => {
      event.preventDefault();
      this.run("game-error", async () => {
        $("chat-mode").textContent = "西奥多正在想怎么回答…";
        try {
          await this.action("chat", {text: $("chat-input").value});
          $("chat-input").value = "";
        } finally { this.chatMode(); }
      });
    };
    $("wish-open").onclick = () => {
      $("wish-error").textContent = "";
      $("wish-dialog").showModal();
    };
    $("close-wish").onclick = () => $("wish-dialog").close();
    document.querySelectorAll("[data-wish]").forEach(button => {
      button.onclick = () => this.run("wish-error", async () => {
        await this.action("wish", {wish: button.dataset.wish});
        $("wish-dialog").close();
        this.toast("钟声响起了。今晚，有人记得他的故事。");
      });
    });
    window.addEventListener("beforeunload", event => {
      if (this.journalDirty || this.busy) { event.preventDefault(); event.returnValue = ""; }
    });
  }

  async flushJournal() {
    if (!this.journalDirty || !this.state || this.state.settings.mode === "pending") return;
    if (this.busy) {
      this.journalTimer = setTimeout(() => this.flushJournal(), 300);
      return;
    }
    await this.run("game-error", () => this.action("journal", {text: $("journal").value}));
  }

  async run(errorId, task) {
    if (this.busy) return;
    this.busy = true;
    $(errorId).textContent = "";
    document.querySelectorAll("button").forEach(button => {
      button.dataset.preDisabled = button.disabled ? "true" : "false";
      button.disabled = true;
    });
    try { await task(); }
    catch (error) {
      $(errorId).textContent = error.message;
      if (error.status === 401 && this.state && errorId !== "api-error") {
        this.state = null;
        $("auth-error").textContent = "登录已过期，请重新登录。";
        this.screen("entry");
      }
      if (error.status === 409 && this.state) {
        $("save-status").textContent = "存档冲突：请刷新读取最新进度";
      }
    } finally {
      document.querySelectorAll("button").forEach(button => {
        button.disabled = button.dataset.preDisabled === "true";
      });
      this.busy = false;
      if (this.state && !$("game-screen").hidden) this.renderGame();
    }
  }

  authTab(registering) {
    this.registering = registering;
    $("login-tab").classList.toggle("active", !registering);
    $("register-tab").classList.toggle("active", registering);
    $("login-tab").setAttribute("aria-selected", String(!registering));
    $("register-tab").setAttribute("aria-selected", String(registering));
    $("auth-title").textContent = registering ? "领取你的冬日通行证" : "欢迎回到苹果镇";
    $("auth-subtitle").textContent = registering ? "创建一个账号，给故事留一个归处。" : "登录你的账号，接着上一页故事。";
    $("confirm-wrap").hidden = !registering;
    $("confirm").required = registering;
    $("password").autocomplete = registering ? "new-password" : "current-password";
    $("auth-submit").textContent = registering ? "创建账号，开启故事 →" : "登录，继续故事 →";
    $("auth-error").textContent = "";
  }

  authenticate() {
    if (this.registering && $("password").value !== $("confirm").value) {
      $("auth-error").textContent = "两次密码输入不一致，请检查。";
      return;
    }
    this.run("auth-error", async () => {
      this.state = await this.api.request(this.registering ? "register" : "login", {
        username: $("username").value, password: $("password").value
      });
      $("password").value = $("confirm").value = "";
      this.journalDirty = false;
      this.showModes();
    });
  }

  showModes() {
    this.screen("mode-screen");
    $("welcome").textContent = `${this.state.username}，欢迎回来。是否接入你自己的 API？你的故事进度已读入。`;
    $("resume").hidden = this.state.settings.mode === "pending";
    $("mode-error").textContent = "";
    window.scrollTo({top: 0});
  }

  showGame(loaded = false) {
    this.screen("game-screen");
    $("journal").value = this.state.progress.journal;
    this.journalDirty = false;
    this.renderGame();
    if (loaded) this.toast(`已读取 ${this.state.username} 的存档。`);
    window.scrollTo({top: 0});
  }

  async action(action, data = {}) {
    this.state = await this.api.request("action", {action, revision: this.state.revision, ...data});
    if (action === "journal") this.journalDirty = $("journal").value !== data.text;
    if (!this.journalDirty) $("journal").value = this.state.progress.journal;
    this.renderGame();
  }

  chatMode() {
    if (!this.state) return;
    $("chat-mode").textContent = this.state.settings.mode === "local"
      ? `由 ${this.state.settings.model} 回应 · API 模式` : "预设对白 · 完全离线";
  }

  renderGame() {
    const {progress, settings, username, updated_at} = this.state;
    const place = places[progress.location];
    $("game-welcome").textContent = `${username}，欢迎回来。这一晚不必着急。`;
    $("mode-badge").textContent = settings.mode === "local" ? "✧ 本地模式 · API 已激活" : "❋ 离线模式";
    $("save-status").textContent = this.journalDirty ? "日记尚未保存" :
      `✓ 自动存档 · ${new Date(updated_at * 1000).toLocaleTimeString("zh-CN", {hour12: false})}`;
    $("location-title").textContent = place[0];
    $("location-symbol").textContent = place[4];
    $("clue-title").textContent = place[2];
    $("clue-description").textContent = place[3];
    const collected = progress.clues.includes(place[1]);
    $("collect").textContent = collected ? "✓ 已收进口袋日记" : "收集这条线索 →";
    $("collect").disabled = collected || this.busy;
    document.querySelectorAll("[data-location]").forEach(button => {
      button.classList.toggle("active", button.dataset.location === progress.location);
      button.setAttribute("aria-current", button.dataset.location === progress.location ? "location" : "false");
      button.querySelector("em").textContent = progress.clues.includes(places[button.dataset.location][1]) ? "✓" : "";
    });
    $("clue-count").textContent = `${progress.clues.length} / 8`;
    $("progress-fill").style.width = `${progress.clues.length / 8 * 100}%`;
    $("quest-text").textContent = progress.ending ? "钟声为两个人响起。你让守钟人的故事被记得了。还可以继续探索小镇。" :
      progress.clues.includes("C5") && progress.clues.length >= 5
        ? "你已经听到月亮湾的故事。试着说出西奥多真正的愿望吧。"
        : `找到月亮湾的约定，并收集至少五条线索（当前 ${progress.clues.length}/8）。`;
    $("wish-open").textContent = progress.ending ? "✓ 愿望已实现 · 再回味一次" : "猜猜西奥多的愿望";
    $("clue-list").replaceChildren();
    if (!progress.clues.length) $("clue-list").textContent = "日记还是空白，第一条线索就在广场。";
    for (const clue of progress.clues) {
      const chip = document.createElement("span"); chip.className = "clue-chip";
      chip.textContent = Object.values(places).find(place => place[1] === clue)[2];
      $("clue-list").append(chip);
    }
    $("chat-log").replaceChildren();
    const messages = progress.chat.length ? progress.chat : [{role: "assistant", content: "雪下得不小啊。来，先暖暖手。你也是来听钟的吗？"}];
    for (const message of messages) {
      const bubble = document.createElement("div"); bubble.className = `bubble ${message.role}`;
      bubble.textContent = message.content;
      $("chat-log").append(bubble);
    }
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
    this.chatMode();
  }

  toast(text) {
    $("toast").textContent = text; $("toast").hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000);
  }
}
new AppleTown();
