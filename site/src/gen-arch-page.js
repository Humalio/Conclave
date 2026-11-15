const fs=require('fs');
const A=require('./gen-arch.js');
const L=require('./arch-lib.js');
const {INK,TERRA,f,S,desk,laptop,folder,chair,lock,plant,BOOKS}=L;
const {heroSvgPhone,heroSvg,FAM,TOTAL,COLS,byName,pers,sseg,arch,key,gear,qy,qx,CREAM,CREAM2,HONEY,MOSS,SKY,ARCHC,tag}=A;
const DIR=require('path').join(__dirname,'..');
const logoSvg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254"><rect width="1254" height="1254" rx="256" fill="#3d2b1f"/><path fill="#c4503a" d="M143 290H698L910 502V691L577 928V724Z"/><path fill="#fbf2da" d="M910 691H1114L785 1008L458 1010Z"/></svg>`;
const fav='data:image/svg+xml,'+encodeURIComponent(logoSvg);
const svgWrap=(w,h,label,inner,cls='')=>`<svg ${cls?`class="${cls}" `:''}viewBox="0 0 ${w} ${h}" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="${label}">${inner}</svg>`;
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');

// ---------------- Section 2: a call travels ----------------
function stop(i){
 const s=new S(110,108,2.4);
 // road band
 const road=`<rect x="-2" y="136" width="224" height="38" fill="#ecd6a0" stroke="${INK}" stroke-width="1.5"/><line x1="-2" y1="155" x2="222" y2="155" stroke="${TERRA}" stroke-width="1.8" stroke-dasharray="1 7"/>`;
 s.add(road);
 // road texture: pebbles and kerb ticks
 for(let u=6;u<220;u+=17)s.add(`<path d="M${u} 141h5M${u+6} 168h4" stroke="#c9a96a" stroke-width="1.4" fill="none"/>`);

 s.box(0,0,0,30,30,3,['#e3b878','#a87238','#8c5c2c'],1.4);
 for(let u=6;u<30;u+=6)s.line(s.p(u,30,0),s.p(u,30,3),'#8c5c2c',.8,.7);
 const z=3;
 const PAPER=['#fff8e4','#e3d3a8','#c9b98c'],WD=['#d5a560','#c58d4a','#a8743c'];
 if(i===0){
  // owl behind the desk, working at a laptop
  L.animal(s,15,5,z,1.02,'owl');
  desk(s,3,6,24,13,7);s.box(3,6,z+7,24,13,2.4,WD,1.2);
  // drawer fronts with pulls
  [[5,7],[16,7]].forEach(([x])=>{qy(s,x,19,z+1,9,4.6,'#e3b878',.9);s.line(s.p(x+3.4,19,z+3),s.p(x+5.6,19,z+3),INK,1.6,1)});
  laptop(s,6,8,z+7+2.4,1.05);folder(s,20,12,z+7+2.4,.8);
  L.mug(s,23.5,16.5,z+9.4,'#c4503a');L.lamp(s,4,9,z+9.4,.62);
  s.box(11,16.5,z+9.4,6,3.6,.5,['#f4d583','#d9bc6a','#bfa458'],.6);s.box(12,17,z+9.9,2.6,2.2,.5,['#c97b8a','#b06070','#b06070'],.5);
  qy(s,6,6.2,z+9.4,3,.6,'#5f9a6a',.4);
  plant(s,28,27,z,.3);
  s.box(2,22,z,6,5,2.4,['#fff8e4','#e3d3a8','#c9b98c'],.8);
 }
 if(i===1){
  L.shade(s,[[5,18],[25,18],[29,24],[9,24]],z,.2);
  s.box(13,13,z,3,3,16,WD,1.2);
  s.box(11.4,11.4,z,6.2,6.2,1.4,['#e3b878','#b4822c','#8c5c2c'],.9);
  s.box(5,6,z+16,20,11,9,['#fbefd0','#e0c48a','#b98f5c'],1.4);
  // roof: ridge, shingle lines, gutter
  s.box(5,6,z+25,20,11,1.6,['#c4503a','#a3402e','#a3402e'],1.2);
  for(let u=8;u<25;u+=3)s.line(s.p(u,6,z+26.6),s.p(u,17,z+26.6),'#8c2f20',.8,.8);
  s.box(4,5.6,z+24.4,22,.9,.9,['#e0a93a','#cf9a3a','#b4822c'],.7);
  // mail slot, rivets, label plate, door
  qy(s,8,17,z+19.5,12,1.6,INK,.8);
  [[6.4,z+17.6],[23.4,z+17.6],[6.4,z+23.4],[23.4,z+23.4]].forEach(([x,zz])=>s.ell(x,17,zz,.4,'#e0a93a',.5));
  qy(s,9,17,z+21.4,10,1.6,'#f4d583',.7);s.line(s.p(10.5,17,z+22.2),s.p(17.5,17,z+22.2),INK,.9,.7);
  qy(s,10,17,z+17,6,1.3,'#8a5a2e',.6);
  s.box(23,5,z+25,1,1,9,WD,.9);
  const a=s.p(24,5.5,z+34),b=s.p(24,5.5,z+29.5);s.poly([a,[a[0]+22,a[1]+6],b],TERRA,1.2);
  s.line([a[0]+4,a[1]+1.4],[a[0]+4,b[1]+.6],'#fbf2da',.8,.7);
  s.ell(24,5.5,z+34.4,.7,'#e0a93a',.6);
  // tray with letters, parcel and a signpost
  s.box(8,19,z,10,6,.8,PAPER,.9);
  s.box(9,20,z+.8,6,3.6,.6,['#fff8e4','#e3d3a8','#c9b98c'],.6);s.qZ(10.6,21,2.4,1,z+1.4,TERRA,.4);
  s.box(19,21,z,5,4,3.6,['#e9cf96','#c9a06a','#a98a5a'],.9);s.line(s.p(21.5,21,z+3.6),s.p(21.5,25,z+3.6),'#8c5c2c',.8,.9);
  s.box(26.6,24,z,.9,.9,9,WD,.8);qy(s,25.6,24.2,z+7,3,2,'#f4d583',.7);

 }
 if(i===2){
  L.shade(s,[[5,18],[23,18],[27,23],[9,23]],z,.2);
  // doormat, ID badge and key lie flat on the plinth, all inside its edges
  s.box(2,20,z,8,6,.6,['#c4503a','#a3402e','#8c2f20'],.8);for(let u=0;u<3;u++)s.line(s.p(3.4+u*2.4,20.4,z+.6),s.p(3.4+u*2.4,25.6,z+.6),'#f1dfb5',.8,.9);
  s.box(23.4,3.6,z,5.4,7.2,.5,['#fbf2da','#e3d3a8','#c9b98c'],.8);s.ell(25.2,5.8,z+.5,1,'#e5a07c',.7);
  [[24.4,7.6,3.2],[24.4,8.8,2.2],[24.4,10,2.8]].forEach(([x,y,w])=>s.line(s.p(x,y,z+.55),s.p(x+w,y,z+.55),INK,.8,.8));
  s.cyl(15,15,z,7.5,10,['#e6cf9c','#d5a560','#a8743c'],1.3);
  [3,6.5].forEach(h=>{const q=s.p(15,15,z+h);s.o.push(`<path d="M${f(q[0]-7.5*1.2247*2.4)} ${f(q[1])}A${f(7.5*1.2247*2.4)} ${f(7.5*.7071*2.4)} 0 0 0 ${f(q[0]+7.5*1.2247*2.4)} ${f(q[1])}" fill="none" stroke="#a8743c" stroke-width="1" opacity=".8"/>`)});
  const q=s.p(15,15,z+10);lock(s,q[0],q[1]-4,1.5);
  // key lying on the plinth in the room's angle: bow, shaft, teeth, with a fob on a short chain
  const KG=['#e0a93a','#cf9a3a','#b4822c'];
  s.qZ(10.5,25,13,1.6,z+.3,HONEY,1);s.qZ(11,26.6,1.2,1.5,z+.3,HONEY,.9);s.qZ(13.6,26.6,1.2,1.1,z+.3,HONEY,.9);
  s.ell(25.4,25.8,z+.3,2.7,HONEY,1.2);s.ell(25.4,25.8,z+.4,1,'#f3e8d0',.9);
  s.line(s.p(26.4,23.4,z+.5),s.p(27.6,21.6,z+.5),INK,1,.9);
  s.ell(27.8,20.2,z+.3,1.9,'#fbf2da',1);s.ell(27.8,20.2,z+.4,.6,INK,0);
  plant(s,27,17,z,.26);
 }
 if(i===3){
  L.shade(s,[[3,24],[27,24],[31,29],[7,29]],z,.2);
  arch(s,4,26,24,z,17,ARCHC);
  // arch bricks / paint stripes
  for(let k=0;k<4;k++){qy(s,1.7,24+1.5,z+2+k*4,2.5,.8,'#c58d4a',.5);qy(s,26,24+1.5,z+2+k*4,2.5,.8,'#c58d4a',.5)}
  for(let u=2;u<=24;u+=4)qy(s,u+1,26,z+17,2,3,u%8===2?'#fbf2da':'#d5a560',.6);
  s.box(6,16,z,3,3,11,['#f1dfb5','#c58d4a','#8c5c2c'],1);s.box(21,16,z,3,3,11,['#f1dfb5','#c58d4a','#8c5c2c'],1);
  s.box(8.5,16.6,z+8,14,1.8,1.8,[TERRA,'#a3402e','#a3402e'],1);
  for(let k=0;k<3;k++)s.box(10+k*4.2,16.7,z+8,2,1.9,1.9,['#fbf2da','#e3d3a8','#e3d3a8'],.6);
  // booth, cones, clipboard, stop sign
  s.box(23,6,z,6,6,8,['#fbefd0','#e0c48a','#b98f5c'],1);qx(s,29,7.4,z+3.6,3.2,2.6,'#a9d2de',.8);s.box(22.4,5.4,z+8,7.2,7.2,1.1,['#c4503a','#a3402e','#a3402e'],.9);
  [[3,28.4]].forEach(([x,y])=>{const q=s.p(x,y,z);s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])})"><path d="M-4.6 0L-3 -12L3 -12L4.6 0Z" fill="#d9944f" stroke="${INK}" stroke-width="1.1"/><path d="M-3.5 -4.4H3.5M-2.7 -8H2.7" stroke="#fbf2da" stroke-width="1.6" fill="none"/></g>`)});
  const q=s.p(15,24,z+22);
  s.add(`<g transform="translate(${f(q[0])} ${f(q[1]-8)})"><circle r="10" fill="${TERRA}" stroke="${INK}" stroke-width="1.4"/><circle r="7.4" fill="none" stroke="#fbf2da" stroke-width=".9" stroke-dasharray="1.4 1.6"/><rect x="-6.5" y="-2" width="13" height="4" rx="1" fill="#fbf2da" transform="rotate(-35)"/></g>`);
  const w=s.p(26,26,z);s.o.push(`<g transform="translate(${f(w[0])} ${f(w[1])})"><path d="M0 0V-17" stroke="${INK}" stroke-width="1.6"/><path d="M-6 -17L6 -17L6 -24L0 -29L-6 -24Z" transform="translate(0 4)" fill="#c4503a" stroke="${INK}" stroke-width="1.1"/><path d="M-3.4 -17.6H3.4" stroke="#fbf2da" stroke-width="1.6"/></g>`);
 }
 if(i===4){
  const MET=['#d5dbd5','#aeb6ae','#8d958d'],RED=['#d9944f','#c4503a','#a3402e'];
  L.shade(s,[[5,18],[23,18],[27,22],[9,22]],z,.2);
  // carry handle folded back along the rear edge
  s.box(7,7,z+6,1.2,1.2,3.6,MET,.8);s.box(21,7,z+6,1.2,1.2,3.6,MET,.8);s.box(7,7,z+9.6,15.2,1.2,1.2,MET,.8);
  // open toolbox: body, dark interior, two compartments
  s.box(5,7,z,18,11,6,RED,1.4);
  s.qZ(6,8,16,9,z+6.05,'#7b4c25',.8);
  s.qZ(6.6,8.6,7.2,7.8,z+6.1,'#a8743c',.6);s.qZ(14.2,8.6,7.8,7.8,z+6.1,'#a8743c',.6);
  // front: rim stripe, two latches, rivets
  qy(s,5,18,z+4.6,18,.8,'#a3402e',.6);
  [[8,'#e0a93a'],[18.6,'#e0a93a']].forEach(([x,c])=>{qy(s,x,18,z+2.6,2.6,3.4,c,.9);s.ell(x+1.3,18,z+3.6,.35,INK,0)});
  [[6.4,z+1],[21.6,z+1]].forEach(([x,zz])=>s.ell(x,18,zz,.4,'#e0a93a',.5));
  // wrench and hammer resting in the tray
  s.qZ(7.2,12.6,9,1.4,z+6.2,MET[0],.8);s.ell(7,13.3,z+6.2,1.5,MET[0],.8);s.ell(7,13.3,z+6.25,.6,'#a8743c',.6);s.ell(16.6,13.3,z+6.2,1.2,MET[0],.8);
  s.qZ(15,9.4,6.4,1.2,z+6.2,['#d5a560','#c58d4a','#a8743c'][0],.8);s.box(14,9,z+6.2,2,2,1.4,MET,.8);
  // loose parts on the plinth: oil can and two bolts, clear of the box
  L.shade(s,[[3,23],[7,23],[8,26],[4,26]],z,.2);
  s.cyl(5,24.6,z,1.7,4.2,['#d9944f','#c4503a','#a3402e'],.9);s.cyl(5,24.6,z+4.2,.8,1,MET,.7);s.line(s.p(5,24.6,z+5.2),s.p(8,26.6,z+6.4),INK,1.2,1);
  s.cyl(13.6,25.6,z,1.1,1.4,MET,.7);s.cyl(18,26.8,z,1.1,1.4,MET,.7);
  // spare gear lying on the plinth
  s.cyl(24,25,z,2.8,.8,['#8fb577','#6c9a58','#547c45'],.9);s.ell(24,25,z+.8,1,'#f3e8d0',.7);
 }
 if(i===5){
  L.shade(s,[[3,23],[27,23],[31,28],[7,28]],z,.2);
  s.box(3,6,z,24,17,3.6,PAPER,1.3);
  s.box(3,6,z,2.6,17,3.6,['#c4503a','#a3402e','#a3402e'],1.2);
  for(let r=0;r<5;r++)s.line(s.p(5.6,6+r*3.4,z+3.6),s.p(27,6+r*3.4,z+3.6),'#c9b98c',.7,.8);
  s.box(6,8,z+3.6,19,14,3,PAPER,1.3);s.box(6,8,z+3.6,2.4,14,3,['#5b9ec9','#4a82a8','#4a82a8'],1.2);
  for(let r=0;r<4;r++)s.qZ(10.5,10+r*3,12,.9,z+6.6,'#c9b98c',.1);
  // ruled columns and lines on the open page, date stamps
  s.line(s.p(9,9,z+6.7),s.p(9,21,z+6.7),TERRA,1,.9);
  for(let r=0;r<5;r++)s.line(s.p(10.5,9.6+r*2.6,z+6.7),s.p(24,9.6+r*2.6,z+6.7),'#8b6a4c',.8,.8);
  [[12,'#5f9a6a'],[16,'#c4503a'],[20,'#e0a93a']].forEach(([y,c])=>s.qZ(19,y-1.6,3,1.5,z+6.8,c,.4));
  s.line(s.p(20,12,z+7.4),s.p(27,18,z+9),INK,2,1);
  s.poly([s.p(27,18,z+9),s.p(28.4,19.2,z+9.4),s.p(27.4,18.6,z+8.4)],'#c4503a',.7);
  // inkwell, stamp, magnifier, bookmark ribbon
  s.cyl(28,4,z,2,3,['#5a3d28','#3d2b1f','#2f2118'],.9);s.cyl(28,4,z+3,1.3,1.4,['#fbf2da','#e3d3a8','#c9b98c'],.7);
  const g=s.p(26,26,z);s.o.push(`<g transform="translate(${f(g[0])} ${f(g[1])})"><circle cx="0" cy="-9" r="7.4" fill="#d9edf2" fill-opacity=".7" stroke="${INK}" stroke-width="1.4"/><path d="M5.6 -4L12 3" stroke="#a8743c" stroke-width="3.4" stroke-linecap="round"/><path d="M5.6 -4L12 3" stroke="${INK}" stroke-width=".8" fill="none"/><path d="M-4 -11q2 -3 5 -3" fill="none" stroke="#fbf2da" stroke-width="1.2"/></g>`);
  s.box(4,24,z,4,4,2.8,['#d9944f','#c4503a','#a3402e'],.8);s.box(4.8,24.8,z+2.8,2.4,2.4,2,['#a8743c','#8c5c2c','#8c5c2c'],.7);
  s.poly([s.p(3.2,6,z+3.6),s.p(3.2,6,z+3.6),s.p(3.2,2.6,z+.4)],'#c4503a',.8);
 }
 return svgWrap(220,196,['Agent','MCP endpoint','Key and login','Policy','Tool','Audit log'][i],s.o.join(''));
}
const STOPS=[
 ['1 \u00b7 Agent','Calls a tool from its own client.'],
 ['2 \u00b7 MCP endpoint','Stateless, over Streamable HTTP.'],
 ['3 \u00b7 Key and login','A key proves who is calling.'],
 ['4 \u00b7 Policy','Rules are checked. A deny wins.'],
 ['5 \u00b7 Tool','The tool runs on the hub\u2019s data.'],
 ['6 \u00b7 Audit log','The outcome is recorded.'],
];
const travel=STOPS.map((s,i)=>`<div class="stop">${stop(i)}<div class="chip">${s[0]}</div><p>${s[1]}</p></div>`).join('');

