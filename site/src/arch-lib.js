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
 ell(cx,cy,z,r,fill,sw=1.3,stroke=INK){const q=this.p(cx,cy,z);this.bb=[Math.min(this.bb[0],q[0]-r*1.2247*this.k),Math.min(this.bb[1],q[1]-r*.7071*this.k),Math.max(this.bb[2],q[0]+r*1.2247*this.k),Math.max(this.bb[3],q[1]+r*.7071*this.k)];this.o.push(`<ellipse cx="${f(q[0])}" cy="${f(q[1])}" rx="${f(r*1.2247*this.k)}" ry="${f(r*0.7071*this.k)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`)}
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
 ls.forEach(([r,l,c])=>{o+=`<path transform="translate(0 -25) rotate(${r})" d="M0 0C12 ${-l*.3} 8.4 ${-l*.8} 0 ${-l}C-8.4 ${-l*.8} -12 ${-l*.3} 0 0Z" fill="${c}" stroke="${INK}" stroke-width="1.1"/>`});
 s.o.push(o+'</g>')}
// wall unit: orient 'y' (wall y=0, runs along x) or 'x' (wall x=0, runs along y)
// ---------- richer-detail helpers: animal agents, shadows, props ----------
const ST='stroke="#3d2b1f" stroke-width="1.1"';
function animalSvg(kind){
 const c=(cx,cy,r,fill,x='')=>`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${x||ST}/>`;
 const ink=(cx,cy,r)=>`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#3d2b1f"/>`;
 const P=(d,fill,x='')=>`<path d="${d}" fill="${fill}" ${x||ST}/>`;
 const NS='stroke="none"';
 const feet=col=>`<ellipse cx="-4" cy="-.4" rx="3.2" ry="1.7" fill="${col}" ${ST}/><ellipse cx="4" cy="-.4" rx="3.2" ry="1.7" fill="${col}" ${ST}/>`;
 const body=(fill,w=8)=>P(`M${-w} 0C${-w} -13 -5 -17 0 -17C5 -17 ${w} -13 ${w} 0Z`,fill);
 let o=`<ellipse cx="0" cy="1" rx="11" ry="4.5" fill="#5a3d28" fill-opacity=".2"/>`;
 if(kind==='fox'){
  o+=P('M5 -3C21 -4 22 -22 13 -27C15 -17 9 -12 4 -10Z','#d9783c')+P('M18 -17C21 -19 20 -23 17 -25C16 -21 17 -19 18 -17Z','#fbf2da',NS);
  o+=feet('#8c4a28')+body('#d9783c')+P('M-3.6 0C-3.6 -8 -2 -13 0 -13C2 -13 3.6 -8 3.6 0Z','#fbf2da',NS);
  o+=P('M-5.2 -28L-7 -36L-1.2 -29.6Z','#d9783c')+P('M5.2 -28L7 -36L1.2 -29.6Z','#d9783c')+P('M-4.6 -29L-5.6 -33L-2.6 -29.8Z','#3d2b1f',NS)+P('M4.6 -29L5.6 -33L2.6 -29.8Z','#3d2b1f',NS);
  o+=c(0,-24,6.5,'#d9783c')+P('M-6.4 -23.5Q0 -16.6 6.4 -23.5Q4 -19 0 -18.4Q-4 -19 -6.4 -23.5Z','#fbf2da',NS)+ink(-2.6,-24.8,.95)+ink(2.6,-24.8,.95)+ink(0,-21.4,1.1);
  o+=P('M-6.6 -17.6Q0 -14.6 6.6 -17.6L6.9 -14.4Q0 -11.6 -6.9 -14.4Z','#5b9ec9')+P('M2.2 -13.6L5.8 -14.2L6.6 -6.6L3 -6.2Z','#5b9ec9')+`<line x1="3.6" y1="-11" x2="5.9" y2="-11.4" stroke="#fbf2da" stroke-width=".9"/>`;
 }else if(kind==='owl'){
  o+=feet('#e0a93a')+P('M-8.6 0C-9.4 -12 -6.5 -18.4 0 -18.4C6.5 -18.4 9.4 -12 8.6 0Z','#a8743c')+P('M-4.2 0C-5 -7 -3 -13 0 -13C3 -13 5 -7 4.2 0Z','#f1dfb5',NS);
  for(let i=0;i<3;i++)for(let j=0;j<=i;j++)o+=`<path d="M${(-2.6*i+j*5.2-1.5).toFixed(1)} ${-3-i*3.2}q1.5 1.6 3 0" fill="none" stroke="#a8743c" stroke-width=".8"/>`;
  o+=P('M-8.6 -3C-12 -7 -11 -13 -8 -15C-7.4 -10 -7.8 -6 -8.2 -2Z','#8c5c2c')+P('M8.6 -3C12 -7 11 -13 8 -15C7.4 -10 7.8 -6 8.2 -2Z','#8c5c2c');
  o+=P('M-6.4 -28L-7.6 -34.4L-2.2 -29.8Z','#8c5c2c')+P('M6.4 -28L7.6 -34.4L2.2 -29.8Z','#8c5c2c')+c(0,-24,7.2,'#a8743c');
  o+=c(-3.3,-24.4,3.3,'#fbf2da',NS)+c(3.3,-24.4,3.3,'#fbf2da',NS)+ink(-3.3,-24.4,1.2)+ink(3.3,-24.4,1.2)+P('M-1.3 -22.2L1.3 -22.2L0 -19.8Z','#e0a93a');
  o+=`<circle cx="-3.3" cy="-24.4" r="3.9" fill="none" stroke="#3d2b1f" stroke-width="1.1"/><circle cx="3.3" cy="-24.4" r="3.9" fill="none" stroke="#3d2b1f" stroke-width="1.1"/><path d="M-.5 -24.8Q0 -25.4 .5 -24.8M-7.2 -25L-9 -26.4M7.2 -25L9 -26.4" fill="none" stroke="#3d2b1f" stroke-width=".9"/>`;
 }else if(kind==='rabbit'){
  o+=c(-7,-3.5,2.4,'#f1e6d0')+feet('#e8dcc2')+body('#f1e6d0',7.6)+P('M-3.4 0C-3.4 -7 -2 -12 0 -12C2 -12 3.4 -7 3.4 0Z','#fffaf0',NS);
  o+=P('M-5.2 -28C-8.6 -35 -6.6 -43 -3.6 -42C-1.4 -40 -2.2 -33 -2.6 -28Z','#f1e6d0')+P('M5.2 -28C8.6 -35 6.6 -43 3.6 -42C1.4 -40 2.2 -33 2.6 -28Z','#f1e6d0')+P('M-4.6 -30C-6.2 -35 -5.4 -40 -4 -39.4C-3 -37 -3.4 -33 -3.4 -30Z','#e6a0a0',NS)+P('M4.6 -30C6.2 -35 5.4 -40 4 -39.4C3 -37 3.4 -33 3.4 -30Z','#e6a0a0',NS);
  o+=c(0,-24,6.2,'#f1e6d0')+ink(-2.4,-24.4,.95)+ink(2.4,-24.4,.95)+c(0,-21.8,1,'#e6a0a0',NS)+`<path d="M0 -20.8V-19.6M-1.4 -19Q0 -18.4 1.4 -19" fill="none" stroke="#3d2b1f" stroke-width=".7"/><circle cx="-4" cy="-21.6" r="1.1" fill="#e6a0a0" opacity=".6"/><circle cx="4" cy="-21.6" r="1.1" fill="#e6a0a0" opacity=".6"/>`;
  o+=`<path d="M-6.8 -23.5A6.8 6.8 0 0 1 6.8 -23.5" fill="none" stroke="#3d2b1f" stroke-width="1.7"/><rect x="-9.4" y="-26.4" width="3.4" height="6.4" rx="1.5" fill="#5b9ec9" ${ST}/><rect x="6" y="-26.4" width="3.4" height="6.4" rx="1.5" fill="#5b9ec9" ${ST}/>`;
 }else if(kind==='bear'){
  o+=feet('#7b4c25')+body('#9a6a3c',8.4)+P('M-4 0C-4.6 -7 -3 -12 0 -12C3 -12 4.6 -7 4 0Z','#d5a560',NS);
  o+=c(-5.6,-29.4,2.6,'#9a6a3c')+c(5.6,-29.4,2.6,'#9a6a3c')+c(-5.6,-29.4,1.2,'#d9a066',NS)+c(5.6,-29.4,1.2,'#d9a066',NS);
  o+=c(0,-24,6.6,'#9a6a3c')+`<ellipse cx="0" cy="-21.8" rx="3.4" ry="2.6" fill="#e6cf9c" ${ST}/>`+ink(-2.7,-25,.95)+ink(2.7,-25,.95)+`<ellipse cx="0" cy="-22.6" rx="1.3" ry=".9" fill="#3d2b1f"/><path d="M0 -21.7V-20.4M-1.3 -20.2Q0 -19.4 1.3 -20.2" fill="none" stroke="#3d2b1f" stroke-width=".7"/>`;
  o+=P('M0 -15.6L-5 -18L-5 -13.2Z','#c4503a')+P('M0 -15.6L5 -18L5 -13.2Z','#c4503a')+c(0,-15.6,1.5,'#a3402e');
 }else if(kind==='raccoon'){
  o+=P('M5 -3C20 -4 22 -17 15 -21C13 -14 10 -11 4 -10Z','#a39d93')+`<path d="M10 -9L13.4 -6.6M13.4 -13L17.4 -10.2M16 -18L19.4 -14.6" stroke="#4a372a" stroke-width="2.2" fill="none"/>`;
  o+=feet('#4a372a')+body('#a39d93')+P('M-3.4 0C-3.4 -7 -2 -12 0 -12C2 -12 3.4 -7 3.4 0Z','#d8d2c4',NS);
  o+=P('M-5.4 -28.2L-6.6 -34.4L-1.4 -29.6Z','#a39d93')+P('M5.4 -28.2L6.6 -34.4L1.4 -29.6Z','#a39d93')+c(0,-24,6.4,'#a39d93')+P('M-6.2 -23Q0 -17.4 6.2 -23Q4 -19 0 -18.6Q-4 -19 -6.2 -23Z','#e9e2d2',NS);
  o+=P('M-6.4 -26.4Q0 -28.8 6.4 -26.4L5.6 -22.2Q3 -23.8 0 -23.2Q-3 -23.8 -5.6 -22.2Z','#4a372a',NS)+c(-2.8,-24.6,1.1,'#fbf2da',NS)+c(2.8,-24.6,1.1,'#fbf2da',NS)+ink(-2.8,-24.6,.6)+ink(2.8,-24.6,.6)+ink(0,-20.6,1.1);
  o+=P('M-6.8 -28.2Q0 -32.6 6.8 -28.2L10 -26L-10 -26Z','#5f9a6a');
 }else if(kind==='tanuki'){
  o+=P('M5 -3C17 -3 18 -14 12 -16C11 -10 9 -8 4 -8Z','#8c6a49')+`<path d="M10 -7L13 -10M13.4 -10.6L15.6 -13" stroke="#4a372a" stroke-width="2" fill="none"/>`;
  o+=feet('#4a372a')+body('#8c6a49',9.2)+`<ellipse cx="0" cy="-7" rx="5.4" ry="7" fill="#e6cf9c"/>`;
  o+=c(-5.4,-29.2,2.4,'#8c6a49')+c(5.4,-29.2,2.4,'#8c6a49')+c(0,-24,6.6,'#8c6a49')+P('M-6.4 -23Q0 -16.6 6.4 -23Q4 -19 0 -18.4Q-4 -19 -6.4 -23Z','#e6cf9c',NS);
  o+=`<ellipse cx="-2.9" cy="-24.6" rx="2" ry="2.6" fill="#4a372a" transform="rotate(14 -2.9 -24.6)"/><ellipse cx="2.9" cy="-24.6" rx="2" ry="2.6" fill="#4a372a" transform="rotate(-14 2.9 -24.6)"/>`+c(-2.9,-25,.6,'#fbf2da',NS)+c(2.9,-25,.6,'#fbf2da',NS)+ink(0,-21.4,1.1);
  o+=P('M0 -30.4C-5 -33 -4 -39.4 0 -41C4 -39.4 5 -33 0 -30.4Z','#5f9a6a')+`<path d="M0 -30.6V-39.6M0 -34Q-2 -35 -3 -36M0 -34Q2 -35 3 -36" fill="none" stroke="#3d2b1f" stroke-width=".8"/>`;
 }
 return o}
