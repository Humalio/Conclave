import {Agent,RUN} from './lib.mjs';
const P=`/vault/Stress/${RUN}/c5/churn/`;
const W=[];for(let i=1;i<=8;i++){const a=new Agent('vs-w'+i);await a.login();W.push(a);}
const end=Date.now()+40000;let n=0,errs=0;
const rd=async(a,p)=>{const r=await a.call('file_read',{path:p});return r.err?null:{rev:r.data.revision,c:r.data.content}};
const work=async(a,k)=>{let i=0;await a.call('file_create',{path:P+'own-'+k+'.md',content:''});
 while(Date.now()<end){i++;
  const own=P+'own-'+k+'.md';const r=await rd(a,own);if(r){const u=await a.call('file_update',{path:own,content:r.c+'line '+i+'\n',base_revision:r.rev});u.err?errs++:n++;}
  if(i%5===0){const t=P+'tmp-'+k+'-'+i+'.md';await a.call('file_create',{path:t,content:'t'});const rr=await rd(a,t);if(rr){if(i%10===0){await a.call('file_delete',{path:t,base_revision:rr.rev});}else{await a.call('file_rename',{from:t,to:P+'mv-'+k+'-'+i+'.md',base_revision:rr.rev});}}}
 }};
await Promise.all(W.map((a,k)=>work(a,k)));
console.log('writes ok',n,'errs',errs);
