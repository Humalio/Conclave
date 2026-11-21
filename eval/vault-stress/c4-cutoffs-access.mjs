import fs from 'node:fs'; import net from 'node:net'; import {Agent,MCP,APP,out,restartHub,RUN} from './lib.mjs';
const R=[];const rec=(id,name,pass,ev)=>{R.push({id,name,pass,ev});console.log((pass?'PASS ':'FAIL ')+id+' '+name+' :: '+JSON.stringify(ev).slice(0,450));};
const P=`/vault/Stress/${RUN}/`;const Q='/vault/Stress/';const mk=async(n)=>{const a=new Agent(n);await a.login();return a;};
const W=[];for(let i=1;i<=8;i++)W.push(await mk('vs-w'+i));const ro=await mk('vs-ro'),none=await mk('vs-none'),lim=await mk('vs-lim');
const w=W[0];const rd=async(p,a=w)=>{const r=await a.call('file_read',{path:p});return {rev:r.data?.revision,content:r.data?.content,err:r.err,text:r.text}};
// 6 access
{const p=P+'c6/target.md';await w.call('file_create',{path:p,content:'t'});const r0=await rd(p);
 const tries={create:()=>ro.call('file_create',{path:P+'c6/ro-new.md',content:'x'}),update:()=>ro.call('file_update',{path:p,content:'hacked',base_revision:r0.rev}),patch:()=>ro.call('file_patch',{path:p,base_revision:r0.rev,edits:[{old:'t',new:'h'}]}),rename:()=>ro.call('file_rename',{from:p,to:P+'c6/ro-moved.md',base_revision:r0.rev}),delete:()=>ro.call('file_delete',{path:p,base_revision:r0.rev}),restore:()=>ro.call('file_restore',{path:p,revision:r0.rev})};
 const res=await Promise.all(Object.entries(tries).flatMap(([k,f])=>[0,1,2].map(async()=>[k,await f()])));
 const wrongly=res.filter(([k,r])=>!r.err).map(([k])=>k);const after=await rd(p);
 rec('6.ro','read-only agent: every write refused (6 ops x3 concurrent)',wrongly.length===0&&after.content==='t',{allowedWrongly:wrongly,fileAfter:after.content,sample:res[0][1].text.slice(0,90)});
 const rn=await ro.call('file_read',{path:p});rec('6.ro-read','read-only agent can read',!rn.err,{err:rn.err});
 const nr=await Promise.all([none.call('file_read',{path:p}),none.call('file_list',{path:P+'c6'}),none.call('file_create',{path:P+'c6/n.md',content:'x'}),none.call('file_search',{query:'t',path:P})]);
 rec('6.none','agent without vault rights: read/list/create/search all refused',nr.every(r=>r.err||/0 (results|matches)|no match/i.test(r.text)),{results:nr.map(r=>r.err?'refused':'OK:'+r.text.slice(0,60))});
 await w.call('file_create',{path:Q+'Open/a-'+RUN+'.md',content:'o'});await w.call('file_create',{path:Q+'Open/Secret/s-'+RUN+'.md',content:'secret'});await w.call('file_create',{path:Q+'Closed/c-'+RUN+'.md',content:'c'});
 const l=await Promise.all([lim.call('file_create',{path:Q+'Open/new-'+RUN+'.md',content:'x'}),lim.call('file_create',{path:Q+'Open/Secret/new-'+RUN+'.md',content:'x'}),lim.call('file_read',{path:Q+'Open/Secret/s-'+RUN+'.md'}),lim.call('file_create',{path:Q+'Closed/new-'+RUN+'.md',content:'x'}),lim.call('file_read',{path:Q+'Closed/c-'+RUN+'.md'}),lim.call('file_list',{path:Q+'Open'}),lim.call('file_search',{query:'secret',path:Q})]);
 rec('6.lim','restricted agent: Open ok, Open/Secret and Closed denied, search leaks nothing',!l[0].err&&l[1].err&&l[2].err&&l[3].err&&l[4].err&&!/s\.md|Secret/.test(l[6].text)&&!/Secret/.test(l[5].text),{openCreate:l[0].err?'ERR':'ok',secretCreate:l[1].err?'refused':'ALLOWED',secretRead:l[2].err?'refused':'READ',closedCreate:l[3].err?'refused':'ALLOWED',closedRead:l[4].err?'refused':'READ',listOpenShowsSecret:/Secret/.test(l[5].text),searchSnip:l[6].text.slice(0,120)});
}
// 4c cut-off write
const partial=(path,bytes,frac)=>new Promise((res)=>{const u=new URL(MCP);const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'file_create',arguments:{session_token:W[1].tok,path,content:'Z'.repeat(bytes)}}});const s=net.connect(Number(u.port),u.hostname,()=>{s.write('POST '+u.pathname+' HTTP/1.1\r\nHost: '+u.host+'\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer '+APP+'\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n');s.write(body.slice(0,Math.floor(body.length*frac)),()=>setTimeout(()=>{s.destroy();res()},200));});s.on('error',()=>res());});
for(const [i,f] of [[0,0.3],[1,0.9],[2,0.999]]){const p=P+'c4/cut-'+i+'.md';await partial(p,800000,f);await new Promise(r=>setTimeout(r,500));const r=await rd(p);rec('4c.'+i,'client killed after '+f*100+'% of an 800 KB create body: file absent or complete',r.err||(r.content||'').length>=90000,{fileExists:!r.err});}
// abort after send
{const ps=[];for(let i=0;i<20;i++){const ac=new AbortController();const p=P+'c4/abort-'+i+'.md';ps.push((async()=>{const pr=fetch(MCP,{method:'POST',signal:ac.signal,headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+APP},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'file_create',arguments:{session_token:W[2].tok,path:p,content:'A'.repeat(200000)}}})}).catch(()=>{});setTimeout(()=>ac.abort(),i*3);await pr;})());}
 await Promise.all(ps);await new Promise(r=>setTimeout(r,1500));let present=0,full=0;for(let i=0;i<20;i++){const r=await rd(P+'c4/abort-'+i+'.md');if(!r.err){present++;if(/^A+$/.test(r.content||'')&&(r.content||'').length>=90000)full++;}}
 rec('4d.abort','20 creates aborted client-side at random moments: each file absent or complete',present===full,{present,complete:full,absent:20-present});}
