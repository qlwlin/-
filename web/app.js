"use strict";
const $=id=>document.getElementById(id);
const PICKUP_IDS=new Set(["glasses","socks","thread","cotton","buttons","paint","cardboard","lightbox","flowerpots","scraps","well","coin_drawer","coin_counter","dropped"]);
const PICKUP_ITEM={glasses:"glasses",socks:"socks",thread:"thread",cotton:"cotton",buttons:"buttons",paint:"paint",flowerpots:"flower",scraps:"flags",well:"coin",coin_drawer:"coin",coin_counter:"coin"};
const DEFAULT_BINDS={up:"KeyW",down:"KeyS",left:"KeyA",right:"KeyD",sprint:"ShiftLeft",crouch:"KeyZ",pickup:"KeyE",talk:"KeyF",travel:"KeyT",tasks:"KeyV",map:"KeyM",settings:"KeyC",hide:"KeyH",slot1:"F1",slot2:"F2",slot3:"F3",slot4:"F4",slot5:"F5",slot6:"F6"};
const BIND_ORDER=Object.keys(DEFAULT_BINDS);
const BIND_CODE=/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Shift(Left|Right)|Space)$/;
class Api {
  async request(path,data){
    let r;try{r=await fetch("/api/"+path,data===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});}
    catch{throw new Error("连接本地服务失败，请确认项目正在运行。");}
    const result=await r.json();if(!r.ok){const e=new Error(result.error||"操作未完成");e.status=r.status;throw e;}return result;
  }
}
const glyphs={glasses:"▰",socks:"♧",thread:"◎",cotton:"☁",buttons:"⠿",paint:"▥",ribbon:"⋈",cookies:"●",card:"✉",coin:"◉",flower:"✿",flags:"⚑"};
const bigNames={cardboard:"纸箱",cloth:"布卷",lights:"旧灯串"};
class AppleTown {
  constructor(){
    this.api=new Api();this.prefs=this.loadPrefs();this.state=null;this.busy=false;this.registering=false;this.keys=new Set();this.hand=null;this.listening=null;this.crouching=false;this.settingsTab="sound";
    this.scene=new PatinaScene($("game-scene"));this.scene.onSelect=o=>this.onWorld(o);
    this.oldMessage="";this.lastMove=0;this.lastTick=0;this.journalDirty=false;
    this.applyPrefs();this.bind();this.boot();this.frame=this.frame.bind(this);requestAnimationFrame(this.frame);
  }
  t(key){return window.townI18n?window.townI18n.t(this.prefs.lang,key):key;}
  tr(text){return window.townI18n?window.townI18n.phrase(this.prefs.lang,text):text;}
  loadPrefs(){
    let saved={};try{saved=JSON.parse(localStorage.getItem("apple-town-settings")||"{}")||{};}catch{saved={};}
    const binds={};
    if(saved.binds&&typeof saved.binds==="object")for(const id of BIND_ORDER)if(BIND_CODE.test(saved.binds[id]))binds[id]=saved.binds[id].startsWith("Shift")?"ShiftLeft":saved.binds[id];
    const hud=saved.hud||{};
    return {lang:saved.lang==="en"?"en":"zh",clarity:["low","mid","high"].includes(saved.clarity)?saved.clarity:"low",volume:Number.isFinite(saved.volume)?Math.min(1,Math.max(0,saved.volume)):0.7,music:["auto","day","hearth","night","show","quiet"].includes(saved.music)?saved.music:"auto",binds,hud:{hint:hud.hint===false?false:true,hotbar:["center","left","right"].includes(hud.hotbar)?hud.hotbar:"center",dialogue:hud.dialogue==="top"?"top":"bottom"}};
  }
  savePrefs(){localStorage.setItem("apple-town-settings",JSON.stringify(this.prefs));}
  applyPrefs(){
    document.documentElement.lang=this.prefs.lang==="en"?"en":"zh-CN";
    this.scene.setClarity(this.prefs.clarity);
    if(window.loginScene)window.loginScene.setClarity(this.prefs.clarity);
    townAudio.setVolume(this.prefs.volume);townAudio.setTrack(this.prefs.music);this.applyHud();
    this.applyI18n();
    if(this.state&&!$("game-screen").hidden)this.render();
    if(this.state&&!$("mode-screen").hidden)this.showModes();
    if(!$("map-panel").hidden)this.renderMap();
    if(!$("settings-panel").hidden)this.renderSettings();
  }
  applyI18n(){
    document.querySelectorAll("[data-i18n-html]").forEach(el=>{el.innerHTML=this.t(el.dataset.i18nHtml);});
    document.querySelectorAll("[data-i18n]").forEach(el=>{el.textContent=this.t(el.dataset.i18n);});
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el=>{el.placeholder=this.t(el.dataset.i18nPlaceholder);});
    document.querySelectorAll("[data-i18n-aria]").forEach(el=>{el.setAttribute("aria-label",this.t(el.dataset.i18nAria));});
    document.title=this.t("ui.title");
    this.authTab(this.registering,true);
    this.syncSoundButtons();
  }
  setLanguage(lang){this.prefs.lang=lang==="en"?"en":"zh";this.savePrefs();this.applyPrefs();}
  setClarity(level){
    if(!["low","mid","high"].includes(level))return;
    this.prefs.clarity=level;this.savePrefs();
    this.scene.setClarity(level);if(window.loginScene)window.loginScene.setClarity(level);
    if(!$("settings-panel").hidden)this.renderSettings();
  }
  setVolume(v,hear){
    const next=Math.max(0,Math.min(1,Math.round(Number(v)*100)/100));
    this.prefs.volume=next;this.savePrefs();townAudio.setVolume(next);
    if(hear&&next>0)townAudio.ensure();
    const shown=String(Math.round(next*100));
    if($("volume").value!==shown)$("volume").value=shown;
    $("volume-label").textContent=shown+"%";
    this.syncSoundButtons();
  }
  bindings(){return {...DEFAULT_BINDS,...this.prefs.binds};}
  keyLabel(code){if(!code)return "";if(code.startsWith("Key"))return code.slice(3);if(code.startsWith("Digit"))return code.slice(5);if(code.startsWith("Shift"))return "Shift";if(code==="Space")return "Space";return {ArrowUp:"↑",ArrowDown:"↓",ArrowLeft:"←",ArrowRight:"→"}[code]||code;}
  fill(key,map){return Object.entries(map).reduce((text,[name,value])=>text.replaceAll("{"+name+"}",value),this.t(key));}
  setMusic(id){if(!["auto","day","hearth","night","show","quiet"].includes(id))return;this.prefs.music=id;this.savePrefs();townAudio.setTrack(id);townAudio.ensure();this.syncSoundButtons();if(!$("settings-panel").hidden)this.renderSettings();}
  setHud(name,value){const hud={...this.prefs.hud};if(name==="hint")hud.hint=value!=="hide";else if(name==="hotbar"&&["center","left","right"].includes(value))hud.hotbar=value;else if(name==="dialogue"&&["bottom","top"].includes(value))hud.dialogue=value;else return;this.prefs.hud=hud;this.savePrefs();this.applyHud();if(!$("settings-panel").hidden)this.renderSettings();}
  applyHud(){const hud=this.prefs.hud;$("hint").hidden=!hud.hint;$("hotbar").classList.remove("hud-left","hud-right");if(hud.hotbar==="left")$("hotbar").classList.add("hud-left");if(hud.hotbar==="right")$("hotbar").classList.add("hud-right");$("dialogue").classList.toggle("hud-top",hud.dialogue==="top");}
  sprinting(){const sprint=this.bindings().sprint;if(String(sprint).startsWith("Shift"))return this.keys.has("ShiftLeft")||this.keys.has("ShiftRight");return this.keys.has(sprint);}
  isHeld(code){const b=this.bindings();return [b.up,b.down,b.left,b.right,b.sprint,"ArrowUp","ArrowDown","ArrowLeft","ArrowRight","ShiftLeft","ShiftRight"].includes(code);}
  actionOf(code){const b=this.bindings();if((code==="ShiftLeft"||code==="ShiftRight")&&String(b.sprint).startsWith("Shift"))return "sprint";return BIND_ORDER.find(id=>b[id]===code)||"";}
  syncSoundButtons(){
    $("sound-toggle").textContent=this.t(townAudio.enabled?"ui.sound-login-on":"ui.sound-login");
    $("game-sound").textContent=this.t(townAudio.enabled?"ui.sound-on":"ui.sound-off");
  }
  screen(id){
    for(const key of ["entry","mode-screen","game-screen"])$(key).hidden=key!==id;
    this.keys.clear();
    if(id!=="game-screen"){$("settings-panel").hidden=true;$("map-panel").hidden=true;}
    window.scrollTo(0,0);
  }
  async boot(){try{const s=await this.api.request("session");if(s.authenticated===false)this.screen("entry");else{this.state=s;s.settings.mode==="pending"?this.showModes():this.showGame();}}catch(e){$("auth-error").textContent=this.tr(e.message);}}
  codeOf(e){
    if(e.code&&/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Shift(Left|Right)|Space|Arrow(Up|Down|Left|Right)|Escape)$/.test(e.code))return e.code;
    const key=(e.key||"").toLowerCase();
    const map={escape:"Escape",arrowup:"ArrowUp",arrowdown:"ArrowDown",arrowleft:"ArrowLeft",arrowright:"ArrowRight"," ":"Space"};
    if(map[key])return map[key];
    if(/^[a-z]$/.test(key))return "Key"+key.toUpperCase();
    if(/^[0-9]$/.test(key))return "Digit"+key;
    if(/^f([1-9]|1[0-2])$/.test(key))return key.toUpperCase();
    return "";
  }
  bind(){
    $("login-tab").onclick=()=>this.authTab(false);$("register-tab").onclick=()=>this.authTab(true);
    $("toggle-password").onclick=()=>{const show=$("password").type==="password";$("password").type=show?"text":"password";$("toggle-password").textContent=this.t(show?"auth.hide":"auth.show");};
    $("auth-form").onsubmit=e=>{e.preventDefault();this.authenticate();};
    for(const id of ["logout","mode-logout"])$(id).onclick=()=>this.run("game-error",async()=>{if(this.journalDirty)await this.action("journal",{text:$("journal").value});await this.api.request("logout",{});this.state=null;this.hand=null;this.screen("entry");});
    $("choose-offline").onclick=()=>this.run("mode-error",async()=>{this.state=await this.api.request("mode",{mode:"offline"});this.showGame();});
    $("resume").onclick=()=>this.showGame();$("change-mode").onclick=()=>this.run("game-error",async()=>{if(this.journalDirty)await this.action("journal",{text:$("journal").value});this.showModes();});
    $("choose-api").onclick=()=>{this.keys.clear();const settings=this.state.settings||{};$("api-provider").value=settings.provider||"auto";$("base-url").value=settings.base_url||"";$("model").value=settings.model||"";$("api-key").value="";$("api-dialog").showModal();};
    $("close-api").onclick=()=>$("api-dialog").close();$("api-dialog").onclose=()=>{$("api-key").value="";};
    $("api-form").onsubmit=e=>{e.preventDefault();this.run("api-error",async()=>{this.state=await this.api.request("config",{provider:$("api-provider").value,base_url:$("base-url").value,model:$("model").value,key:$("api-key").value});$("api-dialog").close();this.showGame();});};
    $("alias-form").onsubmit=e=>{e.preventDefault();this.run("alias-error",async()=>{await this.action("alias",{text:$("alias-input").value});$("alias-dialog").close();});};
    $("alias-dialog").addEventListener("cancel",e=>e.preventDefault());
    $("task-toggle").onclick=()=>this.toggleTasks(false);$("open-tasks").onclick=()=>this.toggleTasks();
    $("open-map").onclick=()=>this.toggleMap();$("close-map").onclick=()=>this.toggleMap(false);
    $("open-settings").onclick=()=>this.toggleSettings();$("close-settings").onclick=()=>this.toggleSettings(false);
    document.querySelectorAll("#lang-options button").forEach(b=>b.onclick=()=>this.setLanguage(b.dataset.lang));
    document.querySelectorAll("#clarity-options button").forEach(b=>b.onclick=()=>this.setClarity(b.dataset.clarity));
    $("volume").oninput=()=>this.setVolume($("volume").value,false);
    $("volume").onchange=()=>this.setVolume($("volume").value,true);
    $("vol-down").onclick=()=>this.setVolume(this.prefs.volume-.1,true);
    $("vol-up").onclick=()=>this.setVolume(this.prefs.volume+.1,true);
    $("settings-panel").addEventListener("click",e=>{
      const tab=e.target.closest("[data-tab]");if(tab){this.settingsTab=tab.dataset.tab;this.listening=null;this.renderSettings();return;}
      const music=e.target.closest("[data-music]");if(music){this.setMusic(music.dataset.music);return;}
      const bind=e.target.closest("[data-bind]");if(bind){this.listening=bind.dataset.bind;this.renderSettings();return;}
      const hud=e.target.closest("[data-hud]");if(hud)this.setHud(hud.dataset.hud,hud.dataset.value);
    });
    $("bind-reset").onclick=()=>{this.prefs.binds={};this.prefs.hud={hint:true,hotbar:"center",dialogue:"bottom"};this.listening=null;this.savePrefs();this.applyHud();this.renderSettings();if(this.state)this.render();};
    $("save-journal").onclick=()=>this.run("game-error",()=>this.action("journal",{text:$("journal").value}));
    $("journal").oninput=()=>{this.journalDirty=true;clearTimeout(this.journalTimer);this.journalTimer=setTimeout(()=>this.flushJournal(),1200);};
    $("drop-item").onclick=()=>this.dropHeld();
    $("close-dialogue").onclick=()=>$("dialogue").hidden=true;
    $("chat-form").onsubmit=e=>{e.preventDefault();const text=$("chat-input").value;this.perform("chat",{text}).then(()=>{$("chat-input").value="";});};
    document.querySelectorAll("[data-topic]").forEach(b=>b.onclick=()=>this.perform("chat",{text:b.dataset.topic}));
    $("close-choice").onclick=()=>$("choice-dialog").close();$("warning-ok").onclick=()=>$("warning-dialog").close();
    $("restart").onclick=()=>this.perform("restart");
    for(const id of ["sound-toggle","game-sound"])$(id).onclick=()=>{if(townAudio.volume<=0){this.setVolume(.7,true);return;}townAudio.toggle();this.syncSoundButtons();};
    document.addEventListener("keydown",e=>this.onKey(e));
    document.addEventListener("keyup",e=>{const code=this.codeOf(e);this.keys.delete(code);if(code&&this.actionOf(code)==="pickup")this.cancelHold();});
    document.addEventListener("pointerup",()=>this.cancelHold());
    window.addEventListener("blur",()=>{this.keys.clear();this.cancelHold();});
    window.addEventListener("beforeunload",e=>{if(this.journalDirty||this.busy){e.preventDefault();e.returnValue="";}});
  }
  onKey(e){
    if(this.listening){
      const code=this.codeOf(e);if(!code)return;
      e.preventDefault();
      if(code==="Escape"){this.listening=null;this.renderSettings();return;}
      if(!BIND_CODE.test(code)||e.repeat)return;
      const next=code.startsWith("Shift")?"ShiftLeft":code;
      const binds=this.bindings();
      for(const id of BIND_ORDER)if(binds[id]===next&&id!==this.listening)binds[id]=binds[this.listening];
      binds[this.listening]=next;
      this.prefs.binds={};
      for(const id of BIND_ORDER)if(binds[id]!==DEFAULT_BINDS[id])this.prefs.binds[id]=binds[id];
      this.listening=null;this.savePrefs();this.renderSettings();if(this.state)this.render();
      return;
    }
    if($("game-screen").hidden||document.querySelector("dialog[open]"))return;
    const code=this.codeOf(e);if(!code)return;
    const field=["INPUT","TEXTAREA"].includes(e.target.tagName);
    if(field&&e.target.id!=="volume"){if(code==="Escape"){e.target.blur();e.preventDefault();}return;}
    if(code==="Space")e.preventDefault();
    const panel=!$("settings-panel").hidden||!$("map-panel").hidden;
    if(code==="Escape"&&!e.repeat){
      if(!$("settings-panel").hidden)this.toggleSettings(false);
      else if(!$("map-panel").hidden)this.toggleMap(false);
      else if(!$("task-panel").hidden)this.toggleTasks(false);
      e.preventDefault();return;
    }
    if(panel){
      if(!e.repeat){
        const act=this.actionOf(code);
        if(act==="settings")this.toggleSettings();
        else if(act==="map")this.toggleMap();
        else if(act==="tasks")this.toggleTasks();
      }
      if(e.target.id==="volume"&&code.startsWith("Arrow"))return;
      if(this.isHeld(code))e.preventDefault();
      return;
    }
    if(this.isHeld(code)){e.preventDefault();this.keys.add(code);return;}
    if(e.repeat)return;
    const act=this.actionOf(code);
    if(act==="crouch"){e.preventDefault();this.crouching=!this.crouching;this.scene.crouch=this.crouching;}
    else if(act==="pickup"){e.preventDefault();this.onPickupKey();}
    else if(act==="talk"){e.preventDefault();this.onTalk();}
    else if(act==="travel"){e.preventDefault();this.onTravel();}
    else if(act==="map"){e.preventDefault();this.toggleMap();}
    else if(act==="settings"){e.preventDefault();this.toggleSettings();}
    else if(act==="tasks"){e.preventDefault();this.toggleTasks();}
    else if(act==="hide"){e.preventDefault();this.onHide();}
    else if(/^slot[1-6]$/.test(act)){e.preventDefault();this.takeOut(Number(act.slice(4))-1);}
  }
  async flushJournal(){if(!this.journalDirty||!this.state)return;if(this.busy){this.journalTimer=setTimeout(()=>this.flushJournal(),500);return;}await this.perform("journal",{text:$("journal").value});}
  authTab(registering,keepError){
    this.registering=!!registering;
    $("login-tab").classList.toggle("active",!this.registering);$("register-tab").classList.toggle("active",this.registering);
    $("auth-title").textContent=this.t(this.registering?"auth.title-reg":"auth.title");
    $("auth-subtitle").textContent=this.t(this.registering?"auth.subtitle-reg":"auth.subtitle");
    $("confirm-wrap").hidden=!this.registering;$("confirm").required=this.registering;
    $("password").autocomplete=this.registering?"new-password":"current-password";
    $("auth-submit").textContent=this.t(this.registering?"auth.submit-reg":"auth.submit");
    $("toggle-password").textContent=this.t($("password").type==="password"?"auth.show":"auth.hide");
    if(!keepError)$("auth-error").textContent="";
  }
  authenticate(){if(this.registering&&$("password").value!==$("confirm").value){$("auth-error").textContent=this.prefs.lang==="en"?"The two passwords do not match.":"两次密码不一致。";return;}this.run("auth-error",async()=>{this.state=await this.api.request(this.registering?"register":"login",{username:$("username").value,password:$("password").value});$("password").value=$("confirm").value="";this.showModes();});}
  showModes(){this.screen("mode-screen");$("welcome").textContent=this.t("mode.welcome").replace("{name}",this.state.username);$("resume").hidden=this.state.settings.mode==="pending";}
  showGame(){this.screen("game-screen");this.oldMessage="";this.lastPhase=null;$("task-panel").hidden=true;this.render();if(!this.state.progress.alias&&!$("alias-dialog").open)$("alias-dialog").showModal();}
  async run(errorId,task){
    if(this.busy)return false;this.busy=true;$(errorId).textContent="";
    document.body.setAttribute("aria-busy","true");
    try{await task();return true;}
    catch(e){$(errorId).textContent=this.tr(e.message);if(e.status===401){this.state=null;this.hand=null;this.screen("entry");$("auth-error").textContent=this.tr("登录已过期，请重新登录。");}if(e.status===409){this.state=await this.api.request("session");this.render();$("game-error").textContent=this.tr("已读入另一窗口的最新存档。");}return false;}
    finally{this.busy=false;document.body.removeAttribute("aria-busy");}
  }
  perform(action,data={}){return this.run("game-error",()=>this.action(action,data));}
  async action(action,data={}){
    const previous=this.state.progress.detected;
    this.state=await this.api.request("action",{action,revision:this.state.revision,...data});
    if(action==="journal")this.journalDirty=false;
    this.render();
    if(this.state.progress.detected>previous&&!$("warning-dialog").open){this.keys.clear();$("warning-dialog").showModal();}
  }
  near(){if(!this.state)return [];const p=this.state.progress;return this.state.world.objects.filter(o=>Math.hypot(o.x-p.position[0],o.y-p.position[1])<=1.65).sort((a,b)=>Math.hypot(a.x-p.position[0],a.y-p.position[1])-Math.hypot(b.x-p.position[0],b.y-p.position[1]));}
  isPickup(o){return !!o&&(o.kind==="pickup"||PICKUP_IDS.has(o.id));}
  pickupItemId(o){if(o.kind==="pickup"&&o.item)return o.item;return PICKUP_ITEM[o.id]||null;}
  toggleTasks(force){const next=typeof force==="boolean"?force:$("task-panel").hidden;$("task-panel").hidden=!next;}
  toggleMap(force){const next=typeof force==="boolean"?force:$("map-panel").hidden;$("map-panel").hidden=!next;if(next){$("settings-panel").hidden=true;this.renderMap();}this.keys.clear();}
  toggleSettings(force){const next=typeof force==="boolean"?force:$("settings-panel").hidden;$("settings-panel").hidden=!next;if(!next)this.listening=null;if(next){$("map-panel").hidden=true;this.renderSettings();}this.keys.clear();}
  renderSettings(){
    const tab=this.settingsTab||"sound";
    document.querySelectorAll("#setting-tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
    $("pane-sound").hidden=tab!=="sound";$("pane-picture").hidden=tab!=="picture";$("pane-controls").hidden=tab!=="controls";
    document.querySelectorAll("#lang-options button").forEach(b=>b.classList.toggle("active",b.dataset.lang===this.prefs.lang));
    document.querySelectorAll("#clarity-options button").forEach(b=>b.classList.toggle("active",b.dataset.clarity===this.prefs.clarity));
    document.querySelectorAll("#music-options button").forEach(b=>b.classList.toggle("active",b.dataset.music===this.prefs.music));
    const shown=String(Math.round(this.prefs.volume*100));
    $("volume").value=shown;$("volume-label").textContent=shown+"%";
    $("clarity-note").textContent=this.t("set.note-"+this.prefs.clarity);
    const binds=this.bindings(),list=$("bind-list");list.replaceChildren();
    for(const id of BIND_ORDER){
      const row=document.createElement("div");row.className="bind-row";
      const name=document.createElement("span");name.textContent=id.startsWith("slot")?this.t("bind.slot").replace("{n}",id.slice(4)):this.t("bind."+id);
      const button=document.createElement("button");button.type="button";button.dataset.bind=id;
      button.textContent=this.listening===id?this.t("set.bind.wait"):this.keyLabel(binds[id]);
      if(this.listening===id)button.classList.add("listening");
      row.append(name,button);list.append(row);
    }
    const hud=this.prefs.hud;
    document.querySelectorAll("#hud-hint button").forEach(b=>b.classList.toggle("active",(b.dataset.value==="show")===!!hud.hint));
    document.querySelectorAll("#hud-hotbar button").forEach(b=>b.classList.toggle("active",b.dataset.value===hud.hotbar));
    document.querySelectorAll("#hud-dialogue button").forEach(b=>b.classList.toggle("active",b.dataset.value===hud.dialogue));
  }
  renderMap(){
    const p=this.state?.progress;if(!p)return;
    const rows=p.scene.startsWith("night_")?[["night_flower","night_hall","night_bedroom"]]:[["treehouse"],["path","park","square","lanes"],["community","workshop","flower","bakery","library"],["","","home","bakery_home","library_attic"]];
    const board=$("map-board");board.replaceChildren();
    for(const row of rows){
      const line=document.createElement("div");line.className="map-row";
      for(const id of row){
        if(!id){const gap=document.createElement("span");gap.className="map-gap";line.append(gap);continue;}
        const b=document.createElement("button");b.type="button";b.className="map-node"+(p.scene===id?" here":"");b.textContent=this.t("scene."+id);
        if(p.scene===id)b.setAttribute("aria-current","true");
        line.append(b);
      }
      board.append(line);
    }
    $("map-here").textContent=this.t("map.you").replace("{place}",this.t("scene."+p.scene));
    $("map-note").textContent=this.t("map.note").replace("{key}",this.keyLabel(this.bindings().travel));
  }
  labelFor(o){
    const name=this.tr(o.label)+(o.amount>1?" ×"+o.amount:"");
    const keys=this.bindings();
    if(o.dest||o.kind==="door")return this.keyLabel(keys.travel)+" · "+name;
    if(o.kind==="npc"||o.kind==="kids")return this.keyLabel(keys.talk)+" · "+name;
    if(this.isPickup(o))return this.keyLabel(keys.pickup)+" · "+name;
    if(o.id==="sew")return this.t("act.sew")+" · "+this.tr(this.state.world.sew_instruction);
    return name;
  }
  onWorld(o){
    if(!o)return;
    if(o.dest||o.kind==="door")this.travelTo(o);
    else if(o.kind==="npc"||o.kind==="kids")this.talkTo(o);
    else if(this.isPickup(o))this.pickup(o);
    else this.interact(o);
  }
  onPickupKey(){
    const found=this.near().find(o=>this.isPickup(o));
    if(found){this.pickup(found);return;}
    const p=this.state.progress,bedside=this.near().find(o=>o.id==="bedside");
    if(bedside&&p.phase==="night"&&!p.card_placed&&p.inventory.card){this.startHold();return;}
    if(p.carrying||(this.hand&&p.inventory[this.hand])){this.dropHeld();return;}
    $("game-error").textContent=this.t("err.nothing");
  }
  onTalk(){const person=this.near().find(o=>o.kind==="npc"||o.kind==="kids");if(!person){$("game-error").textContent=this.t("err.no-person");return;}this.talkTo(person);}
  onTravel(){const door=this.near().find(o=>o.dest||o.kind==="door");if(!door){$("game-error").textContent=this.t("err.no-door").replace("{key}",this.keyLabel(this.bindings().travel));return;}this.travelTo(door);}
  onHide(){const p=this.state.progress;if(p.hiding){this.perform("unhide");return;}const hide=this.near().find(o=>o.kind==="hide");if(hide)this.interact(hide);}
  travelTo(o){this.interact(o);}
  talkTo(o){const pending=this.interact(o);if(o.id==="nora"&&pending&&pending.then)pending.then(()=>{if(!$("chat-box").hidden)$("chat-input").focus();});}
  pickup(o){const item=this.pickupItemId(o);if(item)this.hand=item;return this.interact(o);}
  dropHeld(){
    const p=this.state.progress;
    if(p.carrying)return this.perform("drop");
    if(this.hand&&p.inventory[this.hand]){const item=this.hand;this.hand=null;return this.perform("drop_item",{item});}
    $("game-error").textContent=this.t("err.nothing");
  }
  takeOut(index){
    const p=this.state.progress,pair=Object.entries(p.inventory)[index];
    if(!pair)return;
    const id=pair[0];
    if(id==="glasses"){
      if(!p.glasses){this.hand=id;this.perform("glasses");return;}
      if(this.hand===id){this.hand=null;this.perform("glasses");return;}
      this.hand=id;this.render();return;
    }
    this.hand=this.hand===id?null:id;this.render();
  }
  choose(title,options,callback){
    this.keys.clear();$("choice-title").textContent=title;$("choice-options").replaceChildren();$("choice-error").textContent="";
    for(const option of options){const b=document.createElement("button");b.type="button";b.textContent=option.label;b.onclick=()=>this.run("choice-error",async()=>{await callback(option.value);$("choice-dialog").close();});$("choice-options").append(b);}
    $("choice-dialog").showModal();
  }
  interact(o){
    if(this.busy||!o)return;
    if(!this.near().some(n=>n.id===o.id)){$("game-error").textContent=this.t("err.approach");return;}
    const p=this.state.progress,w=this.state.world;
    if(o.slot){const s=this.state.slots.find(v=>v.slot===o.slot);return this.choose(this.tr(o.label),[{label:this.t("slot.save")+" · "+p.alias+" / "+this.t("phase."+p.phase),value:"save_slot"},{label:s?this.t("slot.load")+" · "+s.alias+" / "+this.tr(s.phase):this.t("slot.empty"),value:"load_slot"}],action=>this.action(action,{slot:o.slot}));}
    if(o.id==="wrapping"&&p.card_step===0)return this.choose(this.t("choice.cover"),["木偶","圣诞树","星星"].map(label=>({label:this.tr(label),value:label})),choice=>this.action("interact",{target:o.id,choice}));
    if(o.id==="carousel")return this.choose(this.t("choice.horse"),["栗色小马","白色小马","灰色小马"].map(label=>({label:this.tr(label),value:label})),choice=>this.action("interact",{target:o.id,choice}).then(()=>townAudio.carousel()));
    if(o.kind==="decor")return this.choose(this.t("choice.decor"),["flower","flags"].map(value=>({value,label:this.tr(w.items[value])})),choice=>this.action("interact",{target:o.id,choice}));
    if(o.id==="bag"){const stored=p.stored||{};const options=[...Object.keys(p.inventory).filter(i=>i!=="glasses").map(i=>({value:i,label:this.t("bag.store")+" "+this.tr(w.items[i])})),...Object.keys(stored).map(i=>({value:i,label:this.t("bag.take")+" "+this.tr(w.items[i])}))];if(options.length)return this.choose(this.t("choice.bag"),options,choice=>this.action("interact",{target:"bag",choice}));}
    if(o.id==="bedside"){this.startHold();return;}
    return this.perform("interact",{target:o.id});
  }
  async startHold(){
    if(this.holding||this.busy||this.state.progress.card_placed)return;
    this.holding=true;
    const held=this.bindings();for(const code of [held.up,held.down,held.left,held.right,held.sprint,"ArrowUp","ArrowDown","ArrowLeft","ArrowRight","ShiftLeft","ShiftRight"])this.keys.delete(code);
    const ok=await this.perform("hold_card",{start:true});if(!ok){this.holding=false;return;}
    if(!this.holding)return;
    this.holdTimer=setTimeout(async()=>{if(this.holding){await this.perform("hold_card");this.holding=false;}},2100);
  }
  cancelHold(){this.holding=false;clearTimeout(this.holdTimer);}
  render(){
    if(!this.state)return;const p=this.state.progress,w=this.state.world;
    if(this.hand&&!p.inventory[this.hand])this.hand=null;
    this.scene.set(this.state);
    $("location-name").textContent=this.t("scene."+p.scene);
    $("phase-name").textContent=this.t("phase."+p.phase)+" · "+(p.alias||this.t("ui.neighbor"));
    $("current-goal").textContent=this.tr(w.goal);
    $("save-status").textContent=this.t("save.auto")+" · "+new Date(this.state.updated_at*1000).toLocaleTimeString(this.prefs.lang==="en"?"en-GB":"zh-CN");
    if(!this.journalDirty)$("journal").value=p.journal;
    const modules=[["puppets","task.puppets","task.puppets.desc"],["backdrop","task.stage","task.stage.desc"],["curtain","task.curtain","task.curtain.desc"],["lights","task.lights","task.lights.desc"],["cookies","task.cookies","task.cookies.desc"]];
    $("task-list").replaceChildren();
    if(p.met_nora)for(const [id,title,desc] of modules){const div=document.createElement("div");div.className="task-row"+(p.prepared[id]?" done":"");const strong=document.createElement("strong");strong.textContent=(p.prepared[id]?"✓ ":"○ ")+this.t(title);const small=document.createElement("span");small.textContent=this.t(desc);div.append(strong,small);$("task-list").append(div);}
    const count=document.createElement("p");count.textContent=this.t("task.count").replace("{a}",p.puppet_count).replace("{b}",p.light_repairs).replace("{c}",Math.min(p.bake_step,4));$("task-list").append(count);
    $("clue-list").replaceChildren();for(const clue of p.clues){const div=document.createElement("div");div.className="clue";div.textContent="— "+this.tr(clue);$("clue-list").append(div);}
    $("nora-location").textContent=w.nora_scene?this.t("nora.at").replace("{place}",this.t("scene."+w.nora_scene)):this.t("nora.asleep");
    const dropKey=this.keyLabel(this.bindings().pickup);
    if(p.carrying){$("carry-status").hidden=false;$("carry-label").textContent=this.t("carry.big")+" "+this.tr(bigNames[p.carrying]||p.carrying)+this.t("carry.drop").replace("{drop}",dropKey);}
    else if(this.hand==="glasses"&&!p.glasses){const index=Object.keys(p.inventory).indexOf("glasses");const slot=this.keyLabel(this.bindings()["slot"+(index+1)]);$("carry-status").hidden=false;$("carry-label").textContent=this.t("carry.glasses").replace("{key}",slot).replace("{drop}",dropKey);}
    else if(this.hand){$("carry-status").hidden=false;$("carry-label").textContent=this.t("carry.hand")+" "+this.tr(w.items[this.hand])+this.t("carry.drop").replace("{drop}",dropKey);}
    else $("carry-status").hidden=true;
    $("open-map").textContent=this.t("ui.map-name")+" "+this.keyLabel(this.bindings().map);
    $("open-tasks").textContent=this.t("ui.tasks-name")+" "+this.keyLabel(this.bindings().tasks);
    $("open-settings").textContent=this.t("ui.settings-name")+" "+this.keyLabel(this.bindings().settings);
    $("hotbar").replaceChildren();const items=Object.entries(p.inventory);
    for(let i=0;i<6;i++){
      const b=document.createElement("button"),pair=items[i],keyName=this.keyLabel(this.bindings()["slot"+(i+1)]);b.type="button";
      if(pair){const [id,amount]=pair;if(id==="glasses"&&p.glasses)b.classList.add("worn");if(this.hand===id)b.classList.add("held");
        const g=document.createElement("span");g.className="glyph";g.textContent=glyphs[id]||"◇";
        const label=document.createElement("span");label.textContent=this.tr(w.items[id]);
        const small=document.createElement("small");small.textContent=amount>1?amount+"·"+keyName:keyName;
        b.append(g,label,small);b.title=this.t("hotbar.take").replace("{key}",keyName).replace("{name}",this.tr(w.items[id]));b.onclick=()=>this.takeOut(i);
      }else{b.className="empty";b.textContent=keyName;b.disabled=true;}
      $("hotbar").append(b);
    }
    $("speaker").textContent=this.tr(p.speaker);$("dialogue-text").textContent=this.tr(p.message);
    const turns=(p.chat||[]).slice(-16);
    const sig=this.prefs.lang+"\n"+turns.map(turn=>turn.role+"\n"+turn.content).join("\n");
    if(sig!==this.chatSig){this.chatSig=sig;const log=$("chat-log");log.replaceChildren();
      for(const turn of turns){const row=document.createElement("p");row.className=turn.role==="user"?"me":"her";
        const who=document.createElement("strong");who.textContent=(turn.role==="user"?(p.alias||this.t("ui.neighbor")):this.tr("诺拉"))+" ";
        row.append(who,document.createTextNode(turn.role==="user"?turn.content:this.tr(turn.content)));log.append(row);}
      log.scrollTop=log.scrollHeight;}
    if(p.message!==this.oldMessage){this.oldMessage=p.message;$("dialogue").hidden=false;$("portrait").textContent=p.speaker==="诺拉"?"✿":p.speaker==="三个孩子"?"●":"✦";townAudio.speak(p.speaker,p.message,p.emotion,p.phase==="night");}
    const near=this.near();
    if(!this.holding){$("nearby-actions").replaceChildren();for(const obj of near){const b=document.createElement("button");b.type="button";b.textContent=this.labelFor(obj);
      if(obj.id==="bedside"&&!p.card_placed){b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);this.startHold();};b.onpointerup=()=>this.cancelHold();b.onpointercancel=()=>this.cancelHold();}
      else b.onclick=()=>this.onWorld(obj);$("nearby-actions").append(b);}}
    $("chat-box").hidden=!near.some(o=>o.id==="nora")||!p.met_nora;$("restart").hidden=!p.ending;
    const cinema=!!p.cutscene_at&&!p.ending;$("cinema").hidden=!cinema;
    if(this.lastPhase!==p.phase||this.lastCinema!==cinema){townAudio.mode(p.phase,cinema);this.lastPhase=p.phase;this.lastCinema=cinema;}
    if(cinema)this.renderCinema();
    const keys=this.bindings();
    const move=this.keyLabel(keys.up)+this.keyLabel(keys.left)+this.keyLabel(keys.down)+this.keyLabel(keys.right);
    const glassesIndex=Object.keys(p.inventory).indexOf("glasses");
    $("hint").textContent=w.blocked?this.t("hint.blocked").replace("{key}",this.keyLabel(keys["slot"+(glassesIndex+1)]))
      :this.fill("hint.play",{move,sprint:this.keyLabel(keys.sprint),crouch:this.keyLabel(keys.crouch),pickup:this.keyLabel(keys.pickup),talk:this.keyLabel(keys.talk),travel:this.keyLabel(keys.travel),tasks:this.keyLabel(keys.tasks),map:this.keyLabel(keys.map),settings:this.keyLabel(keys.settings),slots:this.keyLabel(keys.slot1)+"–"+this.keyLabel(keys.slot6),hide:this.keyLabel(keys.hide)});
    if(!$("map-panel").hidden)this.renderMap();
  }
  renderCinema(){const seconds=Math.max(0,Date.now()/1000-this.state.progress.cutscene_at);
    const shot=seconds<12?0:seconds<29?1:2;
    $("cinema-title").textContent=this.t("cinema."+shot+".title");
    $("cinema-text").textContent=this.t(shot===1&&seconds>=20?"cinema.1.textb":"cinema."+shot+".text");
    $("cinema-progress").textContent=this.t("cinema.progress").replace("{n}",Math.min(40,Math.floor(seconds)));
  }
  frame(now){
    requestAnimationFrame(this.frame);
    if(!this.state||$("game-screen").hidden||document.querySelector("dialog[open]"))return;
    const p=this.state.progress;
    if(p.cutscene_at&&!p.ending){this.renderCinema();if(now-this.lastTick>1000&&!this.busy){this.lastTick=now;this.perform("tick");}return;}
    const typing=["INPUT","TEXTAREA"].includes(document.activeElement?.tagName);
    const paused=!$("settings-panel").hidden||!$("map-panel").hidden;
    let dx=0,dy=0;const keys=this.bindings();
    if(!typing&&!paused){if(this.keys.has(keys.up)||this.keys.has("ArrowUp")){dx--;dy--;}if(this.keys.has(keys.down)||this.keys.has("ArrowDown")){dx++;dy++;}
      if(this.keys.has(keys.left)||this.keys.has("ArrowLeft")){dx--;dy++;}if(this.keys.has(keys.right)||this.keys.has("ArrowRight")){dx++;dy--;}}
    const sprint=this.sprinting()&&!this.crouching;
    const pace=this.crouching?0.75:sprint?1.25:1;
    this.scene.crouch=this.crouching;this.scene.sprinting=sprint;this.scene.walking=!!(dx||dy)&&!this.busy;
    if((dx||dy)&&!this.busy&&!p.hiding&&!this.holding&&now-this.lastMove>130){
      this.lastMove=now;const amount=(p.carrying?0.17:0.29)*pace/Math.hypot(dx,dy);
      const pos=[Math.max(.65,Math.min(9.35,p.position[0]+dx*amount)),Math.max(.65,Math.min(9.35,p.position[1]+dy*amount))];
      if(p.scene.startsWith("night_")&&this.state.world.obstacles.some(([x1,y1,x2,y2])=>pos[0]>=x1&&pos[0]<=x2&&pos[1]>=y1&&pos[1]<=y2))return;
      this.perform("move",{position:pos});
    }else if(p.phase==="night"&&now-this.lastTick>500&&!this.busy&&!this.holding){this.lastTick=now;this.perform("tick");}
  }
}
window.appleTown=new AppleTown();
