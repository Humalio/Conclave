const fs=require('fs');
const path=require('path');const SRC=__dirname,OUT=path.join(__dirname,'..');
const DT=require('./detail.js');
const hero=fs.readFileSync(SRC+'/hero-room.html','utf8');
const INK='#3d2b1f',TERRA='#c4503a';
const f=n=>Math.round(n*10)/10;
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};
const BOOKS=['#5f9a6a','#d9944f','#f1e0b8','#c4503a','#e0a93a','#5b9ec9','#8a5a8c'];
const WOOD=['#d5a560','#c58d4a','#a8743c'];

class S{
 constructor(ox,oy,k){this.ox=ox;this.oy=oy;this.k=k;this.o=[];this.bb=[1e9,1e9,-1e9,-1e9]}
 p(x,y,z=0){return [this.ox+(x-y)*0.866*this.k,this.oy+(x+y)*0.5*this.k-z*this.k]}
 add(s){this.o.push(s)}
 poly(pts,fill,sw=1.3,stroke=INK){pts.forEach(q=>{this.bb=[Math.min(this.bb[0],q[0]),Math.min(this.bb[1],q[1]),Math.max(this.bb[2],q[0]),Math.max(this.bb[3],q[1])]});
  this.o.push(`<polygon points="${pts.map(q=>f(q[0])+','+f(q[1])).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`)}
 qZ(x,y,w,d,z,fill,sw=1.1){this.poly([this.p(x,y,z),this.p(x+w,y,z),this.p(x+w,y+d,z),this.p(x,y+d,z)],fill,sw)}
 qY(x,y,z,w,h,fill,sw=1.1){this.poly([this.p(x,y,z),this.p(x+w,y,z),this.p(x+w,y,z+h),this.p(x,y,z+h)],fill,sw)}
 qX(x,y,z,d,h,fill,sw=1.1){this.poly([this.p(x,y,z),this.p(x,y+d,z),this.p(x,y+d,z+h),this.p(x,y,z+h)],fill,sw)}
 box(x,y,z,w,d,h,c,sw=1.3){this.qY(x,y+d,z,w,h,c[1],sw);this.qX(x+w,y,z,d,h,c[2],sw);this.qZ(x,y,w,d,z+h,c[0],sw)}
 line(a,b,col=INK,sw=1,op=1,extra=''){this.o.push(`<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${col}" stroke-width="${sw}" stroke-opacity="${op}" ${extra}/>`)}
 ell(cx,cy,z,r,fill,sw=1.3,stroke=INK){const q=this.p(cx,cy,z);this.o.push(`<ellipse cx="${f(q[0])}" cy="${f(q[1])}" rx="${f(r*1.2247*this.k)}" ry="${f(r*0.7071*this.k)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`)}
 cyl(cx,cy,z,r,h,c,sw=1.3){const q=this.p(cx,cy,z),rx=r*1.2247*this.k,ry=r*0.7071*this.k,hh=h*this.k;
  this.o.push(`<path d="M${f(q[0]-rx)} ${f(q[1]-hh)}L${f(q[0]-rx)} ${f(q[1])}A${f(rx)} ${f(ry)} 0 0 0 ${f(q[0]+rx)} ${f(q[1])}L${f(q[0]+rx)} ${f(q[1]-hh)}Z" fill="${c[1]}" stroke="${INK}" stroke-width="${sw}"/>`);
  this.ell(cx,cy,z+h,r,c[0],sw)}
 // text on horizontal plane
 textZ(z,x,y,txt,size,col,wt=600){const k=this.k,e=this.p(0,0,z);this.o.push(`<text transform="matrix(${f(.866*k)} ${f(.5*k)} ${f(-.866*k)} ${f(.5*k)} ${f(e[0])} ${f(e[1])})" x="${x}" y="${y}" font-size="${size}" font-weight="${wt}" fill="${col}" font-family="Geist Mono">${txt}</text>`)}
 svg(w,h,label){return `<svg viewBox="0 0 ${w} ${h}" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="${label}">${this.o.join('')}</svg>`}
}
function tag(x,y,text,o={}){const w=Math.round(text.length*7.6+22);const col=o.col||INK;
 return `<g transform="translate(${x} ${y}) rotate(${o.rot||0})"><rect x="2.5" y="3.5" width="${w}" height="26" rx="3" fill="#5a3d28" fill-opacity=".2"/><rect width="${w}" height="26" rx="3" fill="${o.fill||'#fbf2da'}" stroke="${INK}" stroke-width="1.2"/><text x="11" y="17.5" font-size="12.5" font-weight="${o.col?700:600}" fill="${col}" font-family="Geist Mono">${text}</text></g>`}
function tagL(x,y,text,tx,ty,o={}){const w=Math.round(text.length*7.6+22);
 return `<g><line x1="${f(x+w/2)}" y1="${y+13}" x2="${f(tx)}" y2="${f(ty)}" stroke="${INK}" stroke-width="1.2" stroke-dasharray="1 3.5" stroke-linecap="round"/><circle cx="${f(tx)}" cy="${f(ty)}" r="3" fill="${TERRA}" stroke="${INK}" stroke-width="1"/></g>`+tag(x,y,text,o)}