function animal(s,x,y,z,sc,kind){const q=s.p(x,y,z),k=s.k*sc;
 s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(k)})">${animalSvg(kind)}</g>`)}
// flat shadow polygon on a horizontal plane (pts = [[x,y],...])
function shade(s,pts,z,op=.16){s.o.push(`<polygon points="${pts.map(q=>{const p=s.p(q[0],q[1],z);return f(p[0])+','+f(p[1])}).join(' ')}" fill="#5a3d28" fill-opacity="${op}"/>`)}
function shadeBox(s,x,y,w,d,z,op=.16){shade(s,[[x,y+d],[x+w,y+d],[x+w+3,y+d+3],[x+3,y+d+3]],z,op)}
function windowX(s,y,z,w,h,x=0){
 s.qX(x,y-2,z-2,w+4,h+4,'#f1dfb5',1.4);s.qX(x,y,z,w,h,'#a9d2de',1.1);
 s.poly([s.p(x,y,z),s.p(x,y+w,z),s.p(x,y+w,z+h*.34),s.p(x,y+w*.6,z+h*.28),s.p(x,y,z+h*.36)],'#8fb577',1);
 s.line(s.p(x,y+w/2,z),s.p(x,y+w/2,z+h),INK,1.4);s.line(s.p(x,y,z+h*.55),s.p(x,y+w,z+h*.55),INK,1.4);
 s.qX(x,y-3,z-3,w+6,1.4,'#e6cf9c',1.1)}
