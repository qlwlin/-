"use strict";
/* 所有场景是可运行的程序几何；320×240、硬面、抖动、织纹与后期统一。 */
class PatinaScene {
  constructor(canvas, login=false) {
    this.canvas=canvas;this.ctx=canvas.getContext("2d",{willReadFrequently:true});
    this.raw=document.createElement("canvas");this.raw.width=320;this.raw.height=240;
    this.c=this.raw.getContext("2d",{willReadFrequently:true});this.login=login;this.state=null;this.position=[5,8];
    this.frame=0;this.last=0;this.hits=[];this.onSelect=null;
    this.scale=1;this.patina=1;this.colorStep=8;
    canvas.addEventListener("pointerdown",e=>{
      if(this.login)return;
      const rect=canvas.getBoundingClientRect();
      const cw=canvas.width,ch=canvas.height,disp=Math.min(rect.width/cw,rect.height/ch);
      const ox=(rect.width-cw*disp)/2,oy=(rect.height-ch*disp)/2;
      const x=((e.clientX-rect.left-ox)/disp)/(this.scale||1);
      const y=((e.clientY-rect.top-oy)/disp)/(this.scale||1);
      if(x<0||y<0||x>320||y>240)return;
      const hit=this.hits.filter(h=>Math.hypot(h.x-x,h.y-y)<h.r).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0];
      if(hit&&this.onSelect){e.preventDefault();this.onSelect(hit.obj);}
    });
    this.loop=this.loop.bind(this);requestAnimationFrame(this.loop);
  }
  set(state){this.state=state;this.position=state.progress.position.slice();}
  setClarity(level){
    const presets={low:{scale:1,patina:1,step:8,smooth:false},mid:{scale:1.5,patina:.45,step:4,smooth:false},high:{scale:2,patina:.18,step:1,smooth:true}};
    const preset=presets[level]||presets.low;
    this.scale=preset.scale;this.patina=preset.patina;this.colorStep=preset.step;
    const w=Math.round(320*preset.scale),h=Math.round(240*preset.scale);
    this.raw.width=w;this.raw.height=h;this.canvas.width=w;this.canvas.height=h;
    this.canvas.style.imageRendering=preset.smooth?"auto":"pixelated";
  }
  hash(x,y,seed=0){const v=Math.sin(x*127.1+y*311.7+seed*23.13)*43758.5453;return v-Math.floor(v);}
  poly(points,color,grain=false) {
    const c=this.c,snap=v=>this.scale>1?v:Math.round(v);
    c.fillStyle=color;c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(snap(x),snap(y)):c.moveTo(snap(x),snap(y)));c.closePath();c.fill();
    if(grain) {c.save();c.clip();const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
      const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
      for(let y=minY;y<maxY;y+=2)for(let x=minX;x<maxX;x+=3){const v=this.hash(x,y);c.fillStyle=v>.6?"#dbc39425":"#111b2433";c.fillRect(Math.floor(x+(y%4)),Math.floor(y),v>.8?4:1,1);}
      c.restore();}
  }
  project(x,y,z=0){return [160+(x-y)*12.3,43+(x+y)*7.1-z];}
  box(x,y,w,d,h,palette=["#947453","#624d3e","#ad8f65"],texture=true){
    const a=this.project(x-w/2,y-d/2),b=this.project(x+w/2,y-d/2),cc=this.project(x+w/2,y+d/2),dd=this.project(x-w/2,y+d/2);
    const jitter=Math.sin(this.frame*.13+x*7+y)*.45;
    const top=[a,b,cc,dd].map(([xx,yy])=>[xx+jitter,yy-h]);
    this.poly([dd,cc,top[2],top[3]],palette[0],texture);this.poly([b,cc,top[2],top[1]],palette[1],texture);this.poly(top,palette[2],texture);
    return this.project(x,y,h);
  }
  shadow(x,y,w=1.3,d=.8){const [a,b]=this.project(x,y);this.poly([[a-w*13,b],[a,b-d*7],[a+w*13,b],[a,b+d*7]],"#0c172660");}
  roof(x,y,w,d,h,col="#555c60"){
    const a=this.project(x-w/2,y-d/2,h),b=this.project(x+w/2,y-d/2,h),cc=this.project(x+w/2,y+d/2,h),dd=this.project(x-w/2,y+d/2,h);
    const peak1=this.project(x-w/2,y,h+18),peak2=this.project(x+w/2,y,h+18);
    this.poly([a,b,peak2,peak1],col,true);this.poly([dd,cc,peak2,peak1],"#394951",true);
    this.poly([cc,b,peak2],"#65635b",true);
    this.c.strokeStyle="#a4a08a28";for(let i=0;i<5;i++){this.c.beginPath();this.c.moveTo(peak1[0]+i*5,peak1[1]+i*2);this.c.lineTo(cc[0]-i*2,cc[1]);this.c.stroke();}
  }
  house(x,y,w=2,d=2,h=32,variant=0){
    this.shadow(x+.5,y+.4,w,d);this.box(x,y,w,d,h,variant%2?["#977b57","#715540","#b39368"]:["#9c6550","#674c41","#ba8e64"]);
    this.roof(x,y,w+.25,d+.25,h);
    const [xx,yy]=this.project(x,y+d/2,h-13);this.c.fillStyle="#e3ae60";this.c.fillRect(xx-8,yy-3,5,6);this.c.fillRect(xx+4,yy+4,5,6);
    this.c.fillStyle="#473f35";this.c.fillRect(xx-7,yy-2,1,5);this.c.fillRect(xx+5,yy+5,1,4);
    this.box(x-.55,y-.35,.35,.35,h+20,["#795e4d","#57483d","#a48562"]);
    for(let i=0;i<4;i++){this.c.fillStyle="#b8b6a03b";this.c.fillRect(xx-16+i*2,yy-h+3-i*4+(this.frame%16)/8,4+i,3);}
    if(variant===1){const [ax,ay]=this.project(x,y+d/2+.1,h-7);this.poly([[ax-18,ay],[ax+8,ay+15],[ax+10,ay+20],[ax-16,ay+5]],"#ab6654",true);for(let i=0;i<5;i++){this.c.fillStyle="#c7bc9e";this.c.fillRect(ax-13+i*5,ay+4+i*3,2,4);}}
  }
  tree(x,y,size=1,snow=false){
    this.shadow(x,y,size,.7);this.box(x,y,.24,.25,18*size,["#5d4c3b","#393d31","#7b694e"]);
    const [xx,yy]=this.project(x,y);
    for(let k=0;k<3;k++){const w=(19-k*4)*size,base=yy-(11+k*10)*size;
      this.poly([[xx-w,base],[xx,base-19*size],[xx+w,base],[xx,base+6*size]],k%2?"#5d6850":"#4b5d4a",true);
      this.poly([[xx,base-19*size],[xx+w,base],[xx,base+6*size]],"#34483c",true);
      if(snow)this.poly([[xx-w*.65,base-6*size],[xx,base-19*size],[xx+w*.65,base-6*size]],"#c0c5b4",true);}
  }
  pace(id,x,y){
    const seed=[...String(id)].reduce((n,ch)=>n+ch.charCodeAt(0),7);
    const t=this.frame*.045+seed;
    const wave=Math.sin(t);
    const span=.42,ang=(seed%7)*.55;
    return {x:x+Math.cos(ang)*wave*span,y:y+Math.sin(ang)*wave*span*.7,moving:Math.abs(Math.cos(t))>.18};
  }
  person(x,y,name="player",glasses=false,hiding=false,color=null,moving=false){
    const [xx,yy]=this.project(x,y),c=this.c;
    this.shadow(x,y,.6,.45);c.save();c.globalAlpha=hiding?.4:1;
    if(name==="player"&&this.crouch){c.translate(0,yy);c.scale(1,.72);c.translate(0,-yy);}
    const body=color||(name==="player"?"#9b493c":name==="nora"?"#788585":"#817855");
    const walk=name==="player"?this.walking:moving;
    const tempo=name==="player"&&this.sprinting?0.95:0.6;
    const bounce=walk?Math.sin(this.frame*tempo)*1.5:Math.sin(this.frame*.1)*.3;
    this.poly([[xx-5,yy-12+bounce],[xx+5,yy-12+bounce],[xx+7,yy-3],[xx-6,yy-2]],body,true);
    this.poly([[xx+2,yy-12],[xx+5,yy-12],[xx+7,yy-3],[xx+2,yy-2]],"#4f3e37",true);
    this.poly([[xx-5,yy-24+bounce],[xx+3,yy-26+bounce],[xx+7,yy-21+bounce],[xx+6,yy-14+bounce],[xx-4,yy-13+bounce],[xx-7,yy-18+bounce]],"#c7aa85",true);
    c.fillStyle="#302f2a";c.fillRect(xx-4,yy-2,4,3);c.fillRect(xx+2,yy-2,4,3);
    if(name==="player"){this.poly([[xx-6,yy-22+bounce],[xx+3,yy-32+bounce],[xx+8,yy-23+bounce]],"#ad5945",true);
      this.poly([[xx-6,yy-18+bounce],[xx+6,yy-18+bounce],[xx,yy-10+bounce]],"#d6d1b4",true);
      c.fillStyle="#d6d1b4";c.fillRect(xx-7,yy-23+bounce,13,2);c.fillRect(xx+3,yy-32+bounce,3,3);}
    else {c.fillStyle=name==="nora"?"#594b38":"#5b5445";c.fillRect(xx-6,yy-25+bounce,11,5);if(name==="nora"){c.fillRect(xx+5,yy-22+bounce,3,8);c.fillStyle="#c7b997";c.fillRect(xx+6,yy-13,5,6);}}
    c.fillStyle=glasses?"#242c2f":"#4f4738";c.fillRect(xx-3,yy-20+bounce,glasses?4:1,glasses?3:1);c.fillRect(xx+2,yy-20+bounce,glasses?4:1,glasses?3:1);
    if(glasses)c.fillRect(xx-3,yy-19+bounce,9,1);
    c.restore();
  }
  prop(o,p){
    let {x,y,kind,id}=o,c=this.c,moving=false;
    if(!this.login&&(kind==="npc"||kind==="kids")){const paced=this.pace(id,x,y);x=paced.x;y=paced.y;moving=paced.moving;}
    const [xx,yy]=this.project(x,y);
    this.shadow(x,y,.65,.45);
    if(kind==="npc"||kind==="kids"){
      if(kind==="npc")this.person(x,y,id,false,false,null,moving);
      else [-.5,0,.5].forEach((v,i)=>this.person(x+v,y-v*.7,"kid",false,false,["#82764f","#765750","#537171"][i],moving));
      this.hits.push({obj:o,x:xx,y:yy-10,r:22});return;
    }
    if(kind==="tree"){this.tree(x,y,1.4);return;}
    if(kind==="door"){
      if(o.ladder){for(let i=0;i<7;i++){c.fillStyle="#aa9270";c.fillRect(xx-5,yy-22+i*3,11,1);}c.fillStyle="#716249";c.fillRect(xx-6,yy-24,2,25);c.fillRect(xx+5,yy-24,2,25);}
      else{this.box(x,y,1,.2,23,["#806b50","#4f493b","#aa8e64"]);c.fillStyle="#d5ae67";c.fillRect(xx-1,yy-10,2,2);}
    }else if(kind==="painting"){
      this.box(x,y,1.2,.15,16,["#a78b60","#75633f","#b5a278"]);
      c.fillStyle="#657570";c.fillRect(xx-7,yy-15,12,9);c.fillStyle="#c5c2a3";c.fillRect(xx-7,yy-6,12,2);
      c.fillStyle="#927753";c.fillRect(xx-2,yy-12,4,6);c.fillStyle="#ceb471";c.fillRect(xx-1,yy-10,1,2);
    }else if(kind==="plant"||kind==="decor"){
      this.box(x,y,.6,.6,5,["#8c634b","#684c3e","#ad815c"]);
      const watered=p.watered?.includes(id);for(let i=0;i<8;i++){const dx=(this.hash(i,x)*16-8),dy=this.hash(i,y)*9;
        this.poly([[xx,yy-5],[xx+dx,yy-9-dy],[xx+dx+3,yy-8-dy]],watered?"#3c5946":"#657751",true);}
      c.fillStyle="#b98a65";c.fillRect(xx-4,yy-14,3,2);c.fillRect(xx+4,yy-11,2,3);
      if(p.decorations?.[id]){c.fillStyle="#cfb668";c.fillRect(xx-8,yy-18,16,2);c.fillStyle="#a25b4d";c.fillRect(xx-6,yy-16,4,5);c.fillRect(xx+3,yy-16,4,5);}
    }else if(kind==="carousel"){
      this.box(x,y,2,2,5,["#8f705b","#624f43","#b5996e"]);this.box(x,y,.2,.2,30,["#948165","#625e50","#b9ad7f"]);
      this.roof(x,y,2.4,2.4,28,"#87574a");
      for(let i=0;i<3;i++){const t=(p.carousel_at?this.frame*.06:0)+i*2.1;const horse=this.project(x+Math.cos(t)*.8,y+Math.sin(t)*.8,11);c.fillStyle=["#b7a486","#806751","#c5c5ad"][i];c.fillRect(horse[0]-3,horse[1]-2,8,4);c.fillRect(horse[0]+3,horse[1]-5,3,5);}
    }else if(kind==="well"){
      this.box(x,y,1.3,1.3,10,["#858578","#555f5a","#b1b29d"]);c.fillStyle="#32484d";c.fillRect(xx-7,yy-10,11,3);this.roof(x,y,1.5,1.5,23);
    }else if(kind==="fire"||kind==="oven"){
      this.box(x,y,1.4,1,23,["#7c6c56","#4a4b43","#9d8a65"]);c.fillStyle="#372f26";c.fillRect(xx-8,yy-15,10,12);c.fillStyle="#bf864f";c.fillRect(xx-6,yy-8,6,4);c.fillStyle="#e0b26b";c.fillRect(xx-3,yy-11+(this.frame%3),2,6);
    }else if(kind==="bed"){
      this.box(x,y,1.4,2.2,8,["#9a805d","#6a5744","#bbb197"]);this.box(x,y-.5,1.3,1,11,["#c6bba0","#a19983","#d4cab1"]);this.person(x,y,"nora",false,false);
    }else if(kind==="backdrop"||kind==="stage"){
      this.box(x,y,2.7,.5,kind==="backdrop"?23:8,["#8c7357","#6b5740","#bcaa80"]);
      if(p.prepared?.backdrop||p.ending){this.poly([[xx-17,yy-12],[xx-8,yy-26],[xx+2,yy-7]],"#5f7569",true);this.poly([[xx+1,yy-8],[xx+11,yy-20],[xx+20,yy-3]],"#718377",true);}
      if(p.prepared?.puppets||p.ending){this.person(x-.6,y,"player");this.person(x+.2,y,"kid");this.person(x+.8,y,"kid");}
    }else if(kind==="curtain"||kind==="hide"){
      this.box(x,y,1,.5,20,["#6f5b49","#4c493b","#948568"]);
      if(kind==="hide"||p.prepared?.curtain){this.poly([[xx-9,yy-23],[xx+4,yy-17],[xx+4,yy],[xx-9,yy-6]],"#8b4d45",true);for(let i=0;i<4;i++){c.fillStyle="#513e3544";c.fillRect(xx-7+i*3,yy-19+i,1,13);}}
    }else if(kind==="lights"){
      const on=p.prepared?.lights;for(let i=0;i<7;i++){c.fillStyle=on?"#e7c17b":"#7c7b5c";c.fillRect(xx-12+i*3,yy-25+Math.sin(i)*2,2,2);}c.strokeStyle="#696c57";c.beginPath();c.moveTo(xx-12,yy-23);c.lineTo(xx+10,yy-23);c.stroke();
    }else if(kind==="bench"||kind==="table"||kind==="cart"||kind==="tray"){
      this.box(x,y,1.25,.8,10,["#907657","#66533e","#b39468"]);
      if(id==="cookie_table"&&p.prepared?.cookies){c.fillStyle="#d3ac72";for(let i=0;i<6;i++)c.fillRect(xx-6+i*2,yy-11+(i%2),2,2);}
      if(id==="bedside"&&p.card_placed){c.fillStyle="#d8ccac";c.fillRect(xx-3,yy-12,5,3);}
    }else if(kind==="book"){
      this.box(x,y,.9,.7,9);c.fillStyle="#cbbb91";c.fillRect(xx-7,yy-12,12,4);c.fillStyle="#7e6852";c.fillRect(xx-1,yy-12,1,4);
    }else if(kind==="cabinet"||kind==="shelf"){
      this.box(x,y,1,.5,24,["#807155","#4f5141","#9e8f68"]);for(let i=0;i<3;i++){c.fillStyle="#3d403366";c.fillRect(xx-7,yy-18+i*5,12,1);}
    }else if(kind==="notice"||kind==="window"){
      this.box(x,y,1,.2,21,["#9b855f","#655a40","#b69f76"]);c.fillStyle=kind==="window"?"#718d94":"#c7b994";c.fillRect(xx-7,yy-19,11,12);c.fillStyle="#686a5260";for(let i=0;i<3;i++)c.fillRect(xx-5,yy-16+i*3,6,1);
    }else if(kind==="puddle"||kind==="creak"){
      this.poly([[xx-9,yy],[xx-4,yy-4],[xx+9,yy],[xx+2,yy+4]],kind==="puddle"?"#81999b":"#77644e",true);
    }else if(kind==="glasses"){c.fillStyle="#181f23";c.fillRect(xx-5,yy-2,4,3);c.fillRect(xx+1,yy-1,4,3);c.fillRect(xx-1,yy,3,1);
    }else if(kind==="pickup"){this.box(x,y,.42,.42,7,["#cbb98a","#7d6244","#efe2c0"]);c.fillStyle="#3e3428";c.fillRect(xx-4,yy-10,8,5);
    }else if(kind==="bike"){c.strokeStyle="#8f947f";c.strokeRect(xx-9,yy-8,7,7);c.strokeRect(xx+4,yy-2,7,7);c.beginPath();c.moveTo(xx-5,yy-4);c.lineTo(xx+4,yy-10);c.lineTo(xx+7,yy+2);c.stroke();
    }else if(kind==="glass"||kind==="cup"||kind==="jar"||kind==="bell"){this.box(x,y,.32,.32,7,["#b6b49c","#7d897f","#d8ccb2"]);}
    else {this.box(x,y,.8,.75,10,["#917b56","#5d5540","#b7a579"]);}
    const near=Math.hypot(x-this.position[0],y-this.position[1])<1.65;
    if(near&&!this.login){c.strokeStyle="#ece1b199";c.strokeRect(Math.round(xx-11),Math.round(yy-27),22,29);}
    this.hits.push({obj:o,x:xx,y:yy-10,r:16});
  }
  floor(outdoor,night){
    const c=this.c;c.fillStyle=night?"#263b43":"#71868b";c.fillRect(0,0,320,240);
    for(let y=0;y<43;y++){c.fillStyle=y%4===0?"#adb4a315":"#2d44490c";c.fillRect(0,y,320,1);}
    if(outdoor){this.poly([[0,60],[37,28],[70,51],[106,17],[144,47],[187,24],[220,51],[267,31],[320,62],[320,90],[0,90]],night?"#405c5a":"#657b70",true);for(let i=0;i<9;i++)this.tree(i*1.2-1,-1,.7);}
    const corners=[[0,0],[10,0],[10,10],[0,10]].map(([x,y])=>this.project(x,y));
    this.poly(corners,outdoor?"#7d8271":"#8a7557",true);
    for(let x=0;x<10;x++)for(let y=0;y<10;y++){const a=this.project(x,y),b=this.project(x+1,y),cc=this.project(x+1,y+1),d=this.project(x,y+1);const v=this.hash(x,y);
      this.poly([a,b,cc,d],outdoor?(v>.6?"#96917c":"#767c6c"):(v>.6?"#927956":"#7b684e"),true);
      if(!outdoor){c.strokeStyle="#443e3122";c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.stroke();}}
    if(!outdoor){this.box(5,-.3,10,.3,28,["#9d8c68","#5f624f","#b5a580"]);this.box(-.3,5,.3,10,28,["#978a68","#5e634f","#b8a982"]);
      for(let i=0;i<7;i++){const [x,y]=this.project(.1,i*1.5,18);c.fillStyle="#746e5433";c.fillRect(x-1,y-5,4,3);}}
  }
  town(){
    this.floor(true,false);
    this.house(1.4,1.6,2.4,2.2,34,1);this.house(4.3,.7,2.2,1.8,38,0);this.house(7.2,1.3,2.2,2,34,1);
    this.house(8.6,4.4,1.8,2,34,0);this.house(1.4,6.4,2,2,30,1);
    this.prop({id:"carousel",kind:"carousel",x:4.5,y:4.8},{});
    this.prop({id:"well",kind:"well",x:7,y:6.5},{});
    this.tree(1,9,1.5);this.tree(9.5,8,1.4);this.tree(6,9.5,.9);
    this.box(1,9,1.5,1.3,45,["#8c7554","#5c5640","#b0936b"]);this.roof(1,9,1.6,1.4,45,"#696850");
    [2.4,5,7].forEach((x,i)=>this.prop({id:"plant",kind:"plant",x,y:3.5+i},{}));
    this.person(5.3,7.4,"player",true);this.person(5.8,6,"nora");
    this.person(3.7,6.2,"kid",false,false,"#9b7f55");
    this.c.fillStyle="#e0b36a";for(let i=0;i<8;i++){const [x,y]=this.project(2+i*.8,3.2,36-Math.sin(i/7*Math.PI)*10);this.c.fillRect(x,y,2,2);}
  }
  render(){
    const c=this.c;this.hits=[];
    c.setTransform(this.scale||1,0,0,this.scale||1,0,0);
    if(this.login||!this.state)this.town();
    else {
      const p=this.state.progress,w=this.state.world,scene=w.scenes[p.scene],night=p.phase==="night";
      this.floor(scene.outdoor,night);
      if(scene.outdoor){if(p.scene==="lanes"){this.house(2,1.1,2,1.4,30,1);this.house(5,.4,2,1.4,30,0);this.house(8.3,1.1,2,1.4,30,1);}else{this.house(9,.3,1.5,1.5,28,1);this.tree(.2,1,1.2);this.tree(9.5,8.8,1.2);}}
      let entities=w.objects.map(o=>({depth:o.x+o.y,draw:()=>this.prop(o,p)}));
      entities.push({depth:this.position[0]+this.position[1],draw:()=>{this.person(...this.position,"player",p.glasses,p.hiding,p.outfit?"#657c76":null);if(p.carrying)this.box(this.position[0]+.25,this.position[1]-.2,.9,.7,10);}});
      if(w.blocked){for(let i=0;i<3;i++)entities.push({depth:this.position[0]+this.position[1]+.4,draw:()=>this.person(this.position[0]+Math.cos(i*2)*.65,this.position[1]+Math.sin(i*2)*.65,"kid",false,false,["#79784e","#8a6254","#547071"][i])});}
      if(w.guard){const g=w.guard;const [gx,gy]=this.project(g.x,g.y);const points=[[gx,gy]];
        for(let i=0;i<=9;i++){const a=g.angle-.55+i*.11;points.push(this.project(g.x+Math.cos(a)*g.radius,g.y+Math.sin(a)*g.radius));}
        this.poly(points,"#dab96c25");
        entities.push({depth:g.x+g.y,draw:()=>this.person(g.x,g.y,g.name,false,false,"#977651")});}
      entities.sort((a,b)=>a.depth-b.depth).forEach(o=>o.draw());
      if(p.phase==="dusk"){c.fillStyle="#b5813f25";c.fillRect(0,0,320,240);}
      if(night){c.fillStyle="#15293b65";c.fillRect(0,0,320,240);if(scene.outdoor)for(let i=0;i<65;i++){c.fillStyle="#d2d8c788";c.fillRect((i*47+this.frame*.12)%320,(i*23+this.frame*.5)%240,1,1);}}
      if(p.cutscene_at){const seconds=(Date.now()/1000-p.cutscene_at);
        if(seconds<12){this.person(5.2,4-Math.abs(Math.sin(this.frame*.2))*.18,"nora");}
        else if(seconds<29){this.person(4.4+Math.sin(this.frame*.03),3.5,"player");this.person(6,3.5,"kid");}
        else{["#7d7855","#8f7158","#626f73","#8e7551","#807356","#658177","#785950","#9a8253"].forEach((col,i)=>this.person(2.8+i%4*1.2,6+Math.floor(i/4)*1.2,"resident",false,false,col));this.person(5.1,3.5,"nora");}}
    }
    this.post();
  }
  post(){
    const c=this.c;
    c.setTransform(1,0,0,1,0,0);
    const w=this.raw.width,h=this.raw.height,image=c.getImageData(0,0,w,h),data=image.data;
    const matrix=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
    const patina=this.patina??1,step=this.colorStep||8,s=this.scale||1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const idx=(y*w+x)*4,d=(matrix[(y%4)*4+(x%4)]-7.5)*1.2*patina;
      const grain=(this.hash(x,y,this.frame%5)-.5)*23*patina;
      const vig=1-Math.min(.35,((x-w/2)**2/(38000*s*s)+(y-h/2)**2/(24000*s*s))*.12);
      const block=(this.hash(x>>3,y>>3)-.5)*5*patina;
      for(let k=0;k<3;k++){
        const value=data[idx+k]*vig+d+grain+block;
        data[idx+k]=Math.max(0,Math.min(255,step<=1?Math.round(value):Math.round(value/step)*step));
      }
    }
    this.ctx.putImageData(image,0,0);
  }
  loop(now){requestAnimationFrame(this.loop);if(now-this.last<65)return;this.last=now;this.frame++;if(this.canvas.closest("section")?.hidden)return;this.render();}
}
window.PatinaScene=PatinaScene;