function room(s,W,D,H,o={}){
 s.box(-2.5,-2.5,-8,W+2.5,D+2.5,8,[o.floor||'#e3b878','#a87238','#8c5c2c'],1.5);
 for(let y=12;y<D;y+=12)s.line(s.p(0,y,0),s.p(W,y,0),'#b07a3c',1,.4);
 s.box(-2.5,-2.5,0,2.5,2.5,H,['#fbefd0','#7b5a40','#7b5a40'],1.5);
 s.box(0,-2.5,0,W,2.5,H,['#fbefd0','#f8e5b4','#7b5a40'],1.5);
 s.box(-2.5,0,0,2.5,D,H,['#fbefd0','#7b5a40','#eed59f'],1.5);
}
function desk(s,x,y,w,d,h){
 const lc=['#d5a560','#c58d4a','#a8743c'];
 s.box(x+1,y+1,0,2.4,2.4,h,lc,1);s.box(x+w-3.4,y+1,0,2.4,2.4,h,lc,1);s.box(x+1,y+d-3.4,0,2.4,2.4,h,lc,1);s.box(x+w-3.4,y+d-3.4,0,2.4,2.4,h,lc,1);
 s.box(x,y,h,w,d,2.4,WOOD,1.4)}
function laptop(s,x,y,z,m=1,scr='#a8ded4'){
 const w=18*m,d=12*m,h=13*m,P=(a,b,c)=>s.p(a,b,c);
 s.box(x,y,z,w,d,1.4*m,['#f2e7cd','#d6c7a2','#b8a984'],1.1);
 const yy=y+1.2*m,z0=z+1.4*m;
 s.poly([P(x,yy,z0),P(x+w,yy,z0),P(x+w,yy,z0+h),P(x,yy,z0+h)],'#d6c7a2',1.2);
 const i=1.5*m;
 s.poly([P(x+i,yy,z0+i),P(x+w-i,yy,z0+i),P(x+w-i,yy,z0+h-i),P(x+i,yy,z0+h-i)],scr,.8);
 [[.75,.7],[.55,.5],[.35,.62]].forEach(([zz,ww])=>s.line(P(x+i+1.5*m,yy,z0+h*zz+0.5*m),P(x+i+1.5*m+(w-2*i-3*m)*ww,yy,z0+h*zz+0.5*m),'#3f8f8a',1.5,1));
}
function folder(s,x,y,z,m=1){const w=10*m,d=8*m,h=8*m;
 s.box(x,y,z,w,d,h,['#f2e7cd','#e3d3a8','#b8a984'],1.2);
 s.qY(x+1.5*m,y+d,z+2.5*m,w-3*m,3*m,TERRA,.8)}
function chair(s,x,y,z,col=['#a9c78a','#86a96a','#5a7d4b']){
 const lc=['#d5a560','#c58d4a','#a8743c'];
 s.box(x+1,y+1,z,1.6,1.6,8,lc,.9);s.box(x+9,y+1,z,1.6,1.6,8,lc,.9);s.box(x+1,y+9,z,1.6,1.6,8,lc,.9);s.box(x+9,y+9,z,1.6,1.6,8,lc,.9);
 s.box(x,y,z+8,11,11,2.2,col,1.2);
 s.box(x,y+9,z+10.2,11,2,13,col,1.2)}
function person(s,x,y,z,sc=0.95){const q=s.p(x,y,z),k=s.k*sc;
 s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(k)})"><ellipse cx="0" cy="1" rx="10" ry="4.5" fill="#5a3d28" fill-opacity=".2"/><path d="M-8 0C-8 -13 -5 -17 0 -17C5 -17 8 -13 8 0Z" fill="${TERRA}" stroke="${INK}" stroke-width="1.3"/><circle cx="0" cy="-24" r="6.2" fill="#e5805c" stroke="${INK}" stroke-width="1.3"/></g>`);
 return [q[0],q[1]-30*k]}
function lock(s,px,py,sc=1){s.o.push(`<g transform="translate(${f(px)} ${f(py)}) scale(${sc})"><path d="M-5 -2V-7A5 5 0 0 1 5 -7V-2" fill="none" stroke="${INK}" stroke-width="2.6"/><rect x="-8" y="-3" width="16" height="12" rx="2" fill="#e0a93a" stroke="${INK}" stroke-width="1.3"/><circle cx="0" cy="3" r="1.6" fill="${INK}"/></g>`)}
function plant(s,x,y,z,sc=1,pot='#c98350'){const q=s.p(x,y,z);const ls=[[-62,50,'#5d7f45'],[-38,67,'#86a468'],[-14,62,'#47663a'],[10,57,'#9ab97a'],[34,52,'#5d7f45'],[58,69,'#86a468'],[-25,64,'#47663a'],[22,59,'#9ab97a']];
 let o=`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${sc})"><path d="M-15 -24L15 -24L11 0L-11 0Z" fill="${pot}" stroke="${INK}" stroke-width="1.4"/><rect x="-17" y="-27" width="34" height="6" rx="2" fill="${pot}" stroke="${INK}" stroke-width="1.4"/>`;
 o+=`<ellipse cx="0" cy="-24" rx="13" ry="2.2" fill="#5a3d28"/>`;
 ls.forEach(([r,l,c])=>{o+=`<path transform="translate(0 -25) rotate(${r})" d="M0 0C12 ${-l*.3} 8.4 ${-l*.8} 0 ${-l}C-8.4 ${-l*.8} -12 ${-l*.3} 0 0Z" fill="${c}" stroke="${INK}" stroke-width="1.1"/><path transform="translate(0 -25) rotate(${r})" d="M0 -2L0 ${-l*.86}M0 ${-l*.3}L4 ${-l*.42}M0 ${-l*.3}L-4 ${-l*.42}M0 ${-l*.55}L3.4 ${-l*.66}M0 ${-l*.55}L-3.4 ${-l*.66}" fill="none" stroke="#2f4a2a" stroke-width=".8" stroke-opacity=".55"/>`});
 o+=`<path d="M-13 -16L13 -16L12 -11L-12 -11Z" fill="#5a3d28" fill-opacity=".25"/>`;
 s.o.push(o+'</g>')}
