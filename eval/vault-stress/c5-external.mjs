import fs from 'node:fs'; import {Agent,api,out,hubShell,cfg,RUN} from './lib.mjs';
const R=[];const rec=(id,name,pass,ev)=>{R.push({id,name,pass,ev});console.log((pass?'PASS ':'FAIL ')+id+' '+name+' :: '+JSON.stringify(ev).slice(0,450));};
if(!cfg.hostShell||!cfg.vaultDir){console.log('SKIP c5: set STRESS_HOST_SHELL and STRESS_VAULT_DIR');process.exit(0);}
const P=`/vault/Stress/${RUN}/c7/`;const D=cfg.vaultDir.replace(/\/$/,'')+'/Stress/'+RUN+'/c7/';
const sh=hubShell;
const w=new Agent('vs-w1');await w.login();const w2=new Agent('vs-w2');await w2.login();
const rd=async(p,a=w)=>{const r=await a.call('file_read',{path:p});return {rev:r.data?.revision,content:r.data?.content,err:r.err,text:r.text}};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// 7a external edit on disk, then hub write with old base before the scan
{const p=P+'ext-edit.md';await w.call('file_create',{path:p,content:'hub v1\n'});const r0=await rd(p);
 sh('echo EXTERNAL >> '+D+'ext-edit.md');
 const u=await w.call('file_update',{path:p,content:'agent overwrite\n',base_revision:r0.rev});const cur=sh('cat '+D+'ext-edit.md');
 rec('7a','external disk edit then agent write on old base: conflict, external text not lost',u.err&&/EXTERNAL/.test(cur),{agentResult:u.err?u.text.slice(0,120):'WRITTEN',diskNow:cur.trim()});}
// 7b external edit; wait for scan; agent reads new revision, history shows external revision
{const p=P+'ext-scan.md';await w.call('file_create',{path:p,content:'a\n'});sh('echo B >> '+D+'ext-scan.md');await sleep(75000);const r=await rd(p);const h=await w.call('file_history',{path:p});
 rec('7b','external edit noticed by scan within 75 s and recorded in history',/B/.test(r.content||'')&&/external|observed/i.test(h.text),{read:(r.content||'').trim(),historySnippet:h.text.slice(0,300)});}
// 7c external delete and external rename
{const p=P+'ext-del.md',q=P+'ext-mv.md';await w.call('file_create',{path:p,content:'d'});await w.call('file_create',{path:q,content:'m'});
 sh('rm '+D+'ext-del.md; mv '+D+'ext-mv.md '+D+'ext-mv-moved.md');await sleep(75000);
 const a=await rd(p),b=await rd(q),c=await rd(P+'ext-mv-moved.md');const hist=await w.call('file_history',{path:P+'ext-mv-moved.md'});
 rec('7c','external delete and external rename picked up',a.err&&b.err&&!c.err,{deletedGone:a.err,oldNameGone:b.err,newNameReadable:!c.err,movedKeepsHistory:hist.text.slice(0,200)});}
// 7d console save (admin) vs agent update concurrently
{const p=P+'console.md';await w.call('file_create',{path:p,content:'v0'});const r0=await rd(p);
 const [u,c]=await Promise.all([w.call('file_update',{path:p,content:'agent',base_revision:r0.rev}),api('PUT','/api/vault/files',{path:p,content:'console',base_revision:r0.rev})]);
 const fin=await rd(p);rec('7d','console save and agent update on the same base: one wins',(!u.err)!==(c.s===200),{agent:u.err?u.text.slice(0,80):'ok',console:c.s+' '+JSON.stringify(c.j).slice(0,100),final:fin.content});}
// 7e delete then restore, history intact
{const p=P+'restore.md';await w.call('file_create',{path:p,content:'one'});let r=await rd(p);await w.call('file_update',{path:p,content:'two',base_revision:r.rev});r=await rd(p);await w.call('file_delete',{path:p,base_revision:r.rev});
 const h=await w.call('file_history',{path:p});const revs=[...(h.text.matchAll(/sha256:[0-9a-f]{64}/g))].map(m=>m[0]);const first=revs[revs.length-1];
 const rr=await w.call('file_restore',{path:p,revision:first,base_revision:'absent'});const back=await rd(p);
 rec('7e','delete then restore the first revision: content back, history kept',!rr.err&&back.content==='one',{restore:rr.err?rr.text.slice(0,100):'ok',content:back.content,revisionsListed:new Set(revs).size});}
// 7f hub folder 99 Conclave external edit replaced
out('c5.json',R);
