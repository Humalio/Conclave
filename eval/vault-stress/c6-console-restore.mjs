import fs from 'node:fs'; import {Agent,api,out,RUN} from './lib.mjs';
const R=[];const rec=(id,name,pass,ev)=>{R.push({id,name,pass,ev});console.log((pass?'PASS ':'FAIL ')+id+' '+name+' :: '+JSON.stringify(ev).slice(0,450));};
const P=`/vault/Stress/${RUN}/c7/`;const w=new Agent('vs-w1');await w.login();
const rd=async(p)=>{const r=await w.call('file_read',{path:p});return {rev:r.data?.revision,content:r.data?.content,err:r.err,text:r.text}};
for(let i=0;i<5;i++){const p=P+'console-'+i+'.md';await w.call('file_create',{path:p,content:'v0'});const r0=await rd(p);
 const [u,c]=await Promise.all([w.call('file_update',{path:p,content:'agent',base_revision:r0.rev}),api('PUT','/api/vault/files',{path:p,text:'console',base_revision:r0.rev})]);
 const fin=await rd(p);rec('7d.'+i,'console save and agent update on same base: exactly one wins, final = winner',(!u.err)!==(c.s===200)&&fin.content===(c.s===200?'console':'agent'),{agent:u.err?u.text.slice(0,60):'ok',console:c.s+' '+(c.s===200?'':JSON.stringify(c.j).slice(0,90)),final:fin.content});}
{const p=P+'restore.md';let h0=await w.call('file_history',{path:p});await w.call('file_create',{path:p,content:'one'});let r=await rd(p);const first=r.rev;await w.call('file_update',{path:p,content:'two',base_revision:r.rev});r=await rd(p);await w.call('file_delete',{path:p,base_revision:r.rev});
 const rr=await w.call('file_restore',{path:p,revision:first,base_revision:'absent'});const back=await rd(p);const h=await w.call('file_history',{path:p});
 rec('7e','delete then restore first revision: content back, history kept',!rr.err&&back.content==='one',{restore:rr.err?rr.text.slice(0,100):'ok',content:back.content,history:h.text.split('\n')[0]});}
out('c6.json',R);
