const fs=require('fs');
const L=require('./arch-lib.js');
const {INK,TERRA,f,S,tag,tagL,desk,laptop,folder,chair,lock,plant,WOOD,BOOKS,animal,shade,shadeBox,windowX:windowX2,mug,lamp,clockY,tree,bush,flowers,bookStack,rug,ST}=L;
const oct=(cx,cy,r,o=0)=>Array.from({length:10},(_,i)=>[cx+o+Math.cos(i*Math.PI/5)*r,cy+o+Math.sin(i*Math.PI/5)*r]);
const DIR=require('path').join(__dirname,'..');
const CREAM='#fbefd0',CREAM2='#f8e5b4',SAND='#e3b878',HONEY='#e0a93a',SAGE='#c8cba3',MOSS='#5f9a6a',SKY='#a9d2de';
const WALLC=[CREAM,CREAM2,'#7b5a40'];
// ---------- tool inventory (from docs/mcp.md and server/src/mcp) ----------
const FAM=[
 {n:'Session',d:'Log in, see who you are, read notices.',t:'session_login session_help session_logout session_whoami session_describe session_ack'},
 {n:'PC setup',d:'Bootstrap the PC bridge and follow its progress.',t:'setup_pc setup_status'},
 {n:'Access requests',d:'Inspect policy or ask for temporary access.',t:'access_list access_request access_status access_check'},
 {n:'Messages and rooms',d:'Direct and room messages, groups, peers.',t:'agent_list message_send message_read message_ack message_history room_list room_create room_join room_leave room_invite'},
 {n:'Work queue',d:'Poll and acknowledge durable work.',t:'work_next work_ack'},
 {n:'Directives',d:'The operator\u2019s standing rules: list, read, confirm, report.',t:'directives_list directives_read directives_report'},
 {n:'Decisions',d:'Ask the operator for a decision, read the log.',t:'team_ask team_ask_update team_decisions'},
 {n:'Feedback',d:'Report problems with the hub, back existing reports.',t:'feedback_find feedback_file feedback_read feedback_add'},
 {n:'Tasks',d:'Create, assign, claim, execute and review.',t:'task_create task_update task_list task_assign task_claim task_start task_progress task_submit task_withdraw task_review task_complete task_block task_unblock task_cancel'},
 {n:'Teams',d:'Team progress, recruiting, completion.',t:'team_info team_complete team_recruit'},
 {n:'Checkout',d:'Move a team to another provider, OS user or PC.',t:'checkout_status checkout_progress checkout_handout checkout_resume'},
 {n:'Blueprint',d:'Read and change the project blueprint, report status.',t:'bp_read bp_write bp_proposals bp_report'},
 {n:'Files and vault',d:'Browse, change and version vault files.',t:'file_list file_read file_stat file_search file_download file_create file_update file_patch file_rename file_delete file_history file_diff file_restore file_conflicts'},
 {n:'Shares',d:'Versioned snapshots: feedback, promotion, distribution.',t:'share_create share_upload share_list share_info share_read share_diff share_comment share_suggest share_feedback share_resolve share_download share_promote share_close'},
 {n:'Data channels',d:'Offer and stream inline or bridge data.',t:'channel_open channel_list channel_accept channel_send channel_receive channel_status channel_close'},
 {n:'Knowledge graph',d:'Provenance, curator jobs, flags and review.',t:'graph_related graph_impact graph_query graph_context graph_summary graph_job_submit graph_upsert graph_summary_write graph_stale graph_flag graph_resolve graph_invalidate graph_link graph_decide graph_editor_optin graph_health'},
];
FAM.forEach(x=>{x.a=x.t.split(' ');x.s=x.shim?x.shim.split(' '):[];x.c=x.a.length+x.s.length});
const TOTAL=FAM.reduce((a,x)=>a+x.c,0);
const byName=n=>FAM.find(x=>x.n===n);
const COLS=[['Session','PC setup','Access requests','Messages and rooms','Work queue','Directives','Decisions','Feedback'],['Tasks','Teams','Checkout','Blueprint','Files and vault'],['Shares','Data channels','Knowledge graph']];

// ---------- extra drawing helpers ----------
function pers(s,x,y,z,sc=.95,col=TERRA,head='#e5805c'){const q=s.p(x,y,z),k=s.k*sc;
 s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(k)})"><ellipse cx="0" cy="1" rx="10" ry="4.5" fill="#5a3d28" fill-opacity=".2"/><path d="M-8 0C-8 -13 -5 -17 0 -17C5 -17 8 -13 8 0Z" fill="${col}" stroke="${INK}" stroke-width="1.3"/><circle cx="0" cy="-24" r="6.2" fill="${head}" stroke="${INK}" stroke-width="1.3"/></g>`)}
function sseg(s,a,b,col=INK,sw=1.2,extra=''){s.line(a,b,col,sw,1,'stroke-linecap="round" '+extra)}
function arch(s,x0,x1,y,z,h,col){ // gate arch in plane y
 s.box(x0-2.5,y-1.5,z,2.5,3,h,[col[0],col[1],col[2]],1.3);
 s.box(x1,y-1.5,z,2.5,3,h,[col[0],col[1],col[2]],1.3);
 s.box(x0-3,y-2,z+h,x1-x0+6,4,3,[col[0],col[1],col[2]],1.3)}
function bubble(s,px,py,w,h,fill,dots=3,flip=false){
 const tx=flip?w-14:14;
 let o=`<g transform="translate(${f(px)} ${f(py)})"><path d="M0 8Q0 0 8 0H${w-8}Q${w} 0 ${w} 8V${h-8}Q${w} ${h} ${w-8} ${h}H${tx+9}L${tx} ${h+9}L${tx+1} ${h}H8Q0 ${h} 0 ${h-8}Z" fill="${fill}" stroke="${INK}" stroke-width="1.3"/>`;
 for(let i=0;i<dots;i++)o+=`<circle cx="${w/2+(i-(dots-1)/2)*9}" cy="${h/2}" r="2.1" fill="${INK}"/>`;
 s.o.push(o+'</g>')}
