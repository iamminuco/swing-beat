// Conditional structure inference for 4/4: hierarchy boundary candidates, separate from continuous counts.
// Levels have nominal binary spans; the decoder permits shorter/longer groups.
// Ports music-x-lab's fixed ternary hierarchy decoder; no audio or ground truth inputs.
function logsumexp(a) { const m=Math.max(...a); return m+Math.log(a.reduce((s,v)=>s+Math.exp(v-m),0)); }
function transition() {
 const layers=4,n=3**layers,levels=[],digits=[];
 for(let z=0;z<n;z++) { let v=z,level=0;while(level<layers && z%(3**(level+1))===0)level++;levels.push(level);const d=[];for(let i=0;i<layers;i++){d.push(v%3);v=Math.floor(v/3)}digits.push(d); }
 const mat=Array.from({length:n},()=>new Float64Array(n));
 const del=[-5,-4,-3,-2],ins=[-8,-7,-6,-5];
 for(let a=0;a<n;a++)for(let b=0;b<n;b++) {let cleared=true,p=0;for(let i=0;i<layers;i++){const u=digits[a][i],v=digits[b][i];if(cleared){if(u===0&&v===0)p+=del[i];else if(u===v || (u===0&&v===2) || (u===2&&v===1))p=-Infinity;else if(u===1&&v===2)p+=ins[i];}else if(u!==v)p=-Infinity;if(v!==0)cleared=false;}mat[a][b]=p;}
 return {mat,levels};
}
const {mat,levels}=transition();
export function decodeStructure(logp, beatTimes, barPhase) {
 if(!Array.isArray(beatTimes)||!beatTimes.length||beatTimes.some((t,i)=>!Number.isFinite(t)||t<0||(i&&t<=beatTimes[i-1])))throw new RangeError('Expected ordered beat times');
 if(logp instanceof Float32Array) {
   if(logp.length!==beatTimes.length*4*9)throw new RangeError('Invalid flat model output size');
   const flat=logp;logp=Array.from({length:beatTimes.length*4},(_,i)=>flat.subarray(i*9,(i+1)*9));
 }
 if(!Array.isArray(logp)||logp.length!==beatTimes.length*4||logp.some(r=>r.length!==9||r.some(v=>!Number.isFinite(v))))throw new RangeError('Expected four 9-class model frames per beat');
 if(!Number.isInteger(barPhase)||barPhase<0||barPhase>=4||barPhase>=beatTimes.length)throw new RangeError('Invalid bar phase');
 const combined=logp.map(r=>[logsumexp(r.slice(0,5)),...r.slice(5)]),ix=[];
 for(let i=barPhase;i<beatTimes.length;i+=4)ix.push(i);
 const obs=ix.map(i=>Array.from({length:5},(_,j)=>{
   let best=-Infinity;for(let k=Math.max(0,i*4-2);k<=Math.min(combined.length-1,i*4+2);k++)best=Math.max(best,combined[k][j]);return best;
 }));
 const n=levels.length,back=obs.map(()=>new Int16Array(n));let previous=new Float64Array(n);
 for(let t=0;t<obs.length;t++){const next=new Float64Array(n);for(let b=0;b<n;b++){let best=0,value=t===0?0:-Infinity;if(t>0)for(let a=0;a<n;a++){const v=previous[a]+mat[a][b];if(v>value){value=v;best=a}}back[t][b]=best;next[b]=value+obs[t][levels[b]];}previous=next;}
 let state=0;for(let i=1;i<n;i++)if(previous[i]>previous[state])state=i;
 const decoded=new Array(obs.length);for(let t=obs.length-1;t>=0;t--){decoded[t]=levels[state];state=back[t][state];}
 const bars=ix.map((i,j)=>({beat:i,time:beatTimes[i],level:decoded[j]}));
 return {bars,twoBarCandidates:bars.filter(b=>b.level>=1),level3Candidates:bars.filter(b=>b.level>=3)};
}
