import fs from 'node:fs'; import {Agent,out,RUN} from './lib.mjs';
const R=[];const rec=(id,name,pass,ev)=>{R.push({id,name,pass,ev});console.log((pass?'PASS ':'FAIL ')+id+' '+name+' :: '+JSON.stringify(ev).slice(0,450));};
const P=`/vault/Stress/${RUN}/`;
const mk=async(n)=>{const a=new Agent(n);await a.login();return a;};
const W=[];for(let i=1;i<=8;i++)W.push(await mk('vs-w'+i));
const rd=async(a,p)=>{const r=await a.call('file_read',{path:p});return {rev:r.data?.revision,content:r.data?.content,err:r.err,text:r.text}};
const mkf=async(p,c='x')=>{const r=await W[0].call('file_create',{path:p,content:c});return r.data?.revision;};
const ls=async(dir)=>{const r=await W[0].call('file_list',{path:dir});return r;};
const ex=async(p)=>{const r=await rd(W[0],p);return !r.err;};
// 2a edit vs delete
for(let i=0;i<5;i++){const p=P+`c2/ed-${i}.md`;const b=await mkf(p,'v0');const [u,d]=await Promise.all([W[1].call('file_update',{path:p,content:'edited',base_revision:b}),W[2].call('file_delete',{path:p,base_revision:b})]);
  const e=await ex(p);const consistent=(!u.err&&!d.err)?'BOTH_OK':(u.err&&d.err)?'BOTH_FAIL':'ONE';
  rec('2a.'+i,'edit vs delete same base: not both succeed silently',consistent!=='BOTH_OK',{update:u.err?u.text.slice(0,90):'ok',del:d.err?d.text.slice(0,90):'ok',existsAfter:e,outcome:consistent});}
// 2b edit vs rename
for(let i=0;i<5;i++){const p=P+`c2/er-${i}.md`,q=P+`c2/er-${i}-moved.md`;const b=await mkf(p,'v0');const [u,m]=await Promise.all([W[1].call('file_update',{path:p,content:'edited',base_revision:b}),W[2].call('file_rename',{from:p,to:q,base_revision:b})]);
  const atP=await ex(p),atQ=await ex(q);const qc=atQ?(await rd(W[0],q)).content:null;
  rec('2b.'+i,'edit vs rename same base',!(!u.err&&!m.err),{update:u.err?u.text.slice(0,80):'ok',rename:m.err?m.text.slice(0,80):'ok',atOld:atP,atNew:atQ,newContent:qc});}
// 2c rename vs rename same target
for(let i=0;i<5;i++){const a=P+`c2/rr-a-${i}.md`,b2=P+`c2/rr-b-${i}.md`,t=P+`c2/rr-t-${i}.md`;const ra=await mkf(a,'A'),rb=await mkf(b2,'B');const [x,y]=await Promise.all([W[1].call('file_rename',{from:a,to:t,base_revision:ra}),W[2].call('file_rename',{from:b2,to:t,base_revision:rb})]);
  const tc=(await rd(W[0],t)).content;const ea=await ex(a),eb=await ex(b2);const oks=[x,y].filter(r=>!r.err).length;
  rec('2c.'+i,'rename vs rename to same target: one wins, loser untouched',oks===1&&((tc==='A'&&eb&&!ea)||(tc==='B'&&ea&&!eb)),{oks,target:tc,aStillThere:ea,bStillThere:eb,err:[x,y].find(r=>r.err)?.text.slice(0,100)});}
// 2d create vs create
for(let i=0;i<5;i++){const p=P+`c2/cc-${i}.md`;const rs=await Promise.all(W.slice(0,6).map((a,k)=>a.call('file_create',{path:p,content:'c'+k})));const oks=rs.filter(r=>!r.err).length;const cur=(await rd(W[0],p)).content;const win=rs.findIndex(r=>!r.err);
  rec('2d.'+i,'6 creators same path: exactly one wins',oks===1&&cur==='c'+win,{oks,final:cur,winner:win});}
// 2e folder move while editing: file_rename on a folder
{const d=P+'c2/folder';for(let i=0;i<5;i++)await mkf(`${d}/f${i}.md`,'f');const r=await W[0].call('file_rename',{from:d,to:P+'c2/folder-moved',base_revision:'absent'});rec('2e.0','file_rename of a folder (agent tool)',true,{info:'record only',err:r.err,text:r.text.slice(0,200)});
  // admin-API move of folder handled in run3 if supported
}
// 2f edit storm during rename chain: 3 renamers ping-pong + 3 editors by path
{const p=P+'c2/storm.md';let b=await mkf(p,'s');let cur=p;const names=[P+'c2/storm-1.md',P+'c2/storm-2.md'];let stop=false;let upd=0,updFail=0,ren=0;
  const editor=async(a)=>{while(!stop){const r=await rd(a,cur);if(r.err)continue;const u=await a.call('file_update',{path:cur,content:(r.content||'')+'e',base_revision:r.rev});u.err?updFail++:upd++;}};
  const eds=[1,2,3].map(i=>editor(W[i]));
  for(let k=0;k<10;k++){const r=await rd(W[0],cur);if(r.err)continue;const to=names[k%2];const m=await W[0].call('file_rename',{from:cur,to,base_revision:r.rev});if(!m.err){cur=to;ren++;}}
  stop=true;await Promise.all(eds);const fin=await rd(W[0],cur);const eLen=(fin.content||'').length-1;
  rec('2f.0','edits racing renames: accepted edits all in final content',eLen===upd,{acceptedEdits:upd,editsRefused:updFail,renames:ren,finalEs:eLen});}
out('c2.json',R);