function mug(s,x,y,z,col='#fbf2da'){s.cyl(x,y,z,1.8,2.6,[col,'#e3d3a8','#c9b98c'],.9);s.ell(x,y,z+2.6,1.2,'#7b4c25',.5)}
function lamp(s,x,y,z,sc=1){const q=s.p(x,y,z);s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(s.k*sc/3)})"><ellipse cx="0" cy="0" rx="7" ry="3" fill="#a8743c" ${ST}/><path d="M0 0L-1 -17L9 -27" fill="none" ${ST} stroke-width="2"/><path d="M5 -27L16 -31L19 -22Z" fill="#e0a93a" ${ST}/><circle cx="-1" cy="-17" r="1.5" fill="#fbf2da" ${ST}/></g>`)}
function clockY(s,x,z,r,y=0){const c=s.p(x,y,z),R=r*s.k*.9;s.o.push(`<g transform="translate(${f(c[0])} ${f(c[1])})"><ellipse rx="${f(R*.8)}" ry="${f(R)}" fill="#fbf2da" ${ST}/><path d="M0 0V${f(-R*.65)}M0 0L${f(R*.4)} ${f(R*.2)}" stroke="#3d2b1f" stroke-width="1.2" fill="none"/></g>`)}
function tree(s,x,y,z,sc=1,col=['#6c9a58','#8fb577','#547c45']){const q=s.p(x,y,z);
 s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(sc)})"><ellipse cx="2" cy="2" rx="22" ry="7" fill="#3d5a2c" fill-opacity=".22"/><path d="M-3 0L-2.4 -22L2.4 -22L3 0Z" fill="#a8743c" ${ST}/><path d="M-1 -4L-1 -14" stroke="#8c5c2c" stroke-width=".8"/><circle cx="-9" cy="-30" r="12" fill="${col[0]}" ${ST}/><circle cx="9" cy="-31" r="11" fill="${col[0]}" ${ST}/><circle cx="0" cy="-40" r="13.5" fill="${col[1]}" ${ST}/><path d="M-6 -44q4 -5 9 -3M2 -34q4 -2 8 1M-12 -32q2 -3 6 -3" fill="none" stroke="${col[2]}" stroke-width="1.2"/><circle cx="-6" cy="-36" r="2" fill="#d9944f" ${ST}/><circle cx="8" cy="-42" r="2" fill="#c4503a" ${ST}/></g>`)}