function key(px,py,sc=1,rot=0){return `<g transform="translate(${f(px)} ${f(py)}) rotate(${rot}) scale(${sc})"><circle cx="0" cy="0" r="8" fill="${HONEY}" stroke="${INK}" stroke-width="1.4"/><circle cx="0" cy="0" r="3" fill="#f3e8d0" stroke="${INK}" stroke-width="1.1"/><rect x="7" y="-2.5" width="26" height="5" fill="${HONEY}" stroke="${INK}" stroke-width="1.3"/><rect x="24" y="2.5" width="4" height="7" fill="${HONEY}" stroke="${INK}" stroke-width="1.2"/><rect x="30" y="2.5" width="3.5" height="5" fill="${HONEY}" stroke="${INK}" stroke-width="1.2"/></g>`}
function gear(px,py,r,col){let p='';const n=8;for(let i=0;i<n;i++){const a=i*Math.PI*2/n,b=a+Math.PI/n*.9;
 const pt=(rad,an)=>f(px+Math.cos(an)*rad)+','+f(py+Math.sin(an)*rad);
 p+=(i?'L':'M')+pt(r*.78,a-.13)+'L'+pt(r*1.02,a-.09)+'L'+pt(r*1.02,a+.09)+'L'+pt(r*.78,a+.13)+'A'+f(r*.78)+' '+f(r*.78)+' 0 0 1 '+pt(r*.78,a+Math.PI*2/n-.13).replace(',',' ')}
 return `<path d="${p}Z" fill="${col}" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/><circle cx="${px}" cy="${py}" r="${f(r*.36)}" fill="#f3e8d0" stroke="${INK}" stroke-width="1.2"/>`}
// plane-Y helpers (wall at y plane)
const qy=(s,x,y,z,w,h,fill,sw=1)=>s.qY(x,y,z,w,h,fill,sw);
const qx=(s,x,y,z,d,h,fill,sw=1)=>s.qX(x,y,z,d,h,fill,sw);
function books(s,plane,fixed,from,to,z,h,cols,seed0){let u=from,i=seed0;
 while(u<to-3){const w=2+((i*7)%3),hh=h*(0.72+((i*5)%4)*.08);const c=cols[i%cols.length];
  if(plane==='y')qy(s,u,fixed,z,w,hh,c,.8);else qx(s,fixed,u,z,w,hh,c,.8);u+=w;i++}}
function windowY(s,x,z,w,h,y=0){
 qy(s,x-2,y,z-2,w+4,h+4,'#f1dfb5',1.4);
 qy(s,x,y,z,w,h,SKY,1.1);
 // hills
 s.poly([s.p(x,y,z),s.p(x+w,y,z),s.p(x+w,y,z+h*.38),s.p(x+w*.62,y,z+h*.3),s.p(x+w*.3,y,z+h*.42),s.p(x,y,z+h*.3)],'#8fb577',1);
 s.poly([s.p(x+w*.55,y,z+h*.74),s.p(x+w*.82,y,z+h*.74),s.p(x+w*.86,y,z+h*.84),s.p(x+w*.6,y,z+h*.84)],'#fff',.9,INK);
 sseg(s,s.p(x+w/2,y,z),s.p(x+w/2,y,z+h),INK,1.6);sseg(s,s.p(x,y,z+h*.55),s.p(x+w,y,z+h*.55),INK,1.6);
 qy(s,x-3,y,z-3,w+6,1.4,'#e6cf9c',1.2)}