// ---------------- Section 3: trust levels ----------------
function envelope(level,col,col2,variant){
 const s=new S(200,60,3.2);
 const W=52,D=36;
 const PAPER=['#fff8e4','#e3d3a8','#c9b98c'];
 const z=2.4,P=(x,y,zz)=>s.p(x,y,zz);
 L.shade(s,[[0,D],[W,D],[W+7,D+5],[6,D+5]],0.05,.2);
 s.box(0,0,0,W,D,2.4,PAPER,1.4);
 // paper texture: laid lines, fibres, corner folds
 for(let y=5;y<D-1;y+=4)s.line(P(2,y,z+.05),P(W-2,y,z+.05),'#c9b98c',.7,.45);
 [[8,9],[19,27],[34,12],[43,29],[12,31]].forEach(([x,y])=>s.line(P(x,y,z+.06),P(x+2.6,y+.5,z+.06),'#b8a984',.8,.7));
 if(variant==='open'){
  s.qZ(5,6,W-10,D-14,z+.1,'#fffdf4',1);
  for(let r=0;r<3;r++)s.line(P(9,11+r*5,z+.2),P(W-12-r*5,11+r*5,z+.2),'#c9b98c',1.3,1);
  for(let r=0;r<3;r++)s.line(P(9,12.6+r*5,z+.2),P(W-18-r*3,12.6+r*5,z+.2),'#e3d3a8',.8,1);
  s.poly([P(0,0,z),P(W,0,z),P(W/2,-D*.6,z+D*.32)],'#f1dfb5',1.4);
  for(let k=1;k<4;k++)s.line(P(W/2+(k-2)*7,-D*.6*.62*(1-Math.abs(k-2)*.12),z+D*.2),P(W/2+(k-2)*11,-1,z+.1),'#d6c7a2',.8,.7);
 }else{
  s.poly([P(0,0,z),P(W,0,z),P(W/2,D*.52,z)],'#f1dfb5',1.4);
  s.poly([P(0,D,z),P(W/2,D*.52,z),P(0,0,z)],'#fff8e4',0);
  s.line(P(0,D,z+.05),P(W/2,D*.52,z+.05),'#c9b98c',1,.9);s.line(P(W,D,z+.05),P(W/2,D*.52,z+.05),'#c9b98c',1,.9);
  for(let k=1;k<4;k++)s.line(P(k*W/4,0,z+.1),P(W/2+(k-2)*3,D*.52-1.5,z+.1),'#d6c7a2',.8,.7);
 }
 if(variant==='band'){s.qZ(0,D*.82,W,4,z+.1,col,1.1);for(let u=3;u<W;u+=5)s.line(P(u,D*.82+.8,z+.2),P(u,D*.82+3.2,z+.2),'#fbf2da',.8,.6)}
 const sy=variant==='open'?D*.6:D*.52;
 // ribbon tails under the seal
 if(variant!=='open'){s.poly([P(W/2-3,sy,z+.3),P(W/2-9,sy+9,z+.3),P(W/2-5,sy+7.4,z+.3),P(W/2-2,sy+10,z+.3),P(W/2,sy,z+.3)],col2,.9);s.poly([P(W/2+3,sy,z+.3),P(W/2+9,sy+9,z+.3),P(W/2+5,sy+7.4,z+.3),P(W/2+2,sy+10,z+.3),P(W/2,sy,z+.3)],col2,.9)}
 // wax seal: drip, scalloped edge, pressed rings, level letters
 s.poly([P(W/2+4,sy+4,z+.4),P(W/2+8.6,sy+4.4,z+.4),P(W/2+9.4,sy+8.4,z+.4),P(W/2+7.4,sy+9.4,z+.4),P(W/2+6,sy+6.2,z+.4)],col,1);
 for(let a=0;a<12;a++){const an=a*Math.PI/6;s.ell(W/2+Math.cos(an)*6.9,sy+Math.sin(an)*6.9,z+.45,1.5,col,.9)}
 s.ell(W/2,sy,z+.5,7.4,col,1.4);s.ell(W/2,sy,z+.6,5.3,'none',1.1,col2);s.ell(W/2,sy,z+.65,6.4,'none',.7,'#fbf2da');
 s.ell(W/2-3,sy-3,z+.7,1.2,'#fbf2da',0);
 s.textZ(z+.7,W/2-3.8,sy+1.6,level,6.4,'#fbf2da',700);
 // small prop per level
 if(variant==='card'){s.box(62,6,0,18,24,1.2,['#f4d583','#d9bc6a','#bfa458'],1.2);
  for(let r=0;r<3;r++)s.line(P(65,11+r*5,1.3),P(77-r*3,11+r*5,1.3),INK,1.1,.7);
  // punch hole, pen and paper clip on the card
  s.ell(70,8.4,1.4,1,'#d9bc6a',.7);
  s.box(63,24.6,1.2,12,1.6,1.4,['#5b9ec9','#4a82a8','#4a82a8'],.8);s.box(75,24.7,1.2,2,1.4,1.2,['#3d2b1f','#2f2118','#2f2118'],.6);
  s.o.push(`<path d="M${f(P(77,9,1.4)[0])} ${f(P(77,9,1.4)[1])}v-10a3 3 0 0 1 6 0v12a2 2 0 0 1 -4 0v-9" fill="none" stroke="#9aa39a" stroke-width="1.4"/>`);}
 if(variant==='band'){
  // brass hub stamp with ink pad
  s.box(60,18,0,12,10,1.6,['#5a3d28','#3d2b1f','#2f2118'],1);s.qZ(61.6,19.6,8.8,6.8,1.7,col,.7);
  s.cyl(66,23,1.7,2.4,5,['#e0a93a','#cf9a3a','#b4822c'],1);s.cyl(66,23,6.7,3.4,1.4,['#a8743c','#8c5c2c','#6e4620'],1);
  s.box(60.6,5,0,10,6,2,['#fff8e4','#e3d3a8','#c9b98c'],.9);s.line(P(62,8,2.1),P(69,8,2.1),'#8b6a4c',.8,1);}
 if(variant==='open'){
  // loose notes and a magnifier: untrusted data to inspect
  s.box(-14,10,0,9,12,.8,PAPER,.9);s.box(-13,12,.8,9,12,.8,['#fffdf4','#e3d3a8','#c9b98c'],.9);
  s.line(P(-11.4,16,1.7),P(-6,16,1.7),'#c9b98c',1,1);s.line(P(-11.4,19,1.7),P(-7.4,19,1.7),'#c9b98c',1,1);
  const g=P(W+8,D-8,0.4);s.o.push(`<g transform="translate(${f(g[0])} ${f(g[1])})"><ellipse cx="0" cy="-8" rx="9" ry="9" fill="#d9edf2" fill-opacity=".7" stroke="${INK}" stroke-width="1.5"/><path d="M6.4 -1.6L14 6" stroke="#a8743c" stroke-width="3.6" stroke-linecap="round"/><path d="M6.4 -1.6L14 6" stroke="${INK}" stroke-width=".8" fill="none"/><path d="M-5 -11q2 -4 6 -4" fill="none" stroke="#fbf2da" stroke-width="1.3"/></g>`);
 }
 // fit: nothing may be clipped by the 400 x 190 viewBox
 const b=s.bb,w=b[2]-b[0],h=b[3]-b[1],m=8;
 const sc=Math.min(1,(400-2*m)/w,(190-2*m)/h);
 const tx=(400-w*sc)/2-b[0]*sc,ty=(190-h*sc)/2-b[1]*sc;
 return svgWrap(400,190,'Trust level '+level,`<g transform="translate(${f(tx)} ${f(ty)}) scale(${f(sc)})">${s.o.join('')}</g>`);
}
const TRUST=[
 ['L0','Hub and playbook','Follow.',MOSS,'#47775a','band','Hub notices, the team playbook and operator notes.'],
 ['L1','Your task or review','Act within your permissions.',HONEY,'#b4822c','card','Work assigned to you, checked against policy.'],
 ['L2','Messages, files, shares','Data, never instructions.',TERRA,'#a3402e','open','Peer text, vault files, shares and channel data.'],
];
const trust=TRUST.map(t=>`<div class="tl">${envelope(t[0],t[3],t[4],t[5])}<div class="chip" style="--c:${t[3]}">${t[0]}</div><h3>${t[2]}</h3><p class="k">${t[1]}</p><p>${t[6]}</p></div>`).join('');