function bush(s,x,y,z,sc=1,fl='#e0a93a'){const q=s.p(x,y,z);
 s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(sc)})"><ellipse cx="1" cy="1" rx="14" ry="4" fill="#3d5a2c" fill-opacity=".2"/><circle cx="-7" cy="-5" r="6.5" fill="#6c9a58" ${ST}/><circle cx="6" cy="-5" r="7" fill="#6c9a58" ${ST}/><circle cx="0" cy="-9" r="7" fill="#8fb577" ${ST}/><circle cx="-3" cy="-9" r="1.3" fill="${fl}"/><circle cx="4" cy="-6" r="1.3" fill="${fl}"/><circle cx="-8" cy="-4" r="1.2" fill="${fl}"/></g>`)}
function flowers(s,x,y,z,cols=['#c97b8a','#e0a93a','#fbf2da']){const q=s.p(x,y,z);let o=`<g transform="translate(${f(q[0])} ${f(q[1])})">`;
 cols.forEach((c,i)=>{const a=-8+i*8;o+=`<path d="M${a} 0V-6" stroke="#47663a" stroke-width="1.2" fill="none"/><circle cx="${a}" cy="-8" r="2.6" fill="${c}" ${ST}/><circle cx="${a}" cy="-8" r=".9" fill="#3d2b1f"/>`});s.o.push(o+'</g>')}
function bookStack(s,x,y,z,cols,w=9,d=7){cols.forEach((c,i)=>s.box(x+(i%2)*.6,y,z+i*1.5,w-(i%3)*1,d,1.5,['#fff8e4','#e3d3a8',c],.8))}
function rug(s,x,y,w,d,z,c1,c2){s.qZ(x,y,w,d,z,c1,1);s.qZ(x+2,y+2,w-4,d-4,z+.02,'none',.8);for(let i=0;i<3;i++)s.line(s.p(x+3,y+3+i*(d-6)/2,z+.05),s.p(x+w-3,y+3+i*(d-6)/2,z+.05),c2,.9,.7)}

module.exports={INK,TERRA,f,S,tag,tagL,room,desk,laptop,folder,chair,person,lock,plant,WOOD,BOOKS,rnd,animal,animalSvg,shade,shadeBox,windowX,mug,lamp,clockY,tree,bush,flowers,bookStack,rug,ST};
