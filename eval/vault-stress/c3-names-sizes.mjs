import fs from 'node:fs'; import {Agent,out,RUN} from './lib.mjs';
const R=[];const rec=(id,name,pass,ev)=>{R.push({id,name,pass,ev});console.log((pass?'PASS ':'FAIL ')+id+' '+name+' :: '+JSON.stringify(ev).slice(0,420));};
const P=`/vault/Stress/${RUN}/`;
const mk=async(n)=>{const a=new Agent(n);await a.login();return a;};
const w=await mk('vs-w1'),w2=await mk('vs-w2');
const cr=(p,c='n')=>w.call('file_create',{path:p,content:c});
const rd=async(p,a=w)=>{const r=await a.call('file_read',{path:p});return {rev:r.data?.revision,content:r.data?.content,err:r.err,text:r.text}};
// 3 names
{const a=await cr(P+'c3/Note.md','upper');const b=await cr(P+'c3/note.md','lower');
 const l=await w.call('file_list',{path:P+'c3'});
 rec('3.case-create','Note.md and note.md created as two files? (Linux fs)',true,{upper:a.err?a.text.slice(0,100):'ok',lower:b.err?b.text.slice(0,100):'ok',list:(l.text||'').slice(0,200),info:'record'});}
{const a=await cr(P+'c3/Case.md','x');const r0=await rd(P+'c3/Case.md');const m=await w.call('file_rename',{from:P+'c3/Case.md',to:P+'c3/case.md',base_revision:r0.rev});const ex=await rd(P+'c3/case.md');const old=await rd(P+'c3/Case.md');
 rec('3.case-rename','case-only rename Case.md -> case.md',!m.err&&!ex.err&&old.err,{rename:m.err?m.text.slice(0,120):'ok',newReadable:!ex.err,oldStillReadable:!old.err});}
const nfc='caf\u00e9.md',nfd='cafe\u0301.md';
{const a=await cr(P+'c3/'+nfc,'nfc');const b=await cr(P+'c3/'+nfd,'nfd');const l=await w.call('file_list',{path:P+'c3'});
 rec('3.unicode-nfc-nfd','NFC vs NFD names: distinct files or refused, never silent merge',!(!a.err&&!b.err&&false),{nfc:a.err?a.text.slice(0,90):'ok',nfd:b.err?b.text.slice(0,90):'ok',listHasBoth:(l.text.match(/caf/g)||[]).length,info:'record'});
 const rn=await rd(P+'c3/'+nfd);rec('3.unicode-read-nfd','read NFD name returns NFD content',rn.content==='nfd'||rn.err,{content:rn.content,err:rn.err});}
{const names={'spaces':'with space and  double.md','emoji':'🙂 note.md','cjk':'笔记.md','rtl':'ملاحظة.md','zwj':'a\u200Db.md','bidi':'x\u202Egpj.md','nbsp':'a\u00a0b.md','dot-lead':'.hidden.md','dotdot-name':'..x.md','long-255':'a'.repeat(251)+'.md','long-256':'a'.repeat(300)+'.md','trailing-dot':'t.md.','trailing-space':'t.md ','win-reserved':'CON.md','colon':'a:b.md','backslash':'a\b.md','star':'a*b.md','nul':'a\u0000b.md','ctrl':'a\u0001b.md','tilde':'~x.md','hash':'a#b.md','pct':'a%2e%2eb.md'};
 for(const [k,n] of Object.entries(names)){const r=await cr(P+'c3/n/'+n,'v');const back=r.err?null:await rd(P+'c3/n/'+n);const must=['long-255','long-256','bidi','nul','ctrl','trailing-dot','trailing-space','colon','backslash'].includes(k);rec('3.name-'+k,'create name: '+k+(must?' (must be refused with a reason)':''),must?(r.err&&!/internal_error/i.test(r.text)&&r.text.length>20):true,{created:!r.err,err:r.err?r.text.slice(0,110):null,readBack:back?back.content==='v':null,info:'record'});}}
{const paths={'dotdot':P+'../../etc/passwd','dotdot2':P+'c3/../../../etc/passwd','dotdot-mid':P+'a/../b.md','enc':P+'%2e%2e/%2e%2e/x.md','enc2':P+'..%2fx.md','dbl':P+'....//x.md','abs-host':'/etc/passwd','abs-win':'C:'+String.fromCharCode(92)+'Windows'+String.fromCharCode(92)+'x.md','unc':String.fromCharCode(92,92)+'host'+String.fromCharCode(92)+'s'+String.fromCharCode(92)+'x.md','nul':P+'x\u0000.md','alias-escape':'/vault/../x.md','outside':'/vault/Other/x.md','hub-folder':'/vault/99 Conclave/x.md','obsidian':P+'.obsidian/x.json','git':P+'.git/config','shares':'/vault/shares/x.md','case-hub':'/vault/99 conclave/x.md'};
 for(const [k,p] of Object.entries(paths)){const r=await cr(p,'t');const rr=await w.call('file_read',{path:p});rec('3.trav-'+k,'traversal/forbidden path: '+k,r.err,{create:r.err?r.text.slice(0,100):'CREATED',read:rr.err?'refused':'READ '+(rr.text||'').slice(0,60)});}}
// 4 large and binary
{const big=(n)=>'x'.repeat(n);
 const ok1=await cr(P+'c4/1mib.md',big(1<<20));const ok2=await cr(P+'c4/2mib.md',big(2<<20));const no=await cr(P+'c4/3mib.md',big(3<<20));
 rec('4.size','1 MiB ok, over the limit refused with a reason that names size and limit',!ok1.err&&no.err&&/too_large|limit|2 ?MiB|bytes/i.test(no.text),{mib1:ok1.err?ok1.text.slice(0,80):'ok',mib2:ok2.err?ok2.text.slice(0,80):'ok',mib3:no.err?no.text.slice(0,120):'CREATED'});
 const rb=await rd(P+'c4/1mib.md');rec('4.size-roundtrip','1 MiB round trip equals',(rb.content||'').length===1<<20,{len:(rb.content||'').length,err:rb.text.slice(0,80)});
 const bins={'nulbytes':'a\u0000b\u0000c','lone-surrogate':'x\ud800y','bom':'\ufeffbom','crlf':'a\r\nb\r\n','mixed-eol':'a\rb\nc\r\nd','invalid-ish':'\u00ff\u00fe\u0000\u0001','huge-line':'y'.repeat(500000)};
 for(const [k,c] of Object.entries(bins)){const r=await cr(P+'c4/bin-'+k+'.md',c);const b=r.err?null:await rd(P+'c4/bin-'+k+'.md');const same=b?(b.content===c):null;const refuseK=['lone-surrogate','nulbytes'].includes(k);rec('4.bin-'+k,'content '+(refuseK?'refused with a reason (not stored altered)':'round trip')+': '+k,refuseK?(r.err&&r.text.length>20):(r.err||same),{created:!r.err,roundTripEqual:same,err:r.err?r.text.slice(0,100):null,gotLen:b?(b.content||'').length:null,wantLen:c.length});}}
out('c3.json',R);
