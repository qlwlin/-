"use strict";

/* Canvas 2D 等距投影：通过顶面、侧面、遮挡和阴影呈现小镇模型。 */
class WinterDiorama {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (!this.ctx) return;
    this.snow = true;
    this.visible = true;
    this.offset = {x: 0, y: 0};
    this.target = {x: 0, y: 0};
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.flakes = Array.from({length: 58}, (_, i) => ({
      x: (i * 137.51) % 840, y: (i * 79.31) % 520,
      speed: 8 + i % 7 * 2, size: .7 + i % 4 * .35, phase: i * 2.4
    }));
    this.lastTime = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersection = new IntersectionObserver(entries => {
      this.visible = entries[0].isIntersecting;
      this.schedule();
    });
    this.intersection.observe(canvas);
    this.onVisibility = () => this.schedule();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.reduced.addEventListener("change", this.onVisibility);
    canvas.addEventListener("pointermove", event => {
      if (this.reduced.matches || event.pointerType === "touch") return;
      const rect = canvas.getBoundingClientRect();
      this.target = {x: (event.clientX - rect.left - rect.width / 2) / rect.width * 9,
                     y: (event.clientY - rect.top - rect.height / 2) / rect.height * 5};
      this.schedule();
    });
    canvas.addEventListener("pointerleave", () => {
      this.target = {x: 0, y: 0};
      this.schedule();
    });
    const button = document.getElementById("login-snow");
    button.addEventListener("click", () => {
      this.snow = !this.snow;
      button.setAttribute("aria-pressed", String(this.snow));
      button.setAttribute("aria-label", this.snow ? "暂停飘雪" : "开启飘雪");
      button.querySelector("span").textContent = this.snow ? "飘雪中" : "雪已静止";
      this.schedule();
    });
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.width = rect.width;
    this.height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.dpr = dpr;
    this.scale = Math.min(this.width / 760, this.height / 560);
    this.draw(0);
    this.schedule();
  }

  schedule() {
    if (this.frame || !this.visible || document.hidden) return;
    this.frame = requestAnimationFrame(time => {
      this.frame = null;
      if (!this.visible || document.hidden) return;
      const elapsed = this.lastTime ? Math.min((time - this.lastTime) / 1000, .06) : 0;
      if (time - this.lastTime > 32 || this.reduced.matches) {
        this.lastTime = time;
        this.offset.x += (this.target.x - this.offset.x) * .12;
        this.offset.y += (this.target.y - this.offset.y) * .12;
        if (this.snow && !this.reduced.matches) {
          for (const flake of this.flakes) {
            flake.y = (flake.y + flake.speed * elapsed) % 520;
            flake.x = (flake.x + elapsed * 3) % 840;
          }
        }
        this.draw(time / 1000);
      }
      const moving = Math.abs(this.offset.x - this.target.x) + Math.abs(this.offset.y - this.target.y) > .05;
      if (!this.reduced.matches && (this.snow || moving)) this.schedule();
    });
  }

  p(x, y, z = 0) {
    return {x: 420 + (x - y) * .866, y: 300 + (x + y) * .44 - z};
  }

  poly(points, color) {
    const c = this.ctx;
    c.beginPath();
    points.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }

  face(points, color) { this.poly(points.map(v => this.p(...v)), color); }

  box(x, y, width, depth, height, colors, base = 0) {
    const [top, front, side] = colors;
    this.face([[x,y+depth,base],[x+width,y+depth,base],[x+width,y+depth,base+height],[x,y+depth,base+height]], front);
    this.face([[x+width,y,base],[x+width,y+depth,base],[x+width,y+depth,base+height],[x+width,y,base+height]], side);
    this.face([[x,y,base+height],[x+width,y,base+height],[x+width,y+depth,base+height],[x,y+depth,base+height]], top);
  }

  shadow(x, y, w, d) {
    this.face([[x,y,1],[x+w,y,1],[x+w+52,y+d+35,1],[x+40,y+d+35,1]], "#647b6b19");
  }

  pane(x, y, z, w, h, glowing = true) {
    const c = this.ctx;
    if (glowing) { c.shadowColor = "#ffdc83"; c.shadowBlur = 14; }
    this.face([[x,y,z],[x+w,y,z],[x+w,y,z+h],[x,y,z+h]], glowing ? "#f8d78b" : "#526a5c");
    c.shadowBlur = 0;
    if (glowing) {
      this.face([[x+w*.46,y+.1,z],[x+w*.54,y+.1,z],[x+w*.54,y+.1,z+h],[x+w*.46,y+.1,z+h]], "#a28b66");
      this.face([[x,y+.1,z+h*.48],[x+w,y+.1,z+h*.48],[x+w,y+.1,z+h*.54],[x,y+.1,z+h*.54]], "#a28b66");
    }
  }

  roof(x, y, w, d, z, tall, color = "#60766b") {
    const peak = [x+w/2, y+d/2, z+tall];
    this.face([[x-6,y-6,z], [x+w+6,y-6,z], peak], "#6d8375");
    this.face([[x+w+6,y-6,z], [x+w+6,y+d+6,z], peak], "#425e54");
    this.face([[x+w+6,y+d+6,z], [x-6,y+d+6,z], peak], color);
    this.face([[x-6,y+d+6,z], [x-6,y-6,z], peak], "#f3f5e9");
    this.face([[x-6,y-6,z+2],[x+w+6,y-6,z+2],peak], "#fbfbee");
    this.face([[x-6,y+d+6,z+2],[x+w+6,y+d+6,z+2],[x+w+4,y+d+3,z+6],[x-5,y+d+3,z+6]], "#f5f5e8");
  }

  house(x, y, w, d, h, colors) {
    this.box(x,y,w,d,h,["#d6c5a8",...colors]);
    this.roof(x,y,w,d,h,33,"#75826d");
    this.pane(x+10,y+d+.2,14,14,21);
    this.pane(x+w-25,y+d+.2,14,14,21);
    this.pane(x+w/2-7,y+d+.3,0,14,24,false);
    this.box(x+11,y+9,10,11,18,["#f1f1e5","#a58a71","#8d7662"],h+10);
    this.box(x-4,y+d+5,w+8,8,4,["#f7f7e9","#d0d7c6","#c3cdba"]);
  }

  tree(x,y,size,festive = false) {
    this.shadow(x-8,y-8,16,16);
    this.box(x-4,y-4,8,8,14,["#9b8267","#967b5e","#80634f"]);
    for (let tier = 0; tier < 3; tier++) {
      const r = size*(.48-tier*.1), z = 12+tier*size*.3;
      const tip = [x,y,z+size*.72];
      this.face([[x-r,y-r,z],[x+r,y-r,z],tip], "#7b9784");
      this.face([[x+r,y-r,z],[x+r,y+r,z],tip], "#52765f");
      this.face([[x+r,y+r,z],[x-r,y+r,z],tip], "#658b72");
      this.face([[x-r,y+r,z],[x-r,y-r,z],tip], "#89a08b");
      this.face([[x-r,y-r,z+2],[x+r,y-r,z+2],[x,y,z+size*.4]], "#e8efdf");
      if (festive) {
        for (let i = 0; i < 4; i++) {
          const p = this.p(x-r+i*r*.55,y+r,z+5+i%2*5);
          this.circle(p.x,p.y,2.8, i%2 ? "#e8c876" : "#be7064");
        }
      }
    }
    if (festive) {
      const p = this.p(x,y,12+size*1.32);
      this.star(p.x,p.y,7,"#d9af56");
    }
  }

  circle(x,y,r,color) {
    const c = this.ctx; c.beginPath(); c.arc(x,y,r,0,Math.PI*2);
    c.fillStyle = color; c.fill();
  }

  star(x,y,r,color) {
    this.poly(Array.from({length:8},(_,i) => ({
      x:x+Math.cos(i*Math.PI/4)*(i%2 ? r*.25 : r),
      y:y+Math.sin(i*Math.PI/4)*(i%2 ? r*.25 : r)
    })),color);
  }

  lamp(x,y) {
    this.box(x-2,y-2,4,4,46,["#788979","#687f6d","#4b6858"]);
    this.box(x-6,y-6,12,12,14,["#ded2a6","#f3d993","#d6b66c"],43);
    const p = this.p(x,y,49);
    const glow = this.ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,33);
    glow.addColorStop(0,"#ffe2a444"); glow.addColorStop(1,"#ffe2a400");
    this.circle(p.x,p.y,33,glow);
    this.roof(x-8,y-8,16,16,59,7);
  }

  clocktower() {
    const x=-34,y=-67,w=65,d=65;
    this.box(x-7,y-7,79,79,9,["#d6d7c5","#b4bca7","#a8b4a0"]);
    this.box(x,y,w,d,169,["#d6c5ac","#ceb698","#b4997e"],9);
    this.box(x-3,y-3,71,71,5,["#e3d9bf","#e0ceb0","#bca287"],124);
    this.roof(x,y,w,d,178,51,"#576e61");
    const c=this.ctx, p=this.p(x+32,y+d+.3,150);
    c.save(); c.translate(p.x,p.y); c.transform(.866,.44,0,1,0,0);
    this.circle(0,0,20,"#a58d67"); this.circle(0,0,16,"#f6efd4");
    c.strokeStyle="#647362";c.lineWidth=2.4;c.lineCap="round";
    c.beginPath();c.moveTo(0,0);c.lineTo(0,-10);c.moveTo(0,0);c.lineTo(8,4);c.stroke();
    for(let i=0;i<12;i++) this.circle(Math.sin(i*Math.PI/6)*12,-Math.cos(i*Math.PI/6)*12,.75,"#9d9e80");
    c.restore();
    this.pane(x+24,y+d+.3,72,17,29);
    this.pane(x+23,y+d+.3,9,20,35,false);
    this.box(x+19,y+d+1,28,11,5,["#f5f4e7","#b8c4b0","#b3bda6"]);
    // 藤蔓与圣诞花环沿钟楼正面垂下。
    for(let i=0;i<16;i++){
      const v=this.p(x+7+Math.sin(i*.7)*4,y+d+.5,30+i*5);
      this.circle(v.x,v.y,2.8,"#778a67");
      if(i%4===0) this.circle(v.x+2,v.y,1.5,"#b4785b");
    }
    const wreath=this.p(x+33,y+d+.5,54);
    c.save();c.translate(wreath.x,wreath.y);c.scale(.866,1);c.strokeStyle="#5f8064";c.lineWidth=4;
    c.beginPath();c.arc(0,0,8,0,Math.PI*2);c.stroke();
    this.circle(0,7,3,"#b66a56");c.restore();
  }

  santa(x,y) {
    const p=this.p(x,y,3),c=this.ctx;
    c.fillStyle="#78927b25";c.beginPath();c.ellipse(p.x+4,p.y+1,15,5,-.1,0,Math.PI*2);c.fill();
    c.save();c.translate(p.x,p.y);
    c.fillStyle="#485d51";c.fillRect(-7,-5,6,6);c.fillRect(2,-5,6,6);
    this.poly([{x:-11,y:-5},{x:10,y:-5},{x:7,y:-27},{x:-6,y:-27}],"#b66555");
    c.fillStyle="#ebe9d5";c.fillRect(-11,-10,21,4);c.fillStyle="#52624e";c.fillRect(-9,-17,18,3);
    this.circle(0,-30,8,"#e4c59d");this.circle(0,-25,5.5,"#f3efdc");
    this.poly([{x:-8,y:-35},{x:8,y:-35},{x:3,y:-49},{x:-3,y:-44}],"#b66657");
    c.fillStyle="#f3efdc";c.fillRect(-9,-37,18,4);this.circle(4,-48,3,"#f4f2e3");
    this.circle(7,-19,3,"#ddbd92");c.restore();
  }

  draw(time) {
    if (!this.width) return;
    const c=this.ctx;
    c.setTransform(this.dpr,0,0,this.dpr,0,0);
    const gradient=c.createLinearGradient(0,0,0,this.height);
    gradient.addColorStop(0,"#d9e4dc");gradient.addColorStop(.65,"#e4eadd");gradient.addColorStop(1,"#edf0e3");
    c.fillStyle=gradient;c.fillRect(0,0,this.width,this.height);
    const compositionX = this.width > 900 ? -this.width * .16 : 0;
    const compositionY = this.width > 900 ? -this.height * .04 : -this.height * .12;
    c.translate((this.width-840*this.scale)/2+compositionX,(this.height-520*this.scale)/2+compositionY);
    c.scale(this.scale,this.scale);
    this.circle(712,102,25,"#fff9df");
    [[84,130],[143,74],[648,63],[752,181],[75,249],[570,48]].forEach(([x,y],i)=>this.star(x,y,i%2?3:5,"#f8fae9"));
    // 雪地底座的厚度、软阴影和等距投影。
    c.save();c.translate(this.offset.x,this.offset.y);
    const shadow=this.p(0,10,-32);
    c.fillStyle="#84978016";c.beginPath();c.ellipse(shadow.x,shadow.y,280,107,0,0,Math.PI*2);c.fill();
    this.box(-207,-170,414,340,23,["#f5f5e8","#c5d2bd","#b4c6b2"],-23);
    // 冰蓝色溪流、石子路与脚印。
    this.face([[141,-168,1],[205,-168,1],[205,164,1],[166,164,1],[131,55,1]],"#c9dcd5");
    this.face([[180,-80,2],[205,-80,2],[205,-76,2],[180,-76,2]],"#eaf2e5");
    this.face([[-23,-20,1],[24,-20,1],[98,157,1],[42,157,1]],"#e0e0ce");
    this.face([[-182,83,1],[-182,59,1],[167,90,1],[167,115,1]],"#e8e7d6");
    for(let i=0;i<7;i++){
      const p=this.p(22+i*7,73+i*6,2);
      c.fillStyle="#c3cdb84f";c.beginPath();c.ellipse(p.x,p.y,2,1.2,.3,0,Math.PI*2);c.fill();
    }
    [[-145,-91,66,55],[90,-121,68,60],[-34,-67,65,65]].forEach(v=>this.shadow(...v));
    // 后排物件先画，形成自然遮挡。
    this.tree(-172,-126,48);
    this.house(-145,-91,66,55,53,["#d4b8a0","#bba48e"]);
    this.tree(-84,-128,37);
    this.house(87,-121,68,60,59,["#b7c2a5","#94aa94"]);
    this.tree(169,-145,40);
    this.clocktower();
    this.lamp(-91,34);
    this.tree(-160,42,60);
    // 红绿条纹的小摊、木凳与礼物。
    this.box(-140,82,63,37,33,["#c7aa82","#ba9b78","#9f855f"]);
    this.box(-146,77,75,47,5,["#f6f3df","#d4ccb2","#bdbaa1"],48);
    for(let i=0;i<6;i++)this.box(-146+i*12.5,77,7,47,1,["#ba7766","#a86b59","#a86b59"],54);
    [[-141,80],[-81,80],[-141,114],[-81,114]].forEach(([x,y])=>this.box(x,y,3,3,49,["#a38a64","#a38a64","#927859"]));
    this.box(120,39,52,25,7,["#d4bd95","#b39b75","#a08c6c"],14);
    this.box(124,44,5,18,14,["#bca57f","#b39b75","#a08c6c"]);
    this.box(161,44,5,18,14,["#bca57f","#b39b75","#a08c6c"]);
    this.box(124,37,46,4,18,["#d8c39f","#b8a17b","#a08c6c"],20);
    this.lamp(110,117);
    this.tree(-65,119,71,true);
    this.box(-84,130,20,18,15,["#c98a73","#b87560","#a36452"]);
    this.box(-62,137,16,15,12,["#dfce9b","#c5b17d","#baa56e"]);
    this.face([[-76,130,16],[-73,130,16],[-73,148,16],[-76,148,16]],"#e6d9af");
    this.santa(34,100);
    c.restore();
    for(const f of this.flakes) {
      const wave=this.reduced.matches || !this.snow ? 0 : Math.sin(time*.4+f.phase)*5;
      this.circle(f.x+wave,f.y,f.size,"#fffef5bc");
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("login-scene");
  if (canvas) new WinterDiorama(canvas);
});