// =============================================================
// HERO: the hub as a cut-away building on a ground block
// =============================================================
const K=3,OX=680,OY=400,Z0=4,HW=24;
const hs=new S(OX,OY,K);
const GR={x0:-50,y0:-50,x1:166,y1:166,zb:-44};
// ground block
hs.box(GR.x0,GR.y0,GR.zb,216,216,-GR.zb,['#c8cba3','#a47f55','#876545'],1.5);
// mowing stripes
for(let i=1;i<12;i++){const x=GR.x0+i*18;hs.line(hs.p(x,GR.y0,0),hs.p(x,GR.y1,0),'#8f9a74',1,.35)}
// soil strata on faces
[[-14,'#8c6a49'],[-27,'#8c6a49'],[-38,'#8c6a49']].forEach(([z,c])=>{hs.line(hs.p(GR.x0,GR.y1,z),hs.p(GR.x1,GR.y1,z),c,1,.55);hs.line(hs.p(GR.x1,GR.y0,z),hs.p(GR.x1,GR.y1,z),'#6e5238',1,.55)});
const FACE_Y=GR.y1,FACE_X=GR.x1;
// --- Archive section (left face, plane y=166), x 20..112
const AX0=20,AX1=112;
qy(hs,AX0-2.5,FACE_Y,-41,AX1-AX0+5,36,'#8c6a49',1.5);
qy(hs,AX0,FACE_Y,-39,AX1-AX0,32,'#f1dfb5',1.3);
for(const z of [-31,-23,-15]) {qy(hs,AX0+1,FACE_Y,z,AX1-AX0-2,1.4,'#c58d4a',1);}
books(hs,'y',FACE_Y,AX0+2,AX1-2,-38.5,6,BOOKS,1);
books(hs,'y',FACE_Y,AX0+2,AX1-2,-30,6.6,BOOKS,4);
books(hs,'y',FACE_Y,AX0+2,AX1-2,-22,6.6,BOOKS,9);
books(hs,'y',FACE_Y,AX0+2,AX1-2,-13.6,5.4,BOOKS,2);
// shelf labels, rolling ladder, hanging lamps, curator
for(const z of [-31,-23,-15])[34,62,90].forEach(x=>qy(hs,x,FACE_Y,z-.2,6,1.2,'#fbf2da',.6));
[94,100].forEach(x=>qy(hs,x,FACE_Y,-39,.9,30,'#a8743c',.8));for(let z=-37;z<-10;z+=5)qy(hs,94,FACE_Y,z,6.9,.8,'#c58d4a',.7);
[[38,-8],[78,-8]].forEach(([x,z])=>{const a=hs.p(x,FACE_Y,z),b=hs.p(x,FACE_Y,z-6);hs.o.push('<line x1="'+f(a[0])+'" y1="'+f(a[1])+'" x2="'+f(b[0])+'" y2="'+f(b[1])+'" stroke="#3d2b1f" stroke-width="1"/><circle cx="'+f(b[0])+'" cy="'+f(b[1]+3)+'" r="4.2" fill="#fff1b4" stroke="#3d2b1f" stroke-width="1"/>')});
// --- tunnel entering the archive (left face), x -50..AX0
qy(hs,GR.x0,FACE_Y,-35,AX0-GR.x0+0.5,16,'#6e5238',1.5);
qy(hs,GR.x0+1,FACE_Y,-34,AX0-GR.x0-0.5,14,'#e9cf96',1.2);
for(let u=GR.x0+4;u<AX0-2;u+=14)qy(hs,u,FACE_Y,-34,1.6,14,'#d3b172',.8);
qy(hs,GR.x0+1,FACE_Y,-34,AX0-GR.x0-0.5,2.2,'#c4503a',.9);
folder(hs,GR.x0+9,FACE_Y-5,-33.5,.55);
[[-38,-24],[-14,-24]].forEach(([x,z])=>{const b=hs.p(x,FACE_Y,z);hs.o.push('<circle cx="'+f(b[0])+'" cy="'+f(b[1])+'" r="3" fill="#fff1b4" stroke="#3d2b1f" stroke-width="1"/>')});
hs.box(-26,FACE_Y-6,-33.5,5,4,3.4,['#fff8e4','#e3d3a8','#c9b98c'],.9);hs.box(-18,FACE_Y-6,-33.5,4,4,2.6,['#f4d583','#d9bc6a','#bfa458'],.9);
for(let u=GR.x0+6;u<AX0-4;u+=14)qy(hs,u+2,FACE_Y,-21.2,3,1,'#7b5a40',.5);
animal(hs,64,FACE_Y,-39,.6,'tanuki');
// --- Records section (right face, plane x=166), y 20..112
const RY0=20,RY1=112;
qx(hs,FACE_X,RY0-2.5,-41,RY1-RY0+5,36,'#6e5238',1.5);
qx(hs,FACE_X,RY0,-39,RY1-RY0,32,'#e9cf96',1.3);
// drawers (filing) on the right face
for(let i=0;i<4;i++){const yy=RY0+3+i*10;qx(hs,FACE_X,yy,-36,8.5,24,'#d5a560',1);qx(hs,FACE_X,yy,-36+16,8.5,.1,'#a87238',1);
 qx(hs,FACE_X,yy+3.2,-30,2.2,1.8,'#7b5a40',.8);qx(hs,FACE_X,yy+3.2,-21,2.2,1.8,'#7b5a40',.8);
 qx(hs,FACE_X,yy,-28.2,8.5,.3,'#a87238',.8);qx(hs,FACE_X,yy,-19.4,8.5,.3,'#a87238',.8)}
