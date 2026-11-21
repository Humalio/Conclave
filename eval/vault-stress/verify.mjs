// runs inside the demo hub container: node /tmp/vs-verify.mjs [prefix]
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import {DatabaseSync} from 'node:sqlite';
const prefix=process.argv[2]||'Stress';const root='/vault';
const db=new DatabaseSync('/data/agent-hub.db',{readOnly:true});
const disk=new Map();const tmp=[];
(function walk(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){const rel=path.relative(root,p).split(path.sep).join('/');if(/\.hub-tmp$/.test(e.name))tmp.push(rel);else{const b=fs.readFileSync(p);disk.set(rel,'sha256:'+crypto.createHash('sha256').update(b).digest('hex'))}}}})(path.join(root,prefix));
const rows=db.prepare("select id,path,current_revision,deleted_at from files where (path like ? or path=?)").all(prefix+'/%',prefix);
const live=new Map();const dup=[];for(const r of rows){if(r.deleted_at!=null||r.current_revision==null)continue;if(live.has(r.path))dup.push(r.path);live.set(r.path,r)}
const orphans=[...disk.keys()].filter(k=>!live.has(k));
const missing=[...live.keys()].filter(k=>!disk.has(k));
const mism=[...live.keys()].filter(k=>disk.has(k)&&disk.get(k)!==live.get(k).current_revision);
const noRev=[];for(const r of live.values()){const n=db.prepare('select count(*) c from file_revisions where file_id=?').get(r.id).c;if(!n)noRev.push(r.path)}
const lower=new Map();const caseDup=[];for(const k of live.keys()){const l=k.toLowerCase();if(lower.has(l))caseDup.push([lower.get(l),k]);else lower.set(l,k)}
const intents=(()=>{try{return db.prepare("select count(*) c from write_intents").get().c}catch(e){return 'n/a'}})();
console.log(JSON.stringify({disk:disk.size,indexLive:live.size,tmpLeft:tmp,orphansOnDisk:orphans,indexMissingOnDisk:missing,hashMismatch:mism,duplicateLiveRows:dup,liveRowsWithoutRevision:noRev,caseDuplicates:caseDup,openIntents:intents,revisionsTotal:db.prepare('select count(*) c from file_revisions').get().c},null,1));