// wall unit: orient 'y' (wall y=0, runs along x) or 'x' (wall x=0, runs along y)
function shelf(s,orient,u,w,h,levels,locked=[],tagged=null){
 const m=(a,z)=>orient==='y'?s.p(a,7,z):s.p(7,a,z);
 if(orient==='y')s.box(u,0,0,w,7,h,WOOD,1.4);else s.box(0,u,0,7,w,h,WOOD,1.4);
 const lh=(h-6)/levels;const locks=[];
 for(let i=0;i<levels;i++){const z0=3+i*lh,ch=lh-3;
  s.poly([m(u+3,z0),m(u+w-3,z0),m(u+w-3,z0+ch),m(u+3,z0+ch)],'#8a5a2e',1);
  if(locked.includes(i)){
   s.poly([m(u+2.5,z0-1),m(u+w-2.5,z0-1),m(u+w-2.5,z0+ch+1),m(u+2.5,z0+ch+1)],'#e8c887',1.3);
   DT.lockRivets(s,m,u,w,z0,ch);const c=m(u+w/2,z0+ch/2);lock(s,c[0],c[1]-1,1.25);locks.push(c);
  }else{DT.shelfBooks(s,m,u,w,z0,ch,rnd,BOOKS)}
 }
 return locks}
function pinCard(s,u,z,w,h,fill,lines=3){
 s.qY(u,0,z,w,h,fill,1);
 for(let i=0;i<lines;i++)s.line(s.p(u+2,0,z+h-5-i*3.6),s.p(u+w-2-(i==lines-1?w*.3:0),0,z+h-5-i*3.6),INK,.8,.5);
 const q=s.p(u+w/2,0,z+h-1.5);s.o.push(`<circle cx="${f(q[0])}" cy="${f(q[1])}" r="2.3" fill="${TERRA}" stroke="${INK}" stroke-width=".9"/>`)}