// ---------------- Section 4: cabinet ----------------
function drawer(x){
 const pills=x.a.map(n=>`<span>${n}</span>`).join('')+x.s.map(n=>`<span class="sh">${n}</span>`).join('');
 return `<div class="dr"><div class="hd"><i class="kn"></i><b class="pl">${esc(x.n)}</b><em>${x.c}</em></div><p>${esc(x.d)}</p><div class="tt">${pills}</div>${x.s.length?`<small>Dashed: shims kept for one release; they answer with a note naming the bp_* tools.</small>`:''}</div>`}
const cabinet=COLS.map(c=>`<div class="cc">${c.map(n=>drawer(byName(n))).join('')}</div>`).join('');

// ---------------- Section 5: stack ----------------
const TBB=[];let TT=null;
function token(i){
 const s=new S(100,52,2.5);
 const PAPER=['#fff8e4','#e3d3a8','#c9b98c'],WD=['#d5a560','#c58d4a','#a8743c'];
 L.shade(s,[[0,34],[34,34],[40,40],[6,40]],0.05,.2);
 s.box(0,0,0,34,34,3,['#e3b878','#a87238','#8c5c2c'],1.4);const z=3;
 for(let u=6;u<34;u+=7)s.line(s.p(u,34,0),s.p(u,34,3),'#8c5c2c',.8,.7);
 const ring=(cx,cy,zz,r,col='#b4822c')=>{const q=s.p(cx,cy,zz),rx=r*1.2247*2.5,ry=r*.7071*2.5;s.o.push(`<path d="M${f(q[0]-rx)} ${f(q[1])}A${f(rx)} ${f(ry)} 0 0 0 ${f(q[0]+rx)} ${f(q[1])}" fill="none" stroke="${col}" stroke-width="1" opacity=".85"/>`)};
 if(i===0){[0,1,2].forEach(n=>s.cyl(17,17,z+n*9,11,8.4,n===2?[HONEY,'#cf9a3a','#b4822c']:['#e8c070','#cf9a3a','#b4822c'],1.4));
  [0,1,2].forEach(n=>{ring(17,17,z+n*9+2.6,11);ring(17,17,z+n*9+5.6,11,'#cf9a3a')});
  // label plates on each disc, rows in the top disc
  [0,1,2].forEach(n=>{const q=s.p(24.8,24.8,z+n*9+4.2);s.o.push(`<rect x="${f(q[0]-6)}" y="${f(q[1]-3.4)}" width="12" height="6.6" rx="1.2" fill="#fbf2da" stroke="${INK}" stroke-width=".9"/><path d="M${f(q[0]-3.6)} ${f(q[1]-.8)}h7.2M${f(q[0]-3.6)} ${f(q[1]+1.4)}h4.6" stroke="${INK}" stroke-width=".8" fill="none"/>`)});
  for(let r=-1;r<=1;r++)s.line(s.p(17-6,17+r*3.4,z+27),s.p(17+6,17+r*3.4,z+27),'#b4822c',.9,.7);
  s.ell(17,17,z+27,1.6,'#fbf2da',.7);
  // write-ahead log notebook, pencil, tape
  s.box(25.5,27,z,8,6,1.6,['#fff8e4','#e3d3a8','#5b9ec9'],.9);s.line(s.p(26.5,29,z+1.6),s.p(32.5,29,z+1.6),'#8b6a4c',.7,1);s.line(s.p(26.5,31,z+1.6),s.p(30.5,31,z+1.6),'#8b6a4c',.7,1);
  s.box(2,28,z,9,1.2,1.2,['#e0a93a','#cf9a3a','#b4822c'],.8);s.poly([s.p(11,28,z+.6),s.p(13,28.6,z+.6),s.p(11,29.2,z+.6)],'#f1dfb5',.7);
  L.shade(s,[[28.4,4],[33,4.6],[33,9],[29,9]],z,.2);s.cyl(30,6,z,1.8,2.6,['#e3d3a8','#c9b98c','#b8a984'],.9);
 }
 if(i===1){
  const cs=['#8fb577','#d9944f','#a9d2de','#e0a93a','#c97b8a'];
  cs.forEach((c,n)=>s.box(4,4+n*5.4,z+n*0,26-n*1.5,4.6,3.2+(n%2)*.6,[ '#fff8e4','#e3d3a8',c],1.2));
  cs.forEach((c,n)=>s.box(5,5+n*5.4,z+3.8,24-n*1.5,4.4,3,['#fff8e4','#e3d3a8',c],1.2));
  // label slips on the top of each shelf row (no overlap with the next row)
  cs.forEach((c,n)=>{const y0=5+n*5.4;s.qZ(6,y0+2.4,5,1.5,z+6.85,'#fbf2da',.6);s.qZ(11.6,y0+2.4,2,1.5,z+6.85,c,.6)});
  // obsidian crystal: small solid gem resting on the back row
  {const zb=z+6.8,P=(x,y,zz)=>s.p(x,y,zz);
   L.shade(s,[[28,6],[29,6.4],[29,9.2],[28,8.8]],zb,.22);
   s.poly([P(24,8.8,zb),P(28,8.8,zb),P(27.2,8,zb+3.4),P(24.8,8,zb+3.4)],'#a97bab',1.1);
   s.poly([P(28,8.8,zb),P(28,5.6,zb),P(27.2,6.4,zb+3.4),P(27.2,8,zb+3.4)],'#7b4f7d',1.1);
   s.poly([P(24.8,8,zb+3.4),P(27.2,8,zb+3.4),P(26,7.2,zb+6.6)],'#d2b0d4',1.1);
   s.poly([P(27.2,8,zb+3.4),P(27.2,6.4,zb+3.4),P(26,7.2,zb+6.6)],'#9a6a9d',1.1);
   s.line(P(25.4,8.8,zb+.6),P(25.4,8,zb+3),'#e3c9e5',.8,.9)}
  // wiki-link arc
  const a=s.p(8,12,z+7.6),b=s.p(25,20,z+7.6);s.o.push(`<path d="M${f(a[0])} ${f(a[1])}Q${f((a[0]+b[0])/2)} ${f(a[1]-22)} ${f(b[0])} ${f(b[1])}" fill="none" stroke="#3d2b1f" stroke-width="1.2" stroke-dasharray="1 4"/>`);
  s.box(16,26.8,z+6.8,5,3.6,.8,['#fff8e4','#e3d3a8','#c9b98c'],.7);
 }
 if(i===2){
  const r=5.6,zc=z+3+r,cy=17,xa=4,xb=29,MET=['#e6cf9c','#d5a560','#a8743c'];
  const k=2.5,pp=(x,th,rr=r)=>{const q=s.p(x,cy+rr*Math.cos(th),zc+rr*Math.sin(th));return q};
  const ellPts=(x,rr=r)=>Array.from({length:36},(_,n)=>pp(x,n*Math.PI/18,rr));
  const path=pts=>pts.map((q,n)=>(n?'L':'M')+f(q[0])+' '+f(q[1])).join('')+'Z';
  const dv=[.866,.5];let aT=0,bT=0,aV=1e9,bV=-1e9;
  for(let n=0;n<72;n++){const th=n*Math.PI/36,q=pp(xa,th),c=q[0]*dv[1]-q[1]*dv[0];if(c<aV){aV=c;aT=th}if(c>bV){bV=c;bT=th}}
  // saddles and flat shadow first
  L.shade(s,[[3,21.5],[31,21.5],[34,25],[6,25]],z,.2);
  [8,24].forEach(x=>{s.box(x-1.3,cy-4.4,z,2.6,8.8,3.4,['#a8743c','#8c5c2c','#6e4620'],1)});
  // far cap, body, near cap
  const span=((aT-bT)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
  const hp=Array.from({length:19},(_,n)=>pp(xa,bT+span*n/18)),hm=Array.from({length:19},(_,n)=>pp(xa,bT-(2*Math.PI-span)*n/18));
  const prj=h=>h[9][0]*dv[0]+h[9][1]*dv[1];const farArc=prj(hp)<prj(hm)?hp:hm;
  const A0=pp(xa,aT),A1=pp(xb,aT),B0=pp(xa,bT),B1=pp(xb,bT);
  s.o.push(`<path d="M${f(A0[0])} ${f(A0[1])}L${f(A1[0])} ${f(A1[1])}`+Array.from({length:37},(_,n)=>{const th=aT+(bT-aT+(bT<aT?2*Math.PI:0))*n/36;const q=pp(xb,th);return 'L'+f(q[0])+' '+f(q[1])}).join('')+farArc.map(q=>'L'+f(q[0])+' '+f(q[1])).join('')+`Z" fill="${MET[1]}" stroke="none"/>`);
  s.o.push(`<path d="M${f(B0[0])} ${f(B0[1])}`+farArc.map(q=>'L'+f(q[0])+' '+f(q[1])).join('')+`" fill="none" stroke="${INK}" stroke-width="1.3"/>`);
  // shading band that follows the cylinder: bounded by the same end-ellipse arcs, from the lower silhouette round the underside
  {const lowT=pp(xa,aT)[1]>pp(xa,bT)[1]?aT:bT,tw=Math.PI/4,df=Math.atan2(Math.sin(tw-lowT),Math.cos(tw-lowT)),sg=df>0?1:-1;
   const ths=Array.from({length:13},(_,n)=>lowT+sg*.95*n/12);
   const e1=ths.map(th=>pp(xb,th)),e0=ths.map(th=>pp(xa,th)).reverse();
   s.o.push(`<path d="${path(e1.concat(e0))}" fill="${MET[2]}" stroke="none" opacity=".55"/>`)}
  s.line(A0,A1,INK,1.3);s.line(B0,B1,INK,1.3);
  // flange rings (front half) and flow arrows on the surface
  const arc=(x,rr)=>Array.from({length:19},(_,n)=>pp(x,-Math.PI/4+n*Math.PI/18*(180/ (18))* (Math.PI/180)*1,rr));
  const front=(x,rr)=>Array.from({length:19},(_,n)=>pp(x,-Math.PI/4+n*(Math.PI)/18,rr));
  [10.5,22.5].forEach(x=>{const a=front(x-.9,r+.9),b=front(x+.9,r+.9).reverse();
   s.o.push(`<path d="${path(a.concat(b))}" fill="#c58d4a" stroke="${INK}" stroke-width="1.1"/>`);
   [0.2,.9,1.6,2.3].forEach(th=>{const q=pp(x,th*1+0.0,r+.9);s.o.push(`<circle cx="${f(q[0])}" cy="${f(q[1])}" r=".8" fill="#3d2b1f"/>`)})});
  [[14,'#c4503a'],[26,'#c4503a']].forEach(([x])=>{const th=Math.PI/4+.1,a=pp(x-2.6,th-.28),b=pp(x+2.4,th),c=pp(x-2.6,th+.28);s.o.push(`<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}L${f(c[0])} ${f(c[1])}Z" fill="${TERRA}" stroke="${INK}" stroke-width="1"/>`)});
  [[12.4,18.8]].forEach(([x0,x1])=>{const a=pp(x0,Math.PI/4+.1),b=pp(x1-2.8,Math.PI/4+.1);s.line(a,b,INK,1.2,.9)});
  // near cap: rim and open port
  s.o.push(`<path d="${path(ellPts(xb,r))}" fill="${MET[0]}" stroke="${INK}" stroke-width="1.3"/><path d="${path(ellPts(xb+.01,r*.62))}" fill="#5b9ec9" stroke="${INK}" stroke-width="1.1"/><path d="${path(ellPts(xb+.02,r*.3).map(q=>[q[0]-1,q[1]-1]))}" fill="#a9d2de" stroke="none"/>`);
  // gauge and valve wheel attached on top of the pipe
  const top=(x)=>s.p(x,cy,zc+r);
  const g=top(16.5);s.o.push(`<g transform="translate(${f(g[0])} ${f(g[1])})"><rect x="-2" y="-8" width="4" height="8" fill="#c58d4a" stroke="${INK}" stroke-width="1.1"/><ellipse cx="0" cy="0" rx="3.8" ry="1.6" fill="#a8743c" stroke="${INK}" stroke-width="1.1"/><circle cx="0" cy="-14" r="6.2" fill="#fbf2da" stroke="${INK}" stroke-width="1.3"/><circle cx="0" cy="-14" r="4.4" fill="none" stroke="#c9b98c" stroke-width=".8"/><path d="M-3 -12A3.6 3.6 0 0 1 3 -12" fill="none" stroke="${INK}" stroke-width=".8"/><path d="M0 -12L2 -15.4" stroke="${TERRA}" stroke-width="1.3"/></g>`);
  const v=top(25);s.o.push(`<g transform="translate(${f(v[0])} ${f(v[1])})"><ellipse cx="0" cy="0" rx="4.2" ry="1.8" fill="#a8743c" stroke="${INK}" stroke-width="1.1"/><path d="M0 0V-8" stroke="${INK}" stroke-width="2"/><ellipse cx="0" cy="-9" rx="6.4" ry="2.4" fill="${TERRA}" stroke="${INK}" stroke-width="1.1"/><path d="M-4.4 -9H4.4" stroke="#fbf2da" stroke-width=".8"/></g>`);
  // parcel and crate resting on the plinth
  s.box(4,27,z,6,4,2.8,['#fff8e4','#e3d3a8','#c9b98c'],.8);s.qZ(5,28,3,1.2,z+2.8,TERRA,.4);
  s.box(27,3,z,5,5,2.4,['#8fb577','#6c9a58','#547c45'],.8);
 }
 if(i===3){s.box(6,14,z,22,12,2,WD,1.3);s.box(15,18,z+2,4,4,7,WD,1.2);
  s.box(3,8,z+9,28,5,18,['#3d2b1f','#2f2118','#4a372a'],1.4);
  qy(s,5,13,z+11,24,14,'#a8ded4',1);
  // title bar with window dots, page blocks, cursor, stand stripe
  qy(s,5,13,z+23.6,24,1.4,'#3f8f8a',.5);[['#c4503a',7],['#e0a93a',9.2],['#5f9a6a',11.4]].forEach(([c,x])=>s.ell(x,13,z+24.3,.5,c,.4));
  [[.7,.7],[.5,.5],[.3,.62]].forEach(([zz,ww])=>s.line(s.p(8,13,z+11+14*zz),s.p(8+20*ww,13,z+11+14*zz),'#3f8f8a',1.6,1));
  s.line(s.p(8,13,z+11+14*.1),s.p(14,13,z+11+14*.1),TERRA,1.6,1);
  qy(s,20,13,z+12,7,5,'#fbf2da',.7);qy(s,20.8,13,z+13,2.2,3,'#5b9ec9',.4);qy(s,23.4,13,z+13,2.6,1.2,'#c9b98c',.4);
  const c=s.p(24.4,13,z+14.6);s.o.push(`<path d="M${f(c[0])} ${f(c[1])}l0 9l2.4 -2.2l2 4l1.6 -.8l-2 -3.8l3.2 -.2Z" fill="#fbf2da" stroke="${INK}" stroke-width="1"/>`);
  // keyboard, mouse, plant, mug
  s.box(8,27,z,14,5,1,['#f2e7cd','#d6c7a2','#b8a984'],.9);for(let k=0;k<3;k++)s.line(s.p(9.4,28.2+k*1.2,z+1.05),s.p(20.6,28.2+k*1.2,z+1.05),'#8b6a4c',.6,1);
  s.cyl(25,29,z,1.6,1.4,['#f2e7cd','#d6c7a2','#b8a984'],.8);L.mug(s,28.4,4,z,'#c4503a');
 }
 if(i===4){
  // two PCs (folders) with a clear gap; sheets fly through the air between them
  const FC=['#f2e7cd','#e3d3a8','#b8a984'];
  const pc=(x,y,tab)=>{
   L.shade(s,[[x,y+10],[x+11,y+10],[x+14,y+13],[x+3,y+13]],z,.2);
   s.box(x,y,z,11,10,9,FC,1.3);
   s.box(x+1.5,y+1.5,z+9,4.6,2,1.1,[tab,tab,tab],.9);
   qy(s,x+2.2,y+10,z+3,6.6,2.8,'#fbf2da',.8);s.line(s.p(x+3.4,y+10,z+4.4),s.p(x+7.6,y+10,z+4.4),INK,.9,.8);
   s.ell(x+8.6,y+10,z+6.6,.45,TERRA,.4)};
  pc(2,12,'#f4d583');pc(21,12,'#8fb577');
  // flight path through the empty gap, well above both tops
  const P0=s.p(7,14,z+20),P2=s.p(27,14,z+20),C=[(P0[0]+P2[0])/2,Math.min(P0[1],P2[1])-20];
  s.o.push(`<path d="M${f(P0[0])} ${f(P0[1])}Q${f(C[0])} ${f(C[1])} ${f(P2[0])} ${f(P2[1])}" fill="none" stroke="${TERRA}" stroke-width="1.8" stroke-dasharray="1 5" stroke-linecap="round"/>`);
  [[.2,-16],[.5,-4],[.8,12]].forEach(([u,rot])=>{const x=(1-u)*(1-u)*P0[0]+2*(1-u)*u*C[0]+u*u*P2[0],y=(1-u)*(1-u)*P0[1]+2*(1-u)*u*C[1]+u*u*P2[1];
   s.o.push(`<g transform="translate(${f(x)} ${f(y-4)}) rotate(${rot})"><path d="M-9 -2h-4M-9 2h-6" stroke="#8b6a4c" stroke-width="1" stroke-linecap="round" fill="none"/><rect x="-4" y="-5" width="8" height="10" rx="1" fill="#fff8e4" stroke="${INK}" stroke-width="1"/><path d="M-2 -2h4M-2 .4h4M-2 2.8h2.6" stroke="#8b6a4c" stroke-width=".7" fill="none"/></g>`)});
  plant(s,5,29,z,.26);
 }
 if(i===5){s.box(2,5,z,30,24,10,['#6f9fb7','#5b8aa3','#4a748c'],1.4);
  for(let r=1;r<6;r++)s.line(s.p(2+r*5,29,z),s.p(2+r*5,29,z+10),'#3d2b1d',1.1,.6);
  // second container on top with doors and latches, id plate, stripe
  s.box(6,9,z+10,18,10,5,['#e0a93a','#cf9a3a','#b4822c'],1.2);
  for(let r=1;r<4;r++)s.line(s.p(6+r*4.5,19,z+10),s.p(6+r*4.5,19,z+15),'#a3822a',.9,.6);
  qy(s,19,29,z+2,10,5,'#fbf2da',.9);s.line(s.p(20.6,29,z+4.6),s.p(26,29,z+4.6),INK,.9,.8);s.line(s.p(20.6,29,z+3.2),s.p(24,29,z+3.2),INK,.9,.8);
  [[5,z+3],[5,z+7],[24,z+3],[24,z+7]].forEach(([x,zz])=>s.line(s.p(x,29,zz),s.p(x+2.2,29,zz),'#e3d3a8',1.4,1));
  // compose file scroll with lines, anchor and corner castings
  s.box(9,11.4,z+15,9,6,.7,['#fff8e4','#e3d3a8','#c9b98c'],.7);for(let k=0;k<3;k++)s.line(s.p(10.2,12.8+k*1.5,z+15.7),s.p(10.2+6.4-k,12.8+k*1.5,z+15.7),'#5b9ec9',.8,1);
  s.o.push(`<g transform="translate(${f(s.p(29,6,z+10)[0])} ${f(s.p(29,6,z+10)[1])})"><path d="M0 0V-9M-3.4 -7H3.4" stroke="${INK}" stroke-width="1.4" fill="none"/><path d="M-5 -2Q0 3 5 -2" fill="none" stroke="${INK}" stroke-width="1.4"/><circle cy="-10.4" r="1.8" fill="none" stroke="${INK}" stroke-width="1.1"/></g>`);
 }
 TBB[i]=s.bb;
 return svgWrap(200,150,['SQLite','Vault','MCP','Web console','Bridge','Docker'][i],TT?`<g transform="translate(${f(TT[0])} ${f(TT[1])}) scale(${f(TT[2])})">${s.o.join('')}</g>`:s.o.join(''));
}
// fit all six tokens with one shared transform so none is clipped by the 200 x 150 viewBox
for(let i=0;i<6;i++)token(i);
{const x0=Math.min(...TBB.map(b=>b[0])),y0=Math.min(...TBB.map(b=>b[1])),x1=Math.max(...TBB.map(b=>b[2])),y1=Math.max(...TBB.map(b=>b[3]))+6,m=5;
 const sc=Math.min(1,(200-2*m)/(x1-x0),(150-2*m)/(y1-y0));TT=[(200-(x1-x0)*sc)/2-x0*sc,m-y0*sc,sc];console.log('token fit',TT)}
const STACK=[
 ['SQLite','One database, WAL mode: policy, workflow, audit, graph metadata.'],
 ['Obsidian-compatible vault','A plain directory. Obsidian is optional.'],
 ['Streamable HTTP MCP','One stateless endpoint for every agent.'],
 ['Web console','The operator\u2019s view and controls.'],
 ['Bridge, optional','One per PC. Large files move folder to folder.'],
 ['Docker Compose','Self-hosted. One Fastify process on Node.js 24.'],
];
const stack=STACK.map((x,i)=>`<div class="tk">${token(i)}<div class="chip">${x[0]}</div><p>${x[1]}</p></div>`).join('');

// wood grain tiles (flat strokes, no gradients) and the objects standing on the cabinet
const grainTile=(c,op,w=240,h=120)=>{let d='';for(let y=10;y<h;y+=15){const a=(y*7)%11;d+='<path d="M0 '+y+'C'+(60+a)+' '+(y-4)+' '+(120-a)+' '+(y+5)+' '+w+' '+(y-1)+'" fill="none" stroke="'+c+'" stroke-width="1.2" stroke-opacity="'+op+'"/>'}
 d+='<ellipse cx="'+(60+h)+'" cy="52" rx="7" ry="3" fill="none" stroke="'+c+'" stroke-width="1" stroke-opacity="'+op+'"/><ellipse cx="170" cy="96" rx="5" ry="2" fill="none" stroke="'+c+'" stroke-width="1" stroke-opacity="'+op+'"/>';
 return 'url("data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+d+'</svg>')+'")'};
const GR_CAB=grainTile('#a8743c',.4);
const IK='stroke="#3d2b1f" stroke-width="1.2"';
const cabTop=`<svg class="cab-top" viewBox="0 0 440 40" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
<rect x="14" y="31" width="52" height="9" rx="1" fill="#5f9a6a" ${IK}/><path d="M20 34.5h40" stroke="#fbf2da" stroke-width="1" fill="none"/><rect x="18" y="22" width="44" height="9" rx="1" fill="#e0a93a" ${IK}/><path d="M24 26.5h12M42 26.5h14" stroke="#7b5a40" stroke-width="1" fill="none"/><rect x="22" y="14" width="38" height="8" rx="1" fill="#c4503a" ${IK}/><rect x="28" y="16.4" width="14" height="3.2" fill="#fbf2da" stroke="none"/><path d="M45 14v-5" stroke="#3d2b1f" stroke-width="1.2" fill="none"/>
<path d="M76 40l-3 -14h22l-3 14Z" fill="#c98350" ${IK}/><rect x="71" y="23" width="26" height="5" rx="1.5" fill="#c98350" ${IK}/><path d="M84 23C74 20 70 12 72 5C80 8 84 14 84 23M84 23C88 12 94 8 100 8C100 16 92 21 84 23M84 23C84 14 84 8 86 2C90 9 88 16 84 23" fill="#86a468" ${IK}/><path d="M84 22V8M76 12l5 5M92 14l-5 4" stroke="#47663a" stroke-width=".9" fill="none"/>
<path d="M128 40a14 4 0 0 1 28 0Z" fill="#a8743c" ${IK}/><path d="M142 37L138 16L156 6" fill="none" stroke="#3d2b1f" stroke-width="2.6"/><path d="M142 37L138 16L156 6" fill="none" stroke="#e0a93a" stroke-width="1"/><path d="M150 8L168 12L162 24Z" fill="#e0a93a" ${IK}/><circle cx="138" cy="16" r="2.4" fill="#fbf2da" ${IK}/><path d="M154 24L168 30L150 34" fill="#fff1b4" fill-opacity=".0" stroke="none"/>
<rect x="190" y="22" width="56" height="18" rx="2" fill="#d5a560" ${IK}/><rect x="198" y="27" width="40" height="9" rx="1" fill="#fbf2da" ${IK}/><path d="M203 31.5h30" stroke="#7b5a40" stroke-width="1" fill="none"/><circle cx="218" cy="24.6" r="1.1" fill="#e0a93a" stroke="none"/><path d="M194 22V9h14v13M210 22V6h14v16M226 22V11h16v11" fill="#fbf2da" ${IK}/><path d="M197 13h8M213 10h8M230 15h8" stroke="#8b6a4c" stroke-width="1" fill="none"/><rect x="214" y="27.6" width="8" height="3" fill="#e0a93a" ${IK}/>
<path d="M276 40V26h20v14Z" fill="#fbf2da" ${IK}/><path d="M296 29q7 0 7 5t-7 5" fill="none" stroke="#3d2b1f" stroke-width="2.4"/><path d="M278 31h16" stroke="#c4503a" stroke-width="2.4" fill="none"/><path d="M281 26l-3 -14M286 26V8M291 26l4 -15" stroke="#3d2b1f" stroke-width="2" fill="none"/><path d="M278 12l-1.4 -3M286 8v-3M295 11l1.6 -3" stroke="#c4503a" stroke-width="2.4" fill="none"/>
<circle cx="340" cy="23" r="15" fill="#fbf2da" ${IK}/><circle cx="340" cy="23" r="11.4" fill="none" stroke="#c9b98c" stroke-width="1"/><path d="M340 23V14M340 23l6 3" stroke="#3d2b1f" stroke-width="1.6" fill="none"/><circle cx="326" cy="10" r="4.4" fill="#e0a93a" ${IK}/><circle cx="354" cy="10" r="4.4" fill="#e0a93a" ${IK}/><path d="M326 36l-3 4M354 36l3 4M340 8V5" stroke="#3d2b1f" stroke-width="1.6" fill="none"/>
<path d="M382 40V30l12 -3l12 3v10Z" fill="#a9d2de" ${IK}/><path d="M382 30l12 3l12 -3M394 33v7" fill="none" stroke="#3d2b1f" stroke-width="1.1"/><path d="M386 22l8 -5l8 5" fill="none" stroke="#3d2b1f" stroke-width="1.2"/><rect x="408" y="36" width="20" height="4" rx="1" fill="#8a5a8c" ${IK}/><rect x="410" y="32" width="16" height="4" rx="1" fill="#5b9ec9" ${IK}/>
</svg>`;
const famCount=FAM.length;
const css=`
@font-face{font-family:Geist;src:url(fonts/geist.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"Geist Mono";src:url(fonts/geist-mono.woff2) format("woff2");font-weight:100 900}
:root{--bg:#f3e8d0;--ink:#3d2b1f;--acc:#c4503a;--mut:#7a6246;--moss:#4f6b3c;--body:#5a4431;--paper:#fbf2da;--sand:#e3b878;--honey:#d5a560}
*{box-sizing:border-box;margin:0}
body{width:100%;max-width:1440px;margin:0 auto;position:relative;background:var(--bg);color:var(--ink);font:16px/1.5 Geist,system-ui,sans-serif}
.pg{padding:0 60px;position:relative}
nav{height:56px;border-bottom:1.5px solid var(--ink);display:flex;align-items:center;justify-content:space-between;font:500 12px "Geist Mono";letter-spacing:.1em;text-transform:uppercase}
nav .b{font-weight:600;font-size:14px;display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none}
nav .b svg{width:26px;height:26px}
nav a.i{margin-left:34px;color:var(--ink);text-decoration:none;padding:6px 0}
nav a.on{border-bottom:2px solid var(--acc)}
.eyebrow,.num{font:500 12px "Geist Mono";letter-spacing:.12em;color:var(--moss);display:flex;align-items:center;gap:10px}
.eyebrow:before,.num:before{content:"";width:30px;border-top:1.5px solid var(--moss)}
.top{padding-top:64px}
h1{font:500 56px/1.05 Geist;letter-spacing:-.03em;margin-top:0}
h1 u{text-underline-offset:8px;text-decoration-color:var(--acc);text-decoration-thickness:3px;text-decoration-skip-ink:none}
.sub{font-size:20px;line-height:1.45;color:var(--body);margin-top:16px;max-width:640px}
.hero-art{display:block;width:1320px;height:auto;margin-top:6px}
.sec{margin-top:150px}
h2{font:600 40px/1.12 Geist;letter-spacing:-.03em;margin-top:16px}
.lead{font-size:18px;color:var(--body);margin-top:12px;max-width:560px}
.chip{display:inline-block;font:600 12.5px "Geist Mono";background:var(--paper);border:1.2px solid var(--ink);border-radius:3px;padding:4px 10px;box-shadow:2.5px 3px 0 rgba(90,61,40,.2)}
.travel{display:grid;grid-template-columns:repeat(6,220px);margin-top:36px}
.stop{width:220px;text-align:center;position:relative}
.stop svg{width:220px;height:auto;display:block}
.stop .chip{margin-top:6px}
.stop p{font-size:14.5px;line-height:1.4;color:var(--body);margin:12px 14px 0}
.tls{display:grid;grid-template-columns:repeat(3,1fr);gap:48px;margin-top:40px}
.tl{text-align:center}
.tl svg{width:400px;height:auto;display:block;margin:0 auto}
.tl .chip{margin-top:4px;border-color:var(--ink);color:#fbf2da;background:var(--c);text-shadow:none}
.tl h3{font:600 30px/1.15 Geist;letter-spacing:-.025em;margin-top:18px}
.tl .k{font:500 12.5px "Geist Mono";letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin-top:8px}
.tl p{font-size:15.5px;color:var(--body);margin:8px auto 0;max-width:340px}
.cab{margin-top:40px;background:var(--honey) ${GR_CAB};border:1.5px solid var(--ink);border-radius:6px;padding:26px;box-shadow:6px 7px 0 rgba(90,61,40,.22);position:relative}
.plq{position:absolute;right:26px;top:-26px;display:flex;align-items:center;gap:14px;background:#e0a93a;border:1.5px solid var(--ink);border-radius:4px;padding:8px 18px;box-shadow:3px 3px 0 var(--ink)}
.plq b{font:600 34px/1 Geist;letter-spacing:-.03em}
.plq span{font:600 12px "Geist Mono";letter-spacing:.1em;text-transform:uppercase;line-height:1.25}
.cgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;align-items:start}
.cc{display:flex;flex-direction:column;gap:16px}
.cab-top{position:absolute;left:34px;bottom:100%;width:440px;max-width:62%;height:auto;margin-bottom:-1.5px;pointer-events:none}
.cab:before,.cab:after{content:"";position:absolute;bottom:-9px;width:30px;height:9px;background:#a8743c;border:1.5px solid var(--ink);border-top:0;border-radius:0 0 3px 3px}
.cab:before{left:34px}.cab:after{right:34px}
.cgrid{position:relative}
.cgrid:before{content:"";position:absolute;inset:-10px;background:#d6a560;border:1.5px solid var(--ink);border-radius:3px;box-shadow:inset 0 3px 0 rgba(90,61,40,.18)}
.cc{position:relative}
.dr{position:relative;background:var(--paper);border:1.5px solid var(--ink);border-radius:4px;padding:16px 16px 18px;box-shadow:inset 0 -4px 0 rgba(90,61,40,.16),inset 0 3px 0 rgba(255,248,228,.4)}
.dr:after{content:"";position:absolute;left:50%;bottom:4.5px;width:48px;height:7px;margin-left:-24px;background:#e0a93a;border:1.2px solid var(--ink);border-radius:4px;box-shadow:0 2px 0 rgba(90,61,40,.25)}
.dr:before{content:"";position:absolute;left:calc(50% - 34px);bottom:6px;width:5px;height:5px;border-radius:50%;background:#b4822c;box-shadow:63px 0 0 #b4822c}
.hd{display:flex;align-items:center;gap:12px}
.kn{width:16px;height:16px;border-radius:50%;background:#e0a93a;border:1.5px solid var(--ink);flex:none;box-shadow:inset -2px -2px 0 #b4822c}
.pl{position:relative;font:600 13px "Geist Mono";background:var(--paper);border:1.2px solid var(--ink);border-radius:3px;padding:3px 10px;box-shadow:0 0 0 2.5px #e0a93a,0 0 0 3.7px var(--ink),2px 3px 0 3.7px rgba(90,61,40,.2)}
.pl:before,.pl:after{content:"";position:absolute;top:50%;width:3px;height:3px;margin-top:-1.5px;border-radius:50%;background:var(--ink)}
.pl:before{left:-6.5px}.pl:after{right:-6.5px}
.hd em{margin-left:auto;font:600 12px "Geist Mono";font-style:normal;color:var(--ink);background:#f3e8d0;border:1.2px solid var(--ink);border-radius:20px;padding:1px 9px}
.dr p{font-size:14.5px;line-height:1.4;color:var(--ink);margin:12px 0 12px}
.tt{display:flex;flex-wrap:wrap;gap:5px}
.tt span{font:500 11.5px/1.3 "Geist Mono";background:var(--paper);border:1px solid var(--ink);border-radius:3px;padding:2px 6px}
.tt span.sh{border-style:dashed;color:var(--mut);background:transparent}
.dr small{display:block;font:11.5px/1.4 "Geist Mono";color:var(--body);margin-top:10px}
.stk{display:grid;grid-template-columns:repeat(6,1fr);gap:0;margin-top:40px}
.tk{text-align:center;padding:0 8px}
.tk svg{width:200px;height:auto;display:block;margin:0 auto}
.tk .chip{margin-top:4px;font-size:12px}
.tk p{font-size:14.5px;line-height:1.4;color:var(--body);margin:12px 6px 0}
.back{margin-top:110px;display:flex;align-items:center;gap:26px;justify-content:center}
.back a.l{font:600 16px Geist;color:var(--ink);text-decoration:underline;text-underline-offset:5px;text-decoration-thickness:1.5px}
footer{margin-top:60px;border-top:1.5px solid var(--ink);height:84px;display:flex;align-items:center;justify-content:space-between;font:500 12px "Geist Mono";letter-spacing:.1em;text-transform:uppercase}
footer .b{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px}
footer .b svg{width:18px;height:18px}
footer a{color:var(--ink);text-decoration:none;margin-left:34px}
.hero-ph{display:none}
@media (max-width:1439px){
.hero-art{width:100%}
.travel{grid-template-columns:repeat(6,minmax(0,1fr))}
.stop{width:auto}.stop svg{width:100%}
.stop p{margin:12px 6px 0}
.tls{gap:28px}.tl svg{width:100%;max-width:400px}
.stk{grid-template-columns:repeat(6,minmax(0,1fr))}
.tk svg{width:100%;max-width:200px}
}
@media (max-width:1000px){
.pg{padding:0 32px}
h1{font-size:46px}
.sec{margin-top:100px}
.travel{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:28px}
.tls{grid-template-columns:minmax(0,1fr);max-width:440px;margin-left:auto;margin-right:auto}
.cgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
.cc:last-child{grid-column:1/-1}
.stk{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:28px}
.back{margin-top:80px}
}
@media (max-width:760px){
.pg{padding:0 16px}
nav a.i:not(.on){display:none}
nav a.i{margin-left:0}
.top{padding-top:40px}
h1{font-size:32px;line-height:1.1}
.sub{font-size:17px;margin-top:14px}
.hero-art{display:none}
.hero-ph{display:block;width:calc(100% + 32px);height:auto;margin:16px -16px 0}
.sec{margin-top:72px}
h2{font-size:28px;margin-top:12px}
.lead{font-size:17px}
.num{font-size:12px}
.travel{grid-template-columns:minmax(0,1fr);row-gap:10px;margin-top:24px}
.stop{display:grid;grid-template-columns:132px minmax(0,1fr);column-gap:14px;text-align:left;align-items:center}
.stop svg{grid-row:1/3;width:132px}
.stop .chip{margin-top:0;justify-self:start;align-self:end}
.stop p{margin:8px 0 0;font-size:16px;align-self:start}
.tls{gap:20px;margin-top:20px}
.tl svg{margin-top:-36px}
.tl h3{font-size:28px}.tl p{font-size:16px}
.cab{padding:16px 12px;margin-top:44px}
.plq{right:12px;top:-30px;padding:6px 14px}.plq b{font-size:30px}
.cgrid{grid-template-columns:minmax(0,1fr);gap:14px}
.cc{gap:14px}
.dr p{font-size:15.5px}
.pl{font-size:14px}
.tt span{font-size:12px}
.dr small{font-size:12px}
.stk{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:26px;margin-top:28px}
.tk{padding:0 4px}
.tk p{font-size:15px;margin:10px 2px 0}
.back{margin-top:64px}
footer{margin-top:48px;height:auto;padding:22px 0;gap:12px}
footer a{margin-left:20px}
}
`;
const {OWNER,REPO}=require('./repo.js');const GH='https://github.com/'+OWNER+'/'+REPO;
const U={docs:GH+'/tree/main/docs',gh:GH};
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conclave \u00b7 Tools and architecture</title><meta name="description" content="One hub, one SQLite database, one vault. Agents reach it over MCP."><meta property="og:type" content="website"><meta property="og:title" content="Conclave · Tools and architecture"><meta property="og:description" content="One hub, one SQLite database, one vault. Agents reach it over MCP."><meta name="theme-color" content="#f3e8d0"><link rel="icon" href="${fav}"><style>${css}/* SOFT_INK */svg [stroke="#3d2b1f"]{stroke:#8b6a4c}svg [stroke-width="1.3"],svg [stroke-width="1.5"]{stroke-width:1.1}/* UI_C */svg rect[fill="#5a3d28"][fill-opacity=".2"][height="26"]{display:none}svg rect[fill="#fbf2da"][stroke="#3d2b1f"][height="26"],svg rect[fill="#f7e4b0"][stroke="#3d2b1f"][height="26"]{rx:13px;fill:rgba(251,242,218,.94);stroke:#8b6a4c;stroke-width:1}svg rect[fill="#fbf2da"][stroke="#3d2b1f"][height="26"]~text,svg rect[fill="#f7e4b0"][stroke="#3d2b1f"][height="26"]~text{font-weight:500;font-size:12px;fill:#5a4431}nav{font:500 12px "Geist Mono";letter-spacing:.04em;text-transform:lowercase;border-bottom:1px solid rgba(61,43,31,.18)}nav .b{text-transform:none;font:600 15px Geist;letter-spacing:-.01em}nav>div:last-child{display:flex;align-items:center;border:1px solid rgba(61,43,31,.35);border-radius:999px;padding:3px}nav a.i{opacity:1;border-radius:999px;padding:6px 14px;margin-left:0}nav a.i:hover{background:rgba(61,43,31,.07)}nav a.on,nav a.on:hover{background:#3d2b1f;color:#fbf2da;border-bottom:0}.btn{border-radius:999px;background:#c4503a;border-color:#c4503a}.go a.l{text-decoration:none;border:1px solid var(--ink);border-radius:999px;padding:11px 20px;font-weight:500}.chip{border-radius:999px;border-width:1px;box-shadow:none;font-weight:500}</style></head><body><div class="pg">
<nav><a class="b" href="./">${logoSvg}Conclave</a><div><a class="i" href="./#agents">Agents</a><a class="i" href="./#vault">Vault</a><a class="i" href="./#supervision">Supervision</a><a class="i on" href="architecture.html">Architecture</a></div></nav>
<header class="top"><h1>Tools and <u>architecture</u></h1><p class="sub">One hub, one SQLite database, one vault. Agents reach it over MCP.</p></header>
${heroSvg}${heroSvgPhone}
<section class="sec"><div class="num">01 \u00b7 A CALL</div><h2>How a call travels</h2><p class="lead">Six stops, every time.</p><div class="travel">${travel}</div></section>
<section class="sec"><div class="num">02 \u00b7 TRUST</div><h2>Trust levels</h2><p class="lead">Every item an agent receives carries one.</p><div class="tls">${trust}</div></section>
<section class="sec"><div class="num">03 \u00b7 TOOLS</div><h2>The tools</h2><p class="lead">${famCount} families, one drawer each.</p><div class="cab">${cabTop}<div class="plq"><b>${TOTAL}</b><span>tools<br>${famCount} families</span></div><div class="cgrid">${cabinet}</div></div></section>
<section class="sec"><div class="num">04 \u00b7 STACK</div><h2>The stack</h2><p class="lead">Six building blocks.</p><div class="stk">${stack}</div></section>
<div class="back"><a class="l" href="./">\u2190 Back to Conclave</a></div>
<footer><div class="b">${logoSvg}Conclave</div><div><a href="${U.docs}">Docs</a><a href="${U.gh}">GitHub</a></div></footer>
</div></body></html>`;
fs.writeFileSync(DIR+'/architecture.html',html);
console.log('written',html.length,'tools',TOTAL,'fam',famCount);