// database cylinders on the floor of the records room
[[158,84,-39],[158,84,-33.6],[158,84,-28.2]].forEach(([x,y,z],i)=>hs.cyl(x,y,z,6,5.4,i==2?[HONEY,'#cf9a3a','#b4822c']:['#e8c070','#cf9a3a','#b4822c'],1.3));
hs.cyl(158,70,-39,6,5,['#8fb577','#6c9a58','#547c45'],1.3);hs.cyl(158,70,-34,6,5,['#8fb577','#6c9a58','#547c45'],1.3);
for(let i=0;i<4;i++){const yy=RY0+3+i*10;qx(hs,FACE_X,yy+2,-27.2,4.5,1.8,'#fbf2da',.5);qx(hs,FACE_X,yy+2,-18.4,4.5,1.8,'#fbf2da',.5)}
qx(hs,FACE_X,RY0+14,-12,6,3,'#fff8e4',.9);qx(hs,FACE_X,RY0+15,-9.2,4,2,'#f4d583',.8);
[[66,-8]].forEach(([y,z])=>{const a=hs.p(FACE_X,y,z),b=hs.p(FACE_X,y,z-6);hs.o.push('<line x1="'+f(a[0])+'" y1="'+f(a[1])+'" x2="'+f(b[0])+'" y2="'+f(b[1])+'" stroke="#3d2b1f" stroke-width="1"/><circle cx="'+f(b[0])+'" cy="'+f(b[1]+3)+'" r="4.2" fill="#fff1b4" stroke="#3d2b1f" stroke-width="1"/>')});
animal(hs,160,98,-39,.46,'raccoon');
// ---------- path network on the grass ----------
const G=[29,128];
const pathPts=[ [[-14,140],[-4,128],G], [[138,-6],[138,128],G], [[150,140],[150,128],[138,128]] ];
function pathLine(pts,w1,w2,col){const d=pts.map((p,i)=>{const q=hs.p(p[0],p[1],0);return (i?'L':'M')+f(q[0])+' '+f(q[1])}).join('');
 return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w1}" stroke-linejoin="round" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${col}" stroke-width="${w2}" stroke-linejoin="round" stroke-linecap="round"/>`}
pathPts.forEach(p=>hs.o.push(pathLine(p,16,13,'#ecd6a0')));
pathPts.forEach(p=>{const d=p.map((q0,i)=>{const q=hs.p(q0[0],q0[1],0);return (i?'L':'M')+f(q[0])+' '+f(q[1])}).join('');hs.o.push(`<path d="${d}" fill="none" stroke="${TERRA}" stroke-width="1.8" stroke-dasharray="1 7" stroke-linecap="round"/>`)});
// grass tufts, back trees, shrubs
[[-30,-20],[-8,-28],[20,-30],[70,-30],[110,-34],[-34,48],[-28,90],[-10,10],[140,20],[152,60],[128,100],[155,110],[-26,112],[60,135],[90,150],[120,128]].forEach(([x,y])=>{const q=hs.p(x,y,0);hs.o.push('<path d="M'+f(q[0]-5)+' '+f(q[1])+'l2 -6l2 4l2 -7l2 6l2 -4l1 7" fill="none" stroke="#6c9a58" stroke-width="1.3"/>')});
[[40,-44,1],[-44,28,.95],[-44,76,1.05]].forEach(([x,y,s])=>tree(hs,x,y,0,s));
[[-14,-26,.9],[18,-38,.8],[66,-38,.8],[-34,56,.8]].forEach(([x,y,s],i)=>bush(hs,x,y,0,s,i%2?'#c97b8a':'#e0a93a'));
// ---------- building: slab, back walls ----------
hs.box(-3,-3,0,122,122,Z0,['#e3b878','#a87238','#8c5c2c'],1.5);
// room floors
const FL={A:'#e8c98f',B:'#e3b878',C:'#c8cba3',D:'#d2d6b2'};
const Zf=Z0;const LATE=[];
hs.qZ(0,0,58,58,Zf,FL.A,1);hs.qZ(58,0,58,58,Zf,FL.B,1);hs.qZ(0,58,58,58,Zf,FL.C,1);hs.qZ(58,58,58,58,Zf,FL.D,1);
for(let i=1;i<6;i++){hs.line(hs.p(0,i*19.3,Zf),hs.p(116,i*19.3,Zf),'#b07a3c',1,.28)}
hs.box(-3,-3,Zf,3,3,HW,WALLC,1.5);
hs.box(0,-3,Zf,116,3,HW,[CREAM,CREAM2,'#7b5a40'],1.5);
hs.box(-3,0,Zf,3,116,HW,[CREAM,'#7b5a40','#eed59f'],1.5);
// ----- ROOM A (back): Rooms and messages — round table, bubbles
windowY(hs,10,12,16,10,0);
hs.ell(29,29,Zf+.1,21,'#d9e4bf',1.2);hs.ell(29,29,Zf+.15,17.5,'none',1,'#e6a574');hs.ell(29,29,Zf+.2,14,'none',.9,'#fff1c8');
shade(hs,oct(29,29,14,4),Zf+.2,.17);[[14,30],[44,28],[30,45]].forEach(([x,y])=>shade(hs,oct(x,y,4.2,2),Zf+.2,.17));
windowX2(hs,36,Zf+8,14,10);
qx(hs,0,6,Zf+4,24,16,'#c58d4a',1.4);qx(hs,0,7.5,Zf+5.5,21,13,'#e9cf96',1);qx(hs,0,7.5,Zf+11.4,21,1.2,'#c58d4a',.8);books(hs,'x',0,8,28,Zf+5.7,5.4,BOOKS,3);books(hs,'x',0,8,28,Zf+12.8,5,BOOKS,8);
clockY(hs,40,Zf+17,2.6);qy(hs,46,0,Zf+10,8,6,'#f4d583',1.1);qy(hs,47.4,0,Zf+12.6,5,.8,INK,.4);qy(hs,47.4,0,Zf+11,3.4,.8,INK,.4);
hs.cyl(29,29,Zf,13,0.6,['#e8c98f','#c9a06a','#a87238'],1);
hs.cyl(29,29,Zf+5.5,10.5,2,['#e0b274','#c58d4a','#a8743c'],1.3);
hs.cyl(29,29,Zf,2.2,5.5,['#c58d4a','#a8743c','#8c5c2c'],1);
[[14,30],[44,28],[30,45]].forEach(([x,y])=>{hs.cyl(x,y,Zf,3.8,5,['#a9c78a','#86a96a','#5a7d4b'],1.1)});
// envelopes on the table
[[24,26],[31,31],[28,22]].forEach(([x,y],i)=>{hs.box(x,y,Zf+7.5,7,5,.8,['#fff8e4','#e3d3a8','#c9b98c'],.9);hs.qZ(x+1.6,y+1.6,3.8,1.6,Zf+8.3,TERRA,.6)});
mug(hs,34,24,Zf+7.5);hs.box(20,31,Zf+7.5,5,6,.6,['#f4d583','#d9bc6a','#bfa458'],.7);
plant(hs,50,9,Zf,.4);LATE.push(()=>{animal(hs,12,46,Zf,.62,'fox');animal(hs,47,45,Zf,.62,'bear')});flowers(hs,6,54,Zf);
// speech bubbles floating
bubble(hs,hs.p(29,29,Zf+22)[0]-52,hs.p(29,29,Zf+22)[1]-30,34,20,'#fff8e4',3);
bubble(hs,hs.p(29,29,Zf+22)[0]+14,hs.p(29,29,Zf+22)[1]-52,34,20,'#d9e4bf',3,true);
// ----- ROOM B (right-back): Task board
qy(hs,62,0,8,50,15.5,'#c58d4a',1.4);
qy(hs,63.5,0,9.5,47,12.5,CREAM,1);
for(const u of [79,95])qy(hs,u,0,9.5,.7,12.5,'#c58d4a',.8);
const cardC=['#e0a93a','#8fb577','#d9944f','#a9d2de','#c97b8a'];
[[64.5,17.5,0],[64.5,13.2,1],[64.5,9.8,3],[80.5,16.6,2],[80.5,12.4,4],[96.5,17.4,1],[96.5,13.2,3],[96.5,9.9,0]].forEach(([x,z,c])=>{qy(hs,x,0,z,12,3.2,cardC[c],.9)});
sseg(hs,hs.p(62,0,24.6),hs.p(112,0,24.6),'#7b5a40',1.2);
shadeBox(hs,66,16,28,12,Zf+.1,.18);shadeBox(hs,98,19,8,6,Zf+.1,.14);
desk(hs,66,16,28,12,6);laptop(hs,71,18,Zf+6+2.4,.8);mug(hs,84,23,Zf+8.4,'#c4503a');lamp(hs,90,20,Zf+8.4,.9);bookStack(hs,66,18,Zf+8.4,['#5f9a6a','#e0a93a','#c4503a'],6,5);
[64.5,80.5,96.5].forEach((x,i)=>{qy(hs,x,0,21.4,12,1.5,[ '#5f9a6a','#e0a93a','#c4503a'][i],.8);for(let r=0;r<4;r++)if(r<3)qy(hs,x+1,0,[17.5,13.2,9.8][r]+1.7,6+(r%2)*2,.5,INK,.3)});
[[64.5,17.5],[64.5,13.2],[64.5,9.8],[80.5,16.6],[80.5,12.4],[96.5,17.4],[96.5,13.2],[96.5,9.9]].forEach(([x,z])=>qy(hs,x+10.6,0,z+1.7,1,1,TERRA,.5));
hs.box(86,19,Zf+8.4,5,4,.8,['#fff8e4','#e3d3a8','#c9b98c'],.8);
shade(hs,[[100,24],[108,24],[111,29],[103,29]],Zf+.1,.18);LATE.push(()=>{animal(hs,103,22,Zf,.7,'rabbit');animal(hs,62,36,Zf,.64,'owl')});plant(hs,108,46,Zf,.38);hs.box(100,36,Zf,8,6,5,['#f1dfb5','#d9bc82','#a98a5a'],.9);qy(hs,101.5,42,Zf+3,5,.9,INK,.4);
// ----- ROOM C (front-left): Policy gate
hs.qZ(8,66,42,46,Zf+.1,'#b9c796',.8);
for(let i=0;i<5;i++)hs.qZ(10+i*8,104,5,5,Zf+.15,i%2?'#e3b878':'#f1dfb5',.6);
// the arch at the entrance (plane y=116, gap x 12..46)
const ARCHC=['#e6cf9c','#d5a560','#a8743c'];
// barrier arm
hs.box(14,100,Zf,3,3,12,['#f1dfb5','#c58d4a','#8c5c2c'],1.1);hs.box(40,100,Zf,3,3,12,['#f1dfb5','#c58d4a','#8c5c2c'],1.1);
hs.box(17,100.6,Zf+9,23,1.8,1.8,[TERRA,'#a3402e','#a3402e'],1.1);
for(let i=0;i<4;i++)hs.box(19+i*5.5,100.6,Zf+9,2.4,1.9,1.9,['#fbf2da','#e3d3a8','#e3d3a8'],.7);
windowX2(hs,84,Zf+8,14,10);
{const sh=(y,z)=>hs.p(0,y,z);hs.poly([sh(100,Zf+10),sh(108,Zf+10),sh(108,Zf+16),sh(104,Zf+19),sh(100,Zf+16)],'#e0a93a',1.1);hs.poly([sh(102,Zf+12),sh(106,Zf+12),sh(106,Zf+15.4),sh(104,Zf+17),sh(102,Zf+15.4)],'#fbf2da',.8)}
plant(hs,5,111,Zf,.38);plant(hs,52,111,Zf,.38);shade(hs,[[24,86],[32,86],[35,90],[27,90]],Zf+.2,.18);
LATE.push(()=>animal(hs,28,84,Zf,.7,'raccoon'));hs.box(36,76,Zf,8,8,5,['#e9cf96','#c9a06a','#a98a5a'],.9);
// side desk with checklist
desk(hs,8,66,22,10,6);hs.box(12,68,Zf+8.4,8,5.5,.7,['#fff8e4','#e3d3a8','#c9b98c'],.8);for(let r=0;r<3;r++)hs.line(hs.p(13,69.5+r*1.4,Zf+9.2),hs.p(19,69.5+r*1.4,Zf+9.2),'#8b6a4c',.8,1);hs.cyl(24,70,Zf+8.4,1.5,2,['#c4503a','#a3402e','#8c2f20'],.8);mug(hs,26.5,72,Zf+8.4);shadeBox(hs,8,66,22,10,Zf+.1,.16);
// ----- ROOM D (front-right): Map room — graph on the floor
hs.qZ(62,62,50,50,Zf+.1,'#b9c796',.8);
const nodes=[[75,72,'#e0a93a',4],[96,68,'#c97b8a',3.4],[104,90,'#5b9ec9',4],[84,94,'#8fb577',4.4],[68,104,'#d9944f',3.2],[100,106,'#e0a93a',3],[88,80,TERRA,5]];
const lk=[[0,6],[1,6],[2,6],[3,6],[4,3],[5,2],[0,4],[1,2],[3,5]];
lk.forEach(([a,b])=>hs.line(hs.p(nodes[a][0],nodes[a][1],Zf+.4),hs.p(nodes[b][0],nodes[b][1],Zf+.4),INK,1.3,.85));
nodes.forEach(n=>hs.ell(n[0],n[1],Zf+.4,n[3],n[2],1.3));
hs.cyl(66,108,Zf,2.8,9,['#e6cf9c','#d5a560','#a8743c'],1);hs.ell(66,108,Zf+9,3.6,'#fff1b4',1);
nodes.forEach((n,i)=>{if(i%2===0){hs.line(hs.p(n[0],n[1],Zf+.4),hs.p(n[0],n[1],Zf+9),INK,1,1);hs.poly([hs.p(n[0],n[1],Zf+9),hs.p(n[0]+5,n[1],Zf+7.2),hs.p(n[0],n[1],Zf+5.4)],TERRA,.8)}});
hs.cyl(74,62,Zf,3,5,['#e6cf9c','#d5a560','#a8743c'],1);[0,1,2].forEach(i=>hs.cyl(73+i*1.6,61.5+i*.6,Zf+5,.9,9+i,['#fff8e4','#e3d3a8','#c9b98c'],.7));
plant(hs,110,110,Zf,.38);shade(hs,oct(108,72,4,2),Zf+.2,.16);shade(hs,oct(64,78,4,2),Zf+.2,.16);
LATE.push(()=>{animal(hs,108,70,Zf,.64,'tanuki');animal(hs,64,76,Zf,.64,'bear')});
// partitions (low)
const PC=['#f1dfb5','#d9bc82','#a98a5a'];
hs.box(57,0,Zf,2.4,50,7,PC,1.2);hs.box(57,66,Zf,2.4,50,7,PC,1.2);
hs.box(0,57,Zf,50,2.4,7,PC,1.2);hs.box(66,57,Zf,50,2.4,7,PC,1.2);
// front low walls
hs.box(0,116,Zf,12,2.5,6,[CREAM,CREAM2,'#7b5a40'],1.3);
hs.box(46,116,Zf,70,2.5,6,[CREAM,CREAM2,'#7b5a40'],1.3);
hs.box(116,0,Zf,2.5,116,6,[CREAM,'#7b5a40','#eed59f'],1.3);
LATE.forEach(fn=>fn());
// arch drawn last so it stands in front
arch(hs,12,44,116,Zf,18,ARCHC);
(()=>{const q=hs.p(28,116,Zf+19.5);lock(hs,q[0],q[1]-4,1.15)})();
// ---------- houses ----------
function house(s,x,y,roof,roof2,wall,lap=true){
 const w=22,d=18,h=12;
 s.box(x,y,0,w,d,h,[wall[0],wall[1],wall[2]],1.4);
 const P=(a,b,c)=>s.p(a,b,c);
 s.poly([P(x+w,y,h),P(x+w,y+d,h),P(x+w,y+d/2,h+9)],wall[2],1.3);
 s.poly([P(x-2,y-2,h),P(x+w+2,y-2,h),P(x+w+2,y+d/2,h+9),P(x-2,y+d/2,h+9)],roof2,1.4);
 s.poly([P(x-2,y+d+2,h),P(x+w+2,y+d+2,h),P(x+w+2,y+d/2,h+9),P(x-2,y+d/2,h+9)],roof,1.4);
 s.poly([P(x+w+2,y+d+2,h),P(x+w+2,y+d/2,h+9),P(x+w+2,y-2,h)],roof2,0);
 // door + window
 qy(s,x+8,y+d,0,6,8.4,'#8a5a2e',1.2);
 qy(s,x+2.5,y+d,4.5,4,4,SKY,1);
 qx(s,x+w,y+5,3.5,7,5,SKY,1);
 s.line(P(x+w,y+8.5,3.5),P(x+w,y+8.5,8.5),INK,1.1);
 // chimney
 s.box(x+3,y+d/2-1,h+4,3,3,6,[ '#c98350','#a8643a','#8c5230'],1.1);
 // roof shingle lines, knob, window cross, smoke, flower box
 for(let i=1;i<4;i++){const u=i*(w+4)/4-2,v=i/4;s.line(P(x-2,y+d+2-(d/2+2)*v,h+9*v),P(x+w+2,y+d+2-(d/2+2)*v,h+9*v),'#3d2b1f',.8,.35)}
 s.line(P(x-2,y+d/2,h+9),P(x+w+2,y+d/2,h+9),'#3d2b1f',1.4,1);
 s.ell(x+12.6,y+d,4.4,.45,'#fbf2da',.6);
 s.line(P(x+4.5,y+d,4.5),P(x+4.5,y+d,8.5),INK,.9,.8);s.line(P(x+2.5,y+d,6.5),P(x+6.5,y+d,6.5),INK,.9,.8);
 qy(s,x+2,y+d+.2,3.4,5,1.4,'#8a5a2e',.7);
 s.qY(x+7,y+d,0,8,.6,'#c9b98c',.6);
 [[x+4.5,y+d/2+1,h+12],[x+6.5,y+d/2+1,h+16],[x+4.8,y+d/2+1,h+20]].forEach((a,i)=>{const q=P(a[0],a[1],a[2]);s.o.push('<circle cx="'+f(q[0]+i*3)+'" cy="'+f(q[1])+'" r="'+(3.4+i*1.4)+'" fill="#fbf2da" stroke="#3d2b1f" stroke-width="1"/>')});
 shade(s,[[x+w,y],[x+w+7,y+4],[x+w+7,y+d+4],[x+w,y+d]],0.05,.16)}
function tableLaptop(s,x,y){shadeBox(s,x,y,13,9,.05,.18);desk(s,x,y,13,9,5);laptop(s,x+1.2,y+1.2,5+2.4,.62);mug(s,x+10,y+5,5+2.4)}
const HS=[ {n:'Claude Code \u00b7 Windows',x:-37,y:129,r:['#c4503a','#a3402e']}, {n:'Codex \u00b7 Linux',x:123,y:-22,r:['#5f9a6a','#47775a']}, {n:'Claude Desktop \u00b7 macOS',x:139,y:140,r:['#e0a93a','#b4822c']} ];
const WALLH=['#f8e5b4','#f1dfb5','#d5b98a'];
// draw order back to front: H2 (right-back), H1 (left), H3 (front)
house(hs,HS[1].x,HS[1].y,HS[1].r[0],HS[1].r[1],WALLH);tableLaptop(hs,HS[1].x+4,HS[1].y+24);animal(hs,HS[1].x+21,HS[1].y+30,0,.62,'rabbit');
house(hs,HS[0].x,HS[0].y,HS[0].r[0],HS[0].r[1],WALLH);tableLaptop(hs,HS[0].x+3,HS[0].y+22);animal(hs,HS[0].x+21,HS[0].y+28,0,.62,'owl');
house(hs,HS[2].x,HS[2].y,HS[2].r[0],HS[2].r[1],WALLH);tableLaptop(hs,HS[2].x-17,HS[2].y+16);animal(hs,HS[2].x-1,HS[2].y+24,0,.62,'owl');flowers(hs,HS[2].x+19,HS[2].y+22,0);flowers(hs,HS[0].x+1,HS[0].y+20,0);
[[150,50,.95],[154,92,1]].forEach(([x,y,s])=>tree(hs,x,y,0,s));
// ---------- Console tier (floating) ----------
const cs=new S(OX,OY+84-125*K,K);
const CW=56;
cs.box(-3,-3,-7,CW+3,CW+3,7,['#e3b878','#a87238','#8c5c2c'],1.5);
cs.qZ(0,0,CW,CW,0,'#e8c98f',1);
cs.box(-3,-3,0,3,3,22,WALLC,1.5);cs.box(0,-3,0,CW,3,22,[CREAM,CREAM2,'#7b5a40'],1.5);cs.box(-3,0,0,3,CW,22,[CREAM,'#7b5a40','#eed59f'],1.5);
windowY(cs,9,7,24,12,0);
// rug
cs.ell(30,34,0.1,17,'#b9c796',1.2);cs.ell(30,34,0.2,13,'none',1.2,'#e6a574');
desk(cs,14,10,34,13,9);
laptop(cs,17,12,9+2.4,1.0);laptop(cs,33,12,9+2.4,1.0,'#f3dfa8');
shade(cs,[[14,23],[48,23],[52,27],[18,27]],.1,.17);windowX2(cs,38,7,12,10);clockY(cs,46,16,2.4);
mug(cs,40,14,9+2.4);lamp(cs,12,14,9+2.4,.8);bookStack(cs,43,14,9+2.4,['#5f9a6a','#e0a93a'],7,5);
chair(cs,26,28,0);animal(cs,31,33,7,.72,'fox');
// roof: capped parapet with tiles, antenna, chimney
for(let u=0;u<CW;u+=4.6){cs.box(u,-3.6,22,3.6,4.4,1.6,[u%9<4.6?'#d9944f':'#c4503a','#a3402e','#8c2f20'],.9)}
for(let u=0;u<CW;u+=4.6){cs.box(-3.6,u,22,4.4,3.6,1.6,[u%9<4.6?'#d9944f':'#c4503a','#a3402e','#8c2f20'],.9)}
cs.box(8,-2.5,23.6,5,5,7,['#c98350','#a8643a','#8c5230'],1);
cs.box(CW-12,-2,23.6,1.2,1.2,15,['#d5a560','#c58d4a','#a8743c'],.9);
{const a=cs.p(CW-11.4,-1.4,38.6);cs.o.push('<path d="M'+f(a[0])+' '+f(a[1])+'l20 6l-20 5z" fill="#c4503a" stroke="#3d2b1f" stroke-width="1.1"/>');
 const d=cs.p(CW-26,-1,28);cs.o.push('<g transform="translate('+f(d[0])+' '+f(d[1])+')"><path d="M-9 -4Q-9 6 4 6Z" fill="#fbf2da" stroke="#3d2b1f" stroke-width="1.1"/><path d="M-1 3L5 -5" stroke="#3d2b1f" stroke-width="1.1" fill="none"/><circle cx="5" cy="-5" r="1.6" fill="#c4503a" stroke="#3d2b1f" stroke-width="1"/></g>')}

// wall card on x=0 wall
qx(cs,0,18,9,16,10,'#f4d583',1.2);qx(cs,0,20,16,12,1.2,INK,.5);qx(cs,0,20,13.5,9,1.2,INK,.5);qx(cs,0,20,11,11,1.2,INK,.5);
plant(cs,6,50,0,.3);flowers(cs,42,44,0,['#c97b8a','#e0a93a']);
// ---------- assemble ----------
let scene=hs.o.join('')+'';
// console stilts (dashed guide lines from console corners to building top)
const cb=[cs.p(0,CW,-7),cs.p(CW,CW,-7),cs.p(CW,0,-7)];
const gl=cb.map((q,i)=>{const t=[hs.p(0,0,Zf+HW)];return ''}).join('');
// ---------- tags ----------
const T=[];const rects=[];
function addTag(x,y,text,tx,ty,o={}){const w=Math.round(text.length*7.6+22);rects.push([text,x,y,x+w+3,y+30]);T.push(tx==null?tag(x,y,text,o):tagL(x,y,text,tx,ty,o))}
const P=(s,x,y,z)=>s.p(x,y,z);
const pa=P(hs,29,29,Zf+10),pb=P(hs,99,0,Zf+16),pc=P(hs,28,116,Zf+19),pd=P(hs,88,88,Zf+.5),pcons=P(cs,30,20,10);
const parc=P(hs,66,FACE_Y,-24),prec=P(hs,FACE_X,66,-24),ptun=P(hs,-26,FACE_Y,-27);
const h1=P(hs,-26,138,40),h2=P(hs,134,-13,40),h3=P(hs,150,149,34);
console.log('anchors',{pa,pb,pc,pd,pcons,parc,prec,ptun,h1,h2,h3});
addTag(60,96,'Console \u00b7 the operator\u2019s room',pcons[0]-6,pcons[1]-2);
addTag(60,232,'Rooms and messages',pa[0]-8,pa[1]-4);
addTag(1030,226,'Task board \u00b7 claim, submit, review',pb[0]+4,pb[1]);
addTag(1000,708,'Map room \u00b7 tended by curators',pd[0]+8,pd[1]);
addTag(30,316,'Policy gate \u00b7 every call checked, deny wins',pc[0]-6,pc[1]-4,{col:TERRA});
addTag(24,790,'Bridge \u00b7 files folder to folder',ptun[0],ptun[1],{col:TERRA});
addTag(24,892,'Archive \u00b7 Obsidian vault',parc[0],parc[1]);
addTag(1090,892,'Records \u00b7 one SQLite database',prec[0],prec[1]);
const mp=P(hs,85,128,0);
addTag(Math.round(mp[0]-20),Math.round(mp[1]+22),'MCP \u00b7 Streamable HTTP',null,null,{col:TERRA});
const mp1=P(hs,-8,134,0),mp2=P(hs,138,30,0);
addTag(Math.round(mp1[0]-70),Math.round(mp1[1]+16),'MCP',null,null,{col:TERRA});
addTag(Math.round(mp2[0]+16),Math.round(mp2[1]-6),'MCP',null,null,{col:TERRA});
addTag(30,486,HS[0].n,h1[0],h1[1]);
addTag(Math.round(h2[0]-40),Math.round(h2[1]-76),HS[1].n,h2[0],h2[1]);
addTag(Math.round(h3[0]-60),Math.round(h3[1]+30),HS[2].n,h3[0],h3[1]);
// overlap report
for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a[1]<b[3]&&b[1]<a[3]&&a[2]<b[4]&&b[2]<a[4])console.log('OVERLAP',a[0],'|',b[0])}
rects.forEach(r=>{if(r[1]<0||r[3]>1360||r[2]<0||r[4]>1060)console.log('OUT',r)});
const heroSvg=`<svg class="hero-art" viewBox="0 0 1360 1060" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="The Conclave hub as a cut-away building: console on top, four rooms, records and archive underground, three client houses outside">${scene}${cs.o.join('')}${T.join('')}</svg>`;

// ---------- phone variant: same scene, cropped, labels enlarged and stacked in bands ----------
const PS=2.35,PW=n=>Math.round(n.length*7.6+22)*PS,PH=26*PS,PG=16;
const pLine=(x1,y1,tx,ty)=>'<line x1="'+f(x1)+'" y1="'+f(y1)+'" x2="'+f(tx)+'" y2="'+f(ty)+'" stroke="#3d2b1f" stroke-width="2.6" stroke-dasharray="2 8" stroke-linecap="round"/><circle cx="'+f(tx)+'" cy="'+f(ty)+'" r="6" fill="'+TERRA+'" stroke="#3d2b1f" stroke-width="2"/>';
const pTag=(x,y,t,o)=>'<g transform="translate('+f(x)+' '+f(y)+') scale('+PS+')">'+tag(0,0,t,o)+'</g>';
const PX=96,PXR=1264;
const topL=[['Policy gate · every call checked, deny wins',pc[0]-6,pc[1]-4,{col:TERRA}],['Task board · claim, submit, review',pb[0]+4,pb[1]],['Console · the operator’s room',pcons[0]-6,pcons[1]-2],['Rooms and messages',pa[0]-8,pa[1]-4],[HS[0].n,h1[0],h1[1]],[HS[1].n,h2[0],h2[1]]].sort((a,b)=>PW(b[0])-PW(a[0]));
const botL=[['Bridge · files folder to folder',ptun[0],ptun[1],{col:TERRA}],['Archive · Obsidian vault',parc[0],parc[1]],['Records · one SQLite database',prec[0],prec[1]],['Map room · tended by curators',pd[0]+8,pd[1]],[HS[2].n,h3[0],h3[1]]].sort((a,b)=>PW(a[0])-PW(b[0]));
const TOPEND=235,BOTSTART=1010;
const pt=[];
topL.forEach((t,i)=>{const y=TOPEND-(topL.length-i)*(PH+PG)+PG,x=PX+14;pt.push(pLine(x+PW(t[0]),y+PH/2,t[1],t[2]));pt.push(pTag(x,y,t[0],t[3]))});
botL.forEach((t,i)=>{const y=BOTSTART+i*(PH+PG),x=PX+14;pt.push(pLine(x+PW(t[0]),y+PH/2,t[1],t[2]));pt.push(pTag(x,y,t[0],t[3]))});
const mcpT=[[Math.round(mp[0]-20),Math.round(mp[1]+22),'MCP · Streamable HTTP'],[Math.round(mp1[0]-70),Math.round(mp1[1]+16),'MCP'],[Math.round(mp2[0]+16),Math.round(mp2[1]-6),'MCP']].map(m=>{const w=Math.round(m[2].length*7.6+22);return '<g transform="translate('+f(m[0]+w/2*(1-PS))+' '+f(m[1]+13*(1-PS))+') scale('+PS+')">'+tag(0,0,m[2],{col:TERRA})+'</g>'}).join('');
const PY0=BOTSTART-0,PVB=[PX,TOPEND-topL.length*(PH+PG)-6,PXR-PX,(BOTSTART+botL.length*(PH+PG))-(TOPEND-topL.length*(PH+PG))+6];
const heroSvgPhone='<svg class="hero-ph" viewBox="'+PVB.map(f).join(' ')+'" stroke-linejoin="round" stroke-linecap="round" role="img" aria-label="The Conclave hub as a cut-away building: console on top, four rooms, records and archive underground, three client houses outside">'+scene+cs.o.join('')+pt.join('')+mcpT+'</svg>';
module.exports={heroSvgPhone,heroSvg,FAM,TOTAL,COLS,byName,hs,cs,pers,sseg,arch,bubble,key,gear,windowY,books,qy,qx,CREAM,CREAM2,SAND,HONEY,SAGE,MOSS,SKY,WALLC,ARCHC,tag,tagL};
if(require.main===module)console.log('total',TOTAL,'svg bytes',heroSvg.length);