function island(s,rug,deskX,kind){
 const W=96,D=96,H=60;room(s,W,D,H);
 DT.roomWalls(s,kind,deskX);
 s.qZ(24,34,52,46,0,rug,1.1);s.qZ(28,38,44,38,0,'none',.9);
 DT.roomFloor(s,kind,deskX);
 desk(s,deskX,3,46,22,14);
 laptop(s,deskX+6,8,16.4,1.3);folder(s,deskX+33,10,16.4,1.2);
 DT.roomDesk(s,kind,deskX);
 DT.roomSeat(s,kind,deskX);
 plant(s,8,86,0,.55);
}
const out={};const SHADOW='#5a3d28';
// ---------- vignette 1
{const s=new S(0,0,1.15);const rooms=[[185,92,'#c8cba3',18],[505,138,'#e8b25a',40],[255,310,'#e6a574',10]];
 const subs=[];
 rooms.forEach(([ox,oy,rug,dx],i)=>{const r=new S(ox,oy,1.15);island(r,rug,dx,i);subs.push(r)});
 s.o=subs.map(r=>r.o.join(''));
 const A=subs[0],B=subs[1],C=subs[2];
 DT.v1Links(s,A,B,C,tagL,S);
 s.o.push(tagL(30,16,'Claude · Windows',...A.p(deskX=0,0,0).map(()=>0)).slice(0,0));
 const la=A.p(18+6+9,14,24),lb=B.p(40+6+9,14,24);
 s.o.push(tagL(20,22,'Claude · Windows',la[0],la[1]));
 s.o.push(tagL(470,40,'Codex · Linux',lb[0],lb[1]));
 const lc=C.p(10+6+9,14,24);
 s.o.push(tagL(40,444,'ChatGPT · macOS',lc[0],lc[1]));
 out.v1=`<svg viewBox="0 0 700 500" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="Three separate rooms joined by a path">${s.o.join('')}</svg>`;
}
// ---------- vignette 2
{const s=new S(300,200,1.5);const W=230,D=190,H=110;room(s,W,D,H);DT.baseboards(s,W,D);
 const l1=shelf(s,'y',14,76,94,4,[1]);
 const l2=shelf(s,'y',100,76,94,4,[2]);
 shelf(s,'x',24,96,94,4,[]);
 // window
 s.qY(188,0,40,32,50,'#f1dfb5',1.3);s.qY(191,0,43,26,44,'#a9d2de',1);s.line(s.p(204,0,43),s.p(204,0,87),INK,1.4);s.line(s.p(191,0,65),s.p(217,0,65),INK,1.4);DT.curtains(s,188,48,40,36,'#e5805c');
 // rug
 s.qZ(70,70,120,96,0,'#c8cba3',1.2);s.qZ(76,76,108,84,0,'none',1);s.qZ(80,80,100,76,0,'#b9c796',.9);DT.dashRect(s,86,86,88,64,0,'#fff1c8',1.4);DT.shade(s,[s.p(92,100,0),s.p(172,100,0),s.p(180,142,0),s.p(100,142,0)],.13);
 desk(s,96,96,70,34,22);
 // ledger
 const z=24.4;
 s.box(104,101,z,24,22,1.6,['#fff8e4','#e3d3a8','#b8a984'],1.1);s.box(128,101,z,24,22,1.6,['#fff8e4','#e3d3a8','#b8a984'],1.1);
 for(let i=0;i<5;i++){const y=106+i*3.6;s.line(s.p(107,y,z+1.6),s.p(125,y,z+1.6),INK,.8,.5);s.line(s.p(131,y,z+1.6),s.p(149,y,z+1.6),INK,.8,.5)}
 s.line(s.p(128,101,z+1.6),s.p(128,123,z+1.6),INK,1.2);
 s.qZ(147,100,2,28,z+1.7,TERRA,.8);
 laptop(s,153,108,z-1.6+0,1.1);DT.lamp(s,160,101,z);DT.mug(s,166,126,z);
 chair(s,100,0,0);
 s.o.splice(s.o.length-1,0);
 const pr=DT.personFigure(s,172,134,0,1.1);
 plant(s,212,30,0,.9);
 const lk1=l1[0],lk2=l2[0];
 s.o.push(tagL(30,372?0:0,'locked',0,0).slice(0,0));
 s.o.push(tagL(12,28,'locked',lk1[0],lk1[1]));
 s.o.push(tagL(560,40,'locked',lk2[0],lk2[1]));
 const lg=s.p(116,112,z+2);
 s.o.push(tagL(10,430,'every change on record',lg[0],lg[1]));
 s.o.push(tagL(560,440,'you',pr[0],pr[1]+6,{col:TERRA}));
 out.v2=`<svg viewBox="0 0 700 540" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="Archive room with shelves, two locked">${s.o.join('')}</svg>`;
 out.bb2=s.bb;
}
// ---------- vignette 3
{const s=new S(300,200,1.5);const W=240,D=200,H=112;room(s,W,D,H);DT.baseboards(s,W,D);
 // notice board
 s.qY(74,0,44,132,56,'#a8743c',1.5);s.qY(77,0,47,126,50,'#e8cc94',1);
 pinCard(s,82,70,24,24,'#fbf2da');pinCard(s,112,66,22,28,'#f1dfb5',4);pinCard(s,140,72,20,22,'#cfe0b8');pinCard(s,166,64,28,30,'#fbf2da',4);
 pinCard(s,82,50,22,16,'#f7d5b8',2);pinCard(s,150,50,26,17,'#fbf2da',2);
 const cr=s.p(123,0,92),cg=s.p(180,0,96);
 DT.sticky(s,108,0,52,11,11,'#fff1b4');DT.sticky(s,122,0,53,10,10,'#f4b7a9');DT.sticky(s,176,0,50,12,11,'#bcd9e6');DT.sticky(s,190,0,52,9,9,'#fff1b4');
 // balcony
 s.box(36,6,0,4,4,38,WOOD,1);s.box(36,95,0,4,4,38,WOOD,1);s.box(36,186,0,4,4,38,WOOD,1);
 s.box(0,0,38,46,D,4,['#e8c887','#a8743c','#c58d4a'],1.5);
 // table etc.
 s.qZ(70,60,150,110,0,'#c8cba3',1.2);s.qZ(76,66,138,98,0,'none',1);DT.dashRect(s,82,72,126,86,0,'#fff1c8',1.4);DT.shade(s,[s.p(116,76,0),s.p(190,76,0),s.p(206,150,0),s.p(126,164,0)],.13);
 DT.stool(s,100,104,7);DT.animal(s,'tanuki','front',100,104,DT.SEAT,.85,8);
 s.cyl(150,110,0,36,16,['#e5b46d','#b9803e'],1.5);s.ell(150,110,16,31,'none',1.4,'#f3cf97');
 DT.laptopSide(s,116,96,16,false);laptop(s,123,122,16,1,'#a8ded4');DT.laptopSide(s,166,100,16,true);
 DT.stool(s,132,152,7);DT.animal(s,'raccoon','back',132,152,DT.SEAT,.85,-6);
 DT.stool(s,198,104,7);DT.animal(s,'fox','front',198,104,DT.SEAT,.85,-10);
 // flag beside the coordinator
 const fp=s.p(207,90,DT.SEAT+1);s.line(fp,[fp[0],fp[1]-42],INK,1.6);
 s.o.push(`<polygon points="${f(fp[0])},${f(fp[1]-42)} ${f(fp[0]+24)},${f(fp[1]-34)} ${f(fp[0])},${f(fp[1]-26)}" fill="#e0a93a" stroke="${INK}" stroke-width="1.2"/>`);
 s.o.push(DT.ell(fp[0],fp[1]+.5,3,2.4,'#7b4a2a',1.1));
 // armchair on balcony (back to wall, faces +x)
 DT.tv(s,8,34,49);
 DT.shade(s,[s.p(2,78,42),s.p(38,78,42),s.p(40,116,42),s.p(4,116,42)],.12);
 const ax=4,ay=80,az=42,m=1.6,C=['#e5805c','#c4583c','#a8452f'];
 s.box(ax,ay,az,4*m,18*m,22*m,C,1.3);
 s.box(ax+4*m,ay,az+5*m,14*m,3*m,11*m,C,1.3);
 s.box(ax+4*m,ay+3*m,az,14*m,12*m,8*m,C,1.3);
 DT.catAwake(s,ax+11*m,ay+9*m,az+8*m,.82);
 s.box(ax+4*m,ay+15*m,az+5*m,14*m,3*m,11*m,C,1.3);
 s.box(ax+19*m,ay+4*m,az-3,5*m,10*m,3,['#efbd55','#b4822c','#b4822c'],1.2);
 // railing
 for(let y=6;y<=D-6;y+=32)s.box(43,y,42,1.8,1.8,14,WOOD,.9);
 s.box(42.5,0,55,2.6,D,2.4,WOOD,1.1);
 plant(s,212,28,0,.9);
 const you=s.p(16,91,64);
 s.o.push(tagL(20,16,'you',you[0],you[1],{col:TERRA}));
 s.o.push(tagL(30,50?0:0,'rules',0,0).slice(0,0));
 s.o.push(tagL(262,22,'rules',...(()=>{const q=s.p(93,0,92);return [q[0],q[1]]})()));
 s.o.push(tagL(560,100,'goals',...(()=>{const q=s.p(180,0,92);return [q[0],q[1]]})()));
 const fxp=s.p(198,104,DT.SEAT);s.o.push(tagL(540,420,'Coordinator',fxp[0],fxp[1]-12));
 out.v3=`<svg viewBox="0 0 700 560" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="Balcony overlooking a team room">${s.o.join('')}</svg>`;
 out.bb3=s.bb;
}
// ---------- closing illustrations
function slab(s){s.box(0,0,0,64,64,6,['#e3b878','#a87238','#8c5c2c'],1.5);DT.plankSlab(s)}
{const s=new S(150,30,2);slab(s);const z=6;
 s.ell(16,32,z,12,'#e0a93a',1.4);s.ell(16,32,z,5,'#e3b878',1.2);
 s.qZ(26,30,32,4,z,'#e0a93a',1.3);s.qZ(46,34,4,6,z,'#e0a93a',1.2);s.qZ(53,34,4,4.5,z,'#e0a93a',1.2);
 DT.shade(s,[s.p(30,34,z),s.p(60,34,z),s.p(60,40,z),s.p(30,40,z)],.16);s.line(s.p(28,31.2,z+0.01),s.p(56,31.2,z+0.01),'#fff1c8',1.1,.8);s.line(s.p(46,30,z),s.p(46,34,z),INK,.8,.5);s.line(s.p(53,30,z),s.p(53,34,z),INK,.8,.5);
 for(let i=0;i<6;i++){const t=i/6*Math.PI*2;s.line(s.p(16+10*Math.cos(t),32+10*Math.sin(t),z),s.p(16+12*Math.cos(t),32+12*Math.sin(t),z),'#c58d4a',1.1,.8)}
 s.ell(16,32,z,2.2,SHADOW,.8);DT.star(s,8,14,z+10,5);DT.star(s,56,14,z+14,3.4);DT.star(s,52,50,z+8,3);
 out.key=s.svg(300,200,'A key')}
{const s=new S(150,30,2);slab(s);const z=6;
 s.box(18,40,z,32,3,3,['#a8743c','#a8743c','#8a5a2e'],1);
 s.qY(10,38,z+1,48,34,'#fbf2da',1.4);
 s.line(s.p(14,38,z+31),s.p(24,38,z+31),'none');
 for(let i=0;i<4;i++)s.line(s.p(26,38,z+25-i*5),s.p(52-(i==3?14:0),38,z+25-i*5),INK,1.1,.55);
 // chevron + cursor
 s.line(s.p(15,38,z+27),s.p(19,38,z+24.5),TERRA,2);s.line(s.p(19,38,z+24.5),s.p(15,38,z+22),TERRA,2);
 s.qY(15,38,z+6,5,3,TERRA,.8);
 [8,12,16].forEach((u,i)=>{const q=s.p(10+u-4+2,38,z+32.2);s.o.push(DT.circ(q[0],q[1],1.2,[TERRA,'#e0a93a','#5f9a6a'][i],.5,'none'))});
 s.line(s.p(10,38,z+30),s.p(58,38,z+30),INK,.8,.5);s.qY(40,38,z+4.6,6,3.4,'#5b9ec9',.6);s.qY(48,38,z+4.6,6,3.4,'#e0a93a',.6);s.line(s.p(26,38,z+25-5*4),s.p(36,38,z+25-5*4),'#5f9a6a',1.4,.9);
 DT.shade(s,[s.p(10,41,z),s.p(58,41,z),s.p(60,46,z),s.p(12,46,z)],.15);
 out.card=s.svg(300,200,'A prompt card')}
{const s=new S(150,30,2);slab(s);const z=6;
 s.qZ(8,10,46,44,z,'#fbf2da',1.4);
 for(let i=0;i<3;i++)s.line(s.p(13,16+i*5,z),s.p(40-(i==2?10:0),16+i*5,z),INK,1,.5);
 s.poly([s.p(13,35,z),s.p(51,35,z),s.p(51,47,z),s.p(13,47,z)],'none',2,TERRA);
 s.textZ(z,17.2,43,'accepted',6.3,TERRA,700);
 // stamp tool, clear of the mark
 s.cyl(47,19,z+14,6,3,['#d9944f','#a8743c'],1.3);
 s.cyl(47,19,z+17,2.6,12,['#8fb577','#5a7d4b'],1.3);
 s.ell(47,19,z+29,4.4,'#8fb577',1.3);
 DT.shade(s,[s.p(42,21,z),s.p(52,21,z),s.p(53,26,z),s.p(43,27,z)],.2);
 [[16,32],[25,33],[36,32.4],[45,32.8],[50,31]].forEach(([x,y])=>{const q=s.p(x,y,z);s.o.push(DT.circ(q[0],q[1],.7,TERRA,.3,'none'))});
 s.line(s.p(44,19,z+14),s.p(50,19,z+14),'#c8ad78',1,.7);
 out.stamp=s.svg(300,200,'An accepted stamp')}