class TownAudio {
  constructor(){this.ctx=null;this.enabled=false;this.timer=null;this.volume=0.7;this.track="auto";this.phase="morning";this.cinema=false;this.playing="";}
  setVolume(v){this.volume=Math.max(0,Math.min(1,Number(v)||0));}
  setTrack(id){this.track=id||"auto";this.playing="";if(this.enabled)this.refresh();}
  ensure(){if(!this.enabled)return this.toggle();this.ctx?.resume();return this.enabled;}
  toggle(){this.enabled=!this.enabled;if(this.enabled){this.ctx??=new (window.AudioContext||window.webkitAudioContext)();this.ctx.resume();this.playing="";this.refresh();}else{clearInterval(this.timer);this.playing="";}return this.enabled;}
  tone(freq,at,duration=.13,volume=.028,type="triangle"){const level=volume*(this.volume??1);if(!this.enabled||!this.ctx||level<=0.0005)return;const osc=this.ctx.createOscillator(),gain=this.ctx.createGain();osc.type=type;osc.frequency.setValueAtTime(freq,at);osc.frequency.exponentialRampToValueAtTime(freq*.8,at+duration);gain.gain.setValueAtTime(.001,at);gain.gain.linearRampToValueAtTime(level,at+.015);gain.gain.exponentialRampToValueAtTime(.001,at+duration);osc.connect(gain);gain.connect(this.ctx.destination);osc.start(at);osc.stop(at+duration);}
  speak(name,text,emotion="平静",night=false){if(!this.enabled)return;const params={"诺拉":[470,.12],"芬恩":[150,.17],"萝丝":[330,.075],"汉克":[130,.09],"艾达":[270,.15],"格温":[250,.12],"三个孩子":[540,.07],"旁白":[210,.12]};
    const [base,speed]=params[name]||[250,.12];const count=Math.min(24,Math.ceil(text.length/2));for(let i=0;i<count;i++)this.tone(base*(1+(i%5)*.07)*(emotion==="开心"?1.2:1),this.ctx.currentTime+i*speed,.065+(i%3)*.02,night?.008:.022,i%3?"triangle":"sawtooth");}
  play(id){
    const tracks={
      day:{notes:[196,246.94,293.66,261.63,220,196,164.81,220],gap:700,dur:.65,vol:.012,type:"triangle"},
      hearth:{notes:[174.61,196,220,196,174.61,146.83,164.81,196],gap:840,dur:.8,vol:.011,type:"sine"},
      night:{notes:[146.83,164.81,146.83,130.81],gap:1500,dur:1.5,vol:.008,type:"sine"},
      show:{notes:[392,440,523.25,659.25,587.33,523.25,440,392],gap:550,dur:.5,vol:.016,type:"triangle"},
      quiet:{notes:[220,246.94],gap:2800,dur:1.8,vol:.005,type:"sine"}
    };
    const track=tracks[id]||tracks.day;
    clearInterval(this.timer);let step=0;
    this.timer=setInterval(()=>{if(!this.enabled)return;this.tone(track.notes[step++%track.notes.length],this.ctx.currentTime,track.dur,track.vol,track.type);},track.gap);
  }
  refresh(){
    if(!this.enabled)return;
    const id=this.track&&this.track!=="auto"?this.track:(this.cinema?"show":this.phase==="night"?"night":"day");
    if(id===this.playing)return;
    this.playing=id;this.play(id);
  }
  carousel(){if(!this.enabled)return;[523,659,784,659,587,698,880,698].forEach((n,i)=>this.tone(n,this.ctx.currentTime+i*.22,.2,.025,"sine"));}
  mode(phase,cinema=false){this.phase=phase||"morning";this.cinema=!!cinema;this.refresh();}
}
window.townAudio=new TownAudio();
