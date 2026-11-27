"use strict";
const $=id=>document.getElementById(id);
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
    this.api=new Api();this.state=null;this.busy=false;this.registering=false;this.keys=new Set();
    this.scene=new PatinaScene($("game-scene"));this.scene.onSelect=o=>this.interact(o);
    this.oldMessage="";this.lastMove=0;this.lastTick=0;this.currentAction=null;this.journalDirty=false;
    this.bind();this.boot();this.frame=this.frame.bind(this);requestAnimationFrame(this.frame);
  }
  screen(id){for(const key of ["entry","mode-screen","game-screen"])$(key).hidden=key!==id;this.keys.clear();window.scrollTo(0,0);}
  async boot(){try{const s=await this.api.request("session");if(s.authenticated===false)this.screen("entry");else{this.state=s;s.settings.mode==="pending"?this.showModes():this.showGame();}}catch(e){$("auth-error").textContent=e.message;}}
  bind(){
    $("login-tab").onclick=()=>this.authTab(false);$("register-tab").onclick=()=>this.authTab(true);
    $("toggle-password").onclick=()=>{const show=$("password").type==="password";$("password").type=show?"text":"password";$("toggle-password").textContent=show?"隐藏":"显示";};
    $("auth-form").onsubmit=e=>{e.preventDefault();this.authenticate();};
    for(const id of ["logout","mode-logout"])$(id).onclick=()=>this.run("game-error",async()=>{if(this.journalDirty)await this.action("journal",{text:$("journal").value});await this.api.request("logout",{});this.state=null;this.screen("entry");});
    $("choose-offline").onclick=()=>this.run("mode-error",async()=>{this.state=await this.api.request("mode",{mode:"offline"});this.showGame();});
    $("resume").onclick=()=>this.showGame();$("change-mode").onclick=()=>this.run("game-error",async()=>{if(this.journalDirty)await this.action("journal",{text:$("journal").value});this.showModes();});
    $("choose-api").onclick=()=>{this.keys.clear();$("base-url").value=this.state.settings.base_url||"https://api.openai.com/v1";$("model").value=this.state.settings.model||"";$("api-key").value="";$("api-dialog").showModal();};
    $("close-api").onclick=()=>$("api-dialog").close();$("api-dialog").onclose=()=>{$("api-key").value="";};
    $("api-form").onsubmit=e=>{e.preventDefault();this.run("api-error",async()=>{this.state=await this.api.request("config",{base_url:$("base-url").value,model:$("model").value,key:$("api-key").value});$("api-dialog").close();this.showGame();});};
    $("alias-form").onsubmit=e=>{e.preventDefault();this.run("alias-error",async()=>{await this.action("alias",{text:$("alias-input").value});$("alias-dialog").close();});};
    $("alias-dialog").addEventListener("cancel",e=>e.preventDefault());
    $("task-toggle").onclick=()=>this.toggleTasks();$("save-journal").onclick=()=>this.run("game-error",()=>this.action("journal",{text:$("journal").value}));
    $("journal").oninput=()=>{this.journalDirty=true;clearTimeout(this.journalTimer);this.journalTimer=setTimeout(()=>this.flushJournal(),1200);};
    $("drop-item").onclick=()=>this.perform("drop");
    $("close-dialogue").onclick=()=>$("dialogue").hidden=true;
    $("chat-form").onsubmit=e=>{e.preventDefault();const text=$("chat-input").value;this.perform("chat",{text}).then(()=>{$("chat-input").value="";});};
    document.querySelectorAll("[data-topic]").forEach(b=>b.onclick=()=>this.perform("chat",{text:b.dataset.topic}));
    $("close-choice").onclick=()=>$("choice-dialog").close();$("warning-ok").onclick=()=>$("warning-dialog").close();
    $("restart").onclick=()=>this.perform("restart");
    for(const id of ["sound-toggle","game-sound"])$(id).onclick=()=>{const enabled=townAudio.toggle();$("sound-toggle").textContent=enabled?"♫ 声音已开启":"♫ 开启声音";$("game-sound").textContent=enabled?"♫ 声音开":"♫ 声音关";};
    document.addEventListener("keydown",e=>{
      if($("game-screen").hidden||document.querySelector("dialog[open]"))return;
      if(["INPUT","TEXTAREA"].includes(e.target.tagName))return;
      const key=e.key.toLowerCase();
      if(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright","tab","e","h","1","2","3","4","5","6"].includes(key))e.preventDefault();
      this.keys.add(key);
      if(key==="tab"&&!e.repeat)this.toggleTasks();
      if(key==="h"&&!e.repeat){if(this.state.progress.hiding)this.perform("unhide");else{const hide=this.near().find(o=>o.kind==="hide");if(hide)this.interact(hide);}}
      if(key==="e"&&!e.repeat){const obj=this.near()[0];if(obj?.id==="bedside")this.startHold();else if(obj)this.interact(obj);}
      if(/^[1-6]$/.test(key)&&!e.repeat){const item=Object.keys(this.state.progress.inventory)[Number(key)-1];if(item==="glasses")this.perform("glasses");}
    });
    document.addEventListener("keyup",e=>{this.keys.delete(e.key.toLowerCase());if(e.key.toLowerCase()==="e")this.cancelHold();});
    document.addEventListener("pointerup",()=>this.cancelHold());
    window.addEventListener("blur",()=>{this.keys.clear();this.cancelHold();});
    window.addEventListener("beforeunload",e=>{if(this.journalDirty||this.busy){e.preventDefault();e.returnValue="";}});
  }
  async flushJournal(){if(!this.journalDirty||!this.state)return;if(this.busy){this.journalTimer=setTimeout(()=>this.flushJournal(),500);return;}await this.perform("journal",{text:$("journal").value});}
  authTab(registering){this.registering=registering;$("login-tab").classList.toggle("active",!registering);$("register-tab").classList.toggle("active",registering);$("auth-title").textContent=registering?"领取你的冬日通行证":"欢迎回到苹果镇";$("auth-subtitle").textContent=registering?"创建账号，给故事留一个归处。":"登录，让故事接着上一页。";$("confirm-wrap").hidden=!registering;$("confirm").required=registering;$("password").autocomplete=registering?"new-password":"current-password";$("auth-submit").textContent=registering?"创建账号，开启故事 →":"登录，继续故事 →";$("auth-error").textContent="";}
  authenticate(){if(this.registering&&$("password").value!==$("confirm").value){$("auth-error").textContent="两次密码不一致。";return;}this.run("auth-error",async()=>{this.state=await this.api.request(this.registering?"register":"login",{username:$("username").value,password:$("password").value});$("password").value=$("confirm").value="";this.showModes();});}
  showModes(){this.screen("mode-screen");$("welcome").textContent=this.state.username+"，你的账号与故事进度已读入。";$("resume").hidden=this.state.settings.mode==="pending";}
  showGame(){this.screen("game-screen");this.oldMessage="";this.lastPhase=null;this.render();if(!this.state.progress.alias&&!$("alias-dialog").open)$("alias-dialog").showModal();}
  async run(errorId,task){
    if(this.busy)return false;this.busy=true;$(errorId).textContent="";
    document.body.setAttribute("aria-busy","true");
    try{await task();return true;}
    catch(e){$(errorId).textContent=e.message;if(e.status===401){this.state=null;this.screen("entry");$("auth-error").textContent="登录已过期，请重新登录。";}if(e.status===409){this.state=await this.api.request("session");this.render();$("game-error").textContent="已读入另一窗口的最新存档。";}return false;}
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
  toggleTasks(){const hidden=$("task-details").hidden;$("task-details").hidden=!hidden;$("task-toggle").setAttribute("aria-expanded",String(hidden));$("task-toggle").querySelector("small").textContent=hidden?"Tab · 收起":"Tab · 展开";}
  choose(title,options,callback){
    this.keys.clear();$("choice-title").textContent=title;$("choice-options").replaceChildren();$("choice-error").textContent="";
    for(const option of options){const b=document.createElement("button");b.textContent=option.label;b.onclick=()=>this.run("choice-error",async()=>{await callback(option.value);$("choice-dialog").close();});$("choice-options").append(b);}
    $("choice-dialog").showModal();
  }
  interact(o){
    if(this.busy)return;
    if(!this.near().some(n=>n.id===o.id)){$("game-error").textContent="先走近这个物件。";return;}
    const p=this.state.progress;
    if(o.slot){const s=this.state.slots.find(v=>v.slot===o.slot);this.choose(o.label,[{label:"存入这幅挂画 · "+p.alias+" / "+this.state.world.phase,value:"save_slot"},{label:s?"读取 · "+s.alias+" / "+s.phase:"读取 · 空挂画",value:"load_slot"}],action=>this.action(action,{slot:o.slot}));return;}
    if(o.id==="wrapping"&&p.card_step===0){this.choose("挑一张邀请卡封面",["木偶","圣诞树","星星"].map(label=>({label,value:label})),choice=>this.action("interact",{target:o.id,choice}));return;}
    if(o.id==="carousel"){this.choose("投一枚硬币，选一匹木马",["栗色小马","白色小马","灰色小马"].map(label=>({label,value:label})),choice=>this.action("interact",{target:o.id,choice}).then(()=>townAudio.carousel()));return;}
    if(o.kind==="decor"){this.choose("摆放装饰",["flower","flags"].map(value=>({value,label:this.state.world.items[value]})),choice=>this.action("interact",{target:o.id,choice}));return;}
    if(o.id==="bag"){const stored=p.stored||{};const options=[...Object.keys(p.inventory).filter(i=>i!=="glasses").map(i=>({value:i,label:"存入 "+this.state.world.items[i]})),...Object.keys(stored).map(i=>({value:i,label:"取出 "+this.state.world.items[i]}))];if(options.length){this.choose("礼物袋",options,choice=>this.action("interact",{target:"bag",choice}));return;}}
    if(o.id==="bedside")return;
    this.perform("interact",{target:o.id});
  }
  async startHold(){
    if(this.holding||this.busy||this.state.progress.card_placed)return;
    this.holding=true;this.keys.delete("w");this.keys.delete("a");this.keys.delete("s");this.keys.delete("d");
    const ok=await this.perform("hold_card",{start:true});if(!ok){this.holding=false;return;}
    if(!this.holding)return;
    this.holdTimer=setTimeout(async()=>{if(this.holding){await this.perform("hold_card");this.holding=false;}},2100);
  }
  cancelHold(){this.holding=false;clearTimeout(this.holdTimer);}
  render(){
    if(!this.state)return;const p=this.state.progress,w=this.state.world;this.scene.set(this.state);
    $("location-name").textContent=w.scenes[p.scene].name;$("phase-name").textContent=w.phase+" · "+(p.alias||"新邻居");
    $("current-goal").textContent=w.goal;$("save-status").textContent="自动保存 · "+new Date(this.state.updated_at*1000).toLocaleTimeString("zh-CN");
    if(!this.journalDirty)$("journal").value=p.journal;
    const modules=[["puppets","一只木偶","找能做木偶的材料 · 手作坊 / 图书馆 / 面包房 / 花店"],["backdrop","一座小舞台","后台需要能立起的背景 · 面包房有纸箱"],["curtain","一块布帘","台口还空着 · 花店有缎带"],["lights","一串灯","后台箱子里有旧灯 · 好像断了两处"],["cookies","圣诞点心","面包房制作，再摆到舞台前的桌上"]];
    $("task-list").replaceChildren();if(p.met_nora)for(const [id,title,desc] of modules){const div=document.createElement("div");div.className="task-row"+(p.prepared[id]?" done":"");const strong=document.createElement("strong");strong.textContent=(p.prepared[id]?"✓ ":"○ ")+title;const small=document.createElement("span");small.textContent=desc;div.append(strong,small);$("task-list").append(div);}
    const count=document.createElement("p");count.textContent=`木偶 ${p.puppet_count}/3 · 灯线 ${p.light_repairs}/2 · 点心 ${Math.min(p.bake_step,4)}/4`;$("task-list").append(count);
    $("clue-list").replaceChildren();for(const clue of p.clues){const div=document.createElement("div");div.className="clue";div.textContent="— "+clue;$("clue-list").append(div);}
    $("nora-location").textContent=w.nora_scene?"诺拉这会儿在"+w.scenes[w.nora_scene].name+"。":"诺拉已经睡着了。";
    $("carry-status").hidden=!p.carrying;$("carry-label").textContent=p.carrying?"抱着 "+bigNames[p.carrying]+" · 不能爬梯子":"";
    $("hotbar").replaceChildren();const items=Object.entries(p.inventory);
    for(let i=0;i<6;i++){const b=document.createElement("button"),pair=items[i];b.type="button";if(pair){const [id,amount]=pair;b.className=id==="glasses"&&p.glasses?"worn":"";const g=document.createElement("span");g.className="glyph";g.textContent=glyphs[id]||"◇";const label=document.createElement("span");label.textContent=w.items[id];const small=document.createElement("small");small.textContent=amount>1?amount:String(i+1);b.append(g,label,small);b.title=id==="glasses"?(p.glasses?"摘下墨镜":"戴上墨镜"):w.items[id];b.onclick=()=>{if(id==="glasses")this.perform("glasses");else{$("game-error").textContent="走近需要它的工作台或物件，再点击互动。";}};}else{b.className="empty";b.textContent=i+1;b.disabled=true;}$("hotbar").append(b);}
    if(p.message!==this.oldMessage){this.oldMessage=p.message;$("dialogue").hidden=false;$("speaker").textContent=p.speaker;$("dialogue-text").textContent=p.message;$("portrait").textContent=p.speaker==="诺拉"?"✿":p.speaker==="三个孩子"?"●":"✦";townAudio.speak(p.speaker,p.message,p.emotion,p.phase==="night");}
    const near=this.near();if(!this.holding){$("nearby-actions").replaceChildren();for(const obj of near){const b=document.createElement("button");b.textContent=obj.id==="sew"?"缝木偶 · "+w.sew_instruction:obj.label;b.type="button";
      if(obj.id==="bedside"&&!p.card_placed){b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);this.startHold();};b.onpointerup=()=>this.cancelHold();b.onpointercancel=()=>this.cancelHold();}
      else b.onclick=()=>this.interact(obj);$("nearby-actions").append(b);}}
    $("chat-box").hidden=!near.some(o=>o.id==="nora")||!p.met_nora;$("restart").hidden=!p.ending;
    const cinema=!!p.cutscene_at&&!p.ending;$("cinema").hidden=!cinema;
    if(this.lastPhase!==p.phase||this.lastCinema!==cinema){townAudio.mode(p.phase,cinema);this.lastPhase=p.phase;this.lastCinema=cinema;}
    if(cinema)this.renderCinema();
    $("hint").textContent=w.blocked?"三个孩子围住你了 · 点快捷栏墨镜戴上":"WASD / 方向键移动 · E 互动 · H 躲藏 · Tab 清单";
  }
  renderCinema(){const seconds=Math.max(0,Date.now()/1000-this.state.progress.cutscene_at);
    const shot=seconds<12?0:seconds<29?1:2;
    $("cinema-title").textContent=["圣诞早晨 · 发现","圣诞老人的木偶戏","小镇的观众席"][shot];
    $("cinema-text").textContent=shot===0?"诺拉推开门，看见舞台，高兴地跳起来。":shot===1?(seconds<20?"从前有个圣诞老人，给每个小孩发礼物。":"不管礼物多难找，也要送到每个孩子手里。"):"诺拉从幕布后探出头，向大家鞠了一躬。";
    $("cinema-progress").textContent=Math.min(40,Math.floor(seconds))+" / 40 秒";
  }
  frame(now){
    requestAnimationFrame(this.frame);
    if(!this.state||$("game-screen").hidden||document.querySelector("dialog[open]"))return;
    const p=this.state.progress;
    if(p.cutscene_at&&!p.ending){this.renderCinema();if(now-this.lastTick>1000&&!this.busy){this.lastTick=now;this.perform("tick");}return;}
    const typing=["INPUT","TEXTAREA"].includes(document.activeElement?.tagName);
    let dx=0,dy=0;
    // 方向键对应屏幕方向，转换到固定斜俯视地面坐标。
    if(!typing){if(this.keys.has("w")||this.keys.has("arrowup")){dx--;dy--;}if(this.keys.has("s")||this.keys.has("arrowdown")){dx++;dy++;}
      if(this.keys.has("a")||this.keys.has("arrowleft")){dx--;dy++;}if(this.keys.has("d")||this.keys.has("arrowright")){dx++;dy--;}}
    this.scene.walking=!!(dx||dy)&&!this.busy;
    if((dx||dy)&&!this.busy&&!p.hiding&&!this.holding&&now-this.lastMove>130){
      this.lastMove=now;const amount=(p.carrying?.17:.29)/Math.hypot(dx,dy);
      const pos=[Math.max(.65,Math.min(9.35,p.position[0]+dx*amount)),Math.max(.65,Math.min(9.35,p.position[1]+dy*amount))];
      if(p.scene.startsWith("night_")&&this.state.world.obstacles.some(([x1,y1,x2,y2])=>pos[0]>=x1&&pos[0]<=x2&&pos[1]>=y1&&pos[1]<=y2))return;
      this.perform("move",{position:pos});
    }else if(p.phase==="night"&&now-this.lastTick>500&&!this.busy&&!this.holding){this.lastTick=now;this.perform("tick");}
  }
}
window.appleTown=new AppleTown();