// ---------- hero pieces
const navHtml=hero.slice(hero.indexOf('<nav>'),hero.indexOf('</nav>')+6);
const logoSvg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254"><rect width="1254" height="1254" rx="256" fill="#3d2b1f"/><path fill="#c4503a" d="M143 290H698L910 502V691L577 928V724Z"/><path fill="#fbf2da" d="M910 691H1114L785 1008L458 1010Z"/></svg>`;
const nav2=navHtml.replace('Supervision</span>','Supervision</span><a class="i" href="architecture.html">Architecture</a>').replace(/<svg viewBox="0 0 24 24".*?<\/svg>/,logoSvg.replace('<svg ','<svg class="lg" ')).replace(/<span class="i">(Agents|Vault|Supervision)<\/span>/g,(m,t)=>'<a class="i s" href="#'+t.toLowerCase()+'">'+t+'</a>');
let heroSec=hero.slice(hero.indexOf('<section class="hero">'),hero.indexOf('</section>')+10);
['fill="#5b9ec9" stroke="#3d2b1f" stroke-width="1.3"','fill="#c97b8a" stroke="#3d2b1f" stroke-width="1.3"','fill="#5f9a6a" stroke="#3d2b1f" stroke-width="1.3"'].forEach(a=>{heroSec=heroSec.split(a).join('fill="#a8ded4" stroke="#3d2b1f" stroke-width="1.3"')});
heroSec=heroSec.split('fill="#3f9c98"').join('fill="#a8ded4"');
// armchair chunk
const c0=hero.indexOf('<polygon points="162.3,471.3'),c1=hero.indexOf('</g><g><line x1="411" y1="51"');
const chairSvg=`<svg viewBox="100 436 290 200" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="Armchair with footstool and a sleeping cat"><ellipse cx="202.5" cy="524" rx="94.9" ry="54.8" fill="#e8b25a" stroke="#3d2b1f" stroke-width="1.5"/><ellipse cx="202.5" cy="524" rx="79.7" ry="46" fill="none" stroke="#c4503a" stroke-width="1.4"/>${hero.slice(c0,c1)}</svg>`;
const fav='data:image/svg+xml,'+encodeURIComponent(logoSvg);
const {OWNER,REPO}=require('./repo.js');const GH='https://github.com/'+OWNER+'/'+REPO;
const U={docs:GH+'/tree/main/docs',gh:GH,start:GH+'/blob/main/docs/getting-started.md'};
heroSec=heroSec.replace(/<div class="eyebrow">[^<]*<\/div>/,''); // DROP_EYEBROW
heroSec=heroSec.replace('href="#"','href="'+U.start+'"');
const css=`
@font-face{font-family:Geist;src:url(fonts/geist.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"Geist Mono";src:url(fonts/geist-mono.woff2) format("woff2");font-weight:100 900}
:root{--bg:#f3e8d0;--ink:#3d2b1f;--acc:#c4503a;--mut:#7a6246;--moss:#4f6b3c;--body:#5a4431}
*{box-sizing:border-box;margin:0}
body{width:100%;max-width:1440px;margin:0 auto;position:relative;background:var(--bg);color:var(--ink);font:16px/1.5 Geist,system-ui,sans-serif}
.pg{padding:0 60px;position:relative}
nav{height:56px;border-bottom:1.5px solid var(--ink);display:flex;align-items:center;justify-content:space-between;font:500 12px "Geist Mono";letter-spacing:.1em;text-transform:uppercase}
nav .b{font-weight:600;font-size:14px;display:flex;align-items:center;gap:10px}
nav .b svg{width:26px;height:26px}
nav span.i,nav a.i{margin-left:34px;color:inherit;text-decoration:none}
.hero{display:grid;grid-template-columns:480px 1fr;gap:20px;padding-top:20px}
.copy{padding-top:50px}
.eyebrow{font:500 12px "Geist Mono";letter-spacing:.12em;color:var(--moss);margin-bottom:16px;display:flex;align-items:center;gap:10px}
.eyebrow:before{content:"";width:30px;border-top:1.5px solid var(--moss)}
h1{font:300 42px/1.1 Geist;letter-spacing:-.035em}
h1 s{font-weight:600;text-decoration-color:var(--acc);text-decoration-thickness:2px;text-decoration-skip-ink:none}
.nw{white-space:nowrap}
.p{font-size:15.5px;margin-top:16px;line-height:1.5}
.p+.p{margin-top:8px;color:#5a4431}
.cta{margin-top:26px;display:flex;align-items:center;gap:18px}
.btn{background:var(--ink);color:#fbf2da;font:500 15px Geist;padding:13px 22px;text-decoration:none;border:1px solid var(--ink);border-radius:2px;white-space:nowrap;display:inline-block}
.cta .t b{display:block;font:600 16.5px Geist}
.cta .t span{font:12px "Geist Mono";color:var(--mut)}
.art{width:800px;height:744px;display:block}
.ch{display:grid;grid-template-columns:790px 1fr;gap:56px;align-items:center;margin-top:140px}
.ch.r{grid-template-columns:1fr 790px}.ch.r .vig{order:2}
.vig svg{width:790px;height:auto;display:block}
.num{font:500 13px "Geist Mono";letter-spacing:.12em;color:var(--moss);display:flex;align-items:center;gap:10px}
.num:before{content:"";width:30px;border-top:1.5px solid var(--moss)}
h2{font:600 40px/1.12 Geist;letter-spacing:-.03em;margin-top:16px}
.ch p{font-size:18px;line-height:1.55;margin-top:18px;color:var(--body);max-width:470px}
.fig{margin-top:34px}
.fig img{display:block;width:100%;height:auto;border:1px solid var(--ink);background:#fff}
.fig figcaption{font:500 12px "Geist Mono";color:var(--mut);margin-top:10px;letter-spacing:.06em}
.duo{position:relative;margin-bottom:56px}
.duo img.b{position:absolute;width:58%;right:-14px;bottom:-56px;border:1px solid var(--ink)}
.close{margin-top:150px;border-top:1.5px solid var(--ink);padding-top:70px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:40px}
.step{text-align:center}.step svg{width:300px;height:auto;display:inline-block}
.step .n{font:500 13px "Geist Mono";letter-spacing:.12em;color:var(--moss);margin-top:6px}
.step h3{font:600 34px/1.1 Geist;letter-spacing:-.03em;margin-top:6px}
.row2{display:flex;justify-content:center;gap:70px;align-items:center;margin-top:90px}
.more{text-align:center;margin-top:34px;font:500 12px "Geist Mono";letter-spacing:.1em}.more a{color:var(--mut);text-decoration:none}
.row2 .chair svg{width:340px;height:auto;display:block}
.row2 h3{font:600 40px/1.12 Geist;letter-spacing:-.03em}
.go{display:flex;align-items:center;gap:26px;margin-top:30px}
.go a.l{font:600 16px Geist;color:var(--ink);text-decoration:underline;text-underline-offset:5px;text-decoration-thickness:1.5px}
.row2 .fig{margin-top:0}
footer{margin-top:130px;border-top:1.5px solid var(--ink);height:84px;display:flex;align-items:center;justify-content:space-between;font:500 12px "Geist Mono";letter-spacing:.1em;text-transform:uppercase}
footer .b{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px}
footer .b svg{width:18px;height:18px}
footer a{color:var(--ink);text-decoration:none;margin-left:34px}

@media (max-width:1439px){
.hero{grid-template-columns:minmax(0,480px) minmax(0,1fr)}
.art{width:100%;height:auto;min-width:0}
.ch{grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:40px}
.ch.r{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}
.vig svg{width:100%}
.row2{gap:40px}
}
@media (max-width:1000px){
.pg{padding:0 32px}
.hero{grid-template-columns:minmax(0,1fr);gap:0}
.copy{padding-top:36px}
.art{width:100%;max-width:720px;margin:12px auto 0}
.ch,.ch.r{grid-template-columns:minmax(0,1fr);gap:28px;margin-top:90px}
.ch>.vig,.ch.r>.vig{order:2;max-width:720px;margin:0 auto;width:100%}
.ch p{max-width:560px}
.steps{gap:20px}.step svg{width:100%;max-width:240px}.step h3{font-size:28px}
.row2{margin-top:64px;gap:32px}
.close{margin-top:100px;padding-top:56px}
footer{margin-top:90px}
}
@media (max-width:760px){
.pg{padding:0 16px}
nav span.i,nav a.s{display:none}
nav a.i{margin-left:0}
.copy{padding-top:28px}
.eyebrow{font-size:11px;margin-bottom:14px}
h1{font-size:33px;line-height:1.12}
.p{font-size:16px;margin-top:14px}
.cta{flex-wrap:wrap;gap:16px;margin-top:24px}
.cta .t b{font-size:16px}.cta .t span{font-size:12px}
.art{width:calc(100% + 32px);max-width:none;margin:36px -16px -36px}
.art .tg{transform-box:fill-box;transform-origin:center;transform:scale(1.6)}
.tg.tl{transform-origin:left center!important}.tg.tr{transform-origin:right center!important}
.vig .tg{transform-box:fill-box;transform-origin:center;transform:scale(1.45)}
.ch,.ch.r{margin-top:72px;gap:22px}
.ch>.vig,.ch.r>.vig{width:calc(100% + 32px);max-width:none;margin:0 -16px}
.num{font-size:13px}
h2{font-size:28px;margin-top:12px}
.ch p{font-size:17px;max-width:none;margin-top:14px}
.close{margin-top:80px;padding-top:44px}
.steps{grid-template-columns:minmax(0,1fr);gap:30px}
.step svg{max-width:300px;margin:-22px auto -30px}
.step text{font-size:9px}
.step h3{font-size:30px}
.row2{flex-direction:column;margin-top:56px;gap:24px;text-align:center}
.row2 .chair svg{width:300px;margin:-10px auto -34px}
.row2 h3{font-size:30px}
.go{justify-content:center;gap:22px;margin-top:22px}
.more{margin-top:40px;font-size:12px}
footer{margin-top:64px;height:auto;padding:22px 0;gap:12px}
footer a{margin-left:20px}
}
`;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conclave — AI agents that work as one team</title><meta name="description" content="With Conclave, your agents find each other, split the work, review it, and file the results in your Obsidian vault. Across machines, across networks, without you."><meta property="og:type" content="website"><meta property="og:title" content="Conclave — AI agents that work as one team"><meta property="og:description" content="With Conclave, your agents find each other, split the work, review it, and file the results in your Obsidian vault. Across machines, across networks, without you."><meta name="theme-color" content="#f3e8d0"><link rel="icon" href="${fav}"><style>${css}/* SOFT_INK */svg [stroke="#3d2b1f"]{stroke:#8b6a4c}svg [stroke-width="1.3"],svg [stroke-width="1.5"]{stroke-width:1.1}/* UI_C */svg rect[fill="#5a3d28"][fill-opacity=".2"][height="26"]{display:none}svg rect[fill="#fbf2da"][stroke="#3d2b1f"][height="26"],svg rect[fill="#f7e4b0"][stroke="#3d2b1f"][height="26"]{rx:13px;fill:rgba(251,242,218,.94);stroke:#8b6a4c;stroke-width:1}svg rect[fill="#fbf2da"][stroke="#3d2b1f"][height="26"]~text,svg rect[fill="#f7e4b0"][stroke="#3d2b1f"][height="26"]~text{font-weight:500;font-size:12px;fill:#5a4431}nav{font:500 12px "Geist Mono";letter-spacing:.04em;text-transform:lowercase;border-bottom:1px solid rgba(61,43,31,.18)}nav .b{text-transform:none;font:600 15px Geist;letter-spacing:-.01em}nav>div:last-child{display:flex;align-items:center;border:1px solid rgba(61,43,31,.35);border-radius:999px;padding:3px}nav a.i{opacity:1;border-radius:999px;padding:6px 14px;margin-left:0}nav a.i:hover{background:rgba(61,43,31,.07)}nav a.on,nav a.on:hover{background:#3d2b1f;color:#fbf2da;border-bottom:0}.btn{border-radius:999px;background:#c4503a;border-color:#c4503a}.go a.l{text-decoration:none;border:1px solid var(--ink);border-radius:999px;padding:11px 20px;font-weight:500}.chip{border-radius:999px;border-width:1px;box-shadow:none;font-weight:500}</style></head><body><div class="pg">
${nav2}
${heroSec}
<section class="ch" id="agents"><div class="vig">${out.v1}</div><div><div class="num">01</div><h2>Agents that collaborate from anywhere</h2><p>Claude here, Codex there, on any network or operating system. Each works on its own files, and they exchange data as if they sat side by side.</p></div></section>
<section class="ch r" id="vault"><div class="vig">${out.v2}</div><div><div class="num">02</div><h2>A sharing layer on top of Obsidian</h2><p>Share your vault with your team and their agents. You set who sees each page, and every change is on record.</p></div></section>
<section class="ch" id="supervision"><div class="vig">${out.v3}</div><div><div class="num">03</div><h2>Agent supervision</h2><p>See what your agents are doing, will do and have done, and the rules and goals behind it. Then hand the lead to a coordinator agent and its team.</p></div></section>
<section class="close">
<div class="steps"><div class="step">${out.key}<div class="n">01</div><h3>1 key.</h3></div><div class="step">${out.card}<div class="n">02</div><h3>1 prompt.</h3></div><div class="step">${out.stamp}<div class="n">03</div><h3>1 accept.</h3></div></div>
<div class="row2"><div class="chair">${chairSvg}</div><div><h3>Your agents work. You don't.</h3><div class="go"><a class="btn" href="${U.start}">Get started</a><a class="l" href="${U.gh}">GitHub</a></div></div></div>
<div class="more"><a href="architecture.html">Tools and architecture →</a></div>
</section>
<footer><div class="b">${logoSvg.replace('<svg ','<svg class="lg" ')}Conclave</div><div><a href="${U.docs}">Docs</a><a href="${U.gh}">GitHub</a></div></footer>
</div></body></html>`;
const TG=/(<g transform="translate\([^)]*\) rotate\([^)]*\)">)(<rect[\s\S]*?<\/text>)<\/g>/g;
const html2=html.replace(TG,(m,g,inner,off)=>{const t=/translate\(([\d.-]+) ([\d.-]+)\)/.exec(g),x=+t[1],w=+(/<rect width="(\d+)"/.exec(inner)||[0,100])[1];const sv=html.lastIndexOf('<svg ',off),vb=/viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/.exec(html.slice(sv,sv+300)),W=+vb[1];const c=x<28?' tl':(x+w>W-28?' tr':'');return g+'<g class="tg'+c+'">'+inner+'</g></g>'});
fs.writeFileSync(OUT+'/index.html',html2);
console.log(html.length,out.bb2,out.bb3);
