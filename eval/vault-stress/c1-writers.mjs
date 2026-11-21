import fs from 'node:fs'; import {Agent,out,RUN} from './lib.mjs';
const R=[];const rec=(id,name,pass,ev)=>{R.push({id,name,pass,ev});console.log((pass?'PASS ':'FAIL ')+id+' '+name+' :: '+JSON.stringify(ev).slice(0,400));};
const P=`/vault/Stress/${RUN}/`;
const mk=async(n)=>{const a=new Agent(n);await a.login();return a;};
const W=[];for(let i=1;i<=8;i++)W.push(await mk('vs-w'+i));
const extra=[];for(let i=0;i<12;i++)extra.push(await mk('vs-w'+((i%8)+1)));
const all=[...W,...extra];
const rd=async(a,p)=>{const r=await a.call('file_read',{path:p});return {rev:r.data?.revision||(r.text.match(/sha256:[0-9a-f]{64}/)||[])[0],text:r.text,err:r.err,data:r.data}};
// 1. N writers same note, same base
for(const N of [2,5,20]){
  const p=P+`c1/same-${N}.md`;const c=await W[0].call('file_create',{path:p,content:'base'});const base=c.data.revision;
  const rs=await Promise.all(all.slice(0,N).map((a,i)=>a.call('file_update',{path:p,content:'writer-'+i,base_revision:base})));
  const ok=rs.filter(r=>!r.err),bad=rs.filter(r=>r.err);const cur=await rd(W[0],p);
  const winnerContent=(cur.text||'');
  rec('1.'+N,`${N} writers, same base: exactly one wins`,ok.length===1&&bad.every(b=>/conflict|changed|current_revision/i.test(b.text)),{success:ok.length,conflicts:bad.length,sampleErr:bad[0]?.text?.slice(0,160),finalHasWinner:/writer-\d+/.test(winnerContent)});
}
// 1b. read-modify-write append with retry: no lost update
for(const N of [5,20]){
  const p=P+`c1/append-${N}.md`;await W[0].call('file_create',{path:p,content:''});const K=5;let retries=0,fails=0;
  await Promise.all(all.slice(0,N).map(async(a,i)=>{for(let k=0;k<K;k++){for(let t=0;t<60;t++){const r=await rd(a,p);const body=(r.data?.content??r.text);const content=(typeof r.data?.content==='string'?r.data.content:null);const base=r.rev;const old=content??'';const u=await a.call('file_update',{path:p,content:old+`w${i}-${k}\n`,base_revision:base});if(!u.err)break;retries++;if(t===59)fails++;}}}));
  const cur=await rd(W[0],p);const txt=cur.data?.content??'';const lines=txt.split('\n').filter(Boolean);
  rec('1b.'+N,`${N} writers x${K} appends with retry: no lost update`,lines.length===N*K&&new Set(lines).size===N*K,{expected:N*K,got:lines.length,unique:new Set(lines).size,retries,gaveUp:fails,hasContentField:typeof cur.data?.content==='string'});
}
out('c1.json',R);