// 4e restart mid burst
if(!restartHub){console.log('SKIP 4e: set STRESS_RESTART_CMD');}else{const acked=new Map();const attempted=[];
 const worker=async(a,k)=>{for(let i=0;i<60;i++){const p=P+'c4/burst/w'+k+'-'+i+'.md';const c='burst '+k+' '+i+' '+'q'.repeat(2000);attempted.push(p);const r=await a.call('file_create',{path:p,content:c});if(!r.err)acked.set(p,c);}};
 const restart=(async()=>{await new Promise(r=>setTimeout(r,1500));restartHub();})();
 await Promise.all([...W.map((a,k)=>worker(a,k)),restart]);
 for(let i=0;i<40;i++){try{const r=await fetch(new URL('/health',MCP));if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,2000));}
 await new Promise(r=>setTimeout(r,3000));
 for(const a of W){await a.login().catch(()=>{});}
 let lost=0,mismatch=0,presentUnacked=0;
 for(const p of attempted){const r=await rd(p,W[0]);if(acked.has(p)){if(r.err)lost++;else if(r.content!==acked.get(p))mismatch++;}else if(!r.err){presentUnacked++;}}
 rec('4e.restart-burst','hub restarted mid write burst: every acknowledged write survives, none corrupted',lost===0&&mismatch===0,{attempted:attempted.length,acked:acked.size,ackedButMissing:lost,ackedButDifferent:mismatch,unackedButPresent:presentUnacked});}
out('c4.json',R);
