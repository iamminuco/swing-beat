import { fft, hannWindow, reflectIndex } from './stft.js';
// Features matching the author's BeatSyncEnergySpec, 32 subframes/beat, 513 bins.
export function structureFeatures(samples, sr, beats, startBeat = 0, endBeat = beats.length) {
 if(sr!==22050 || !(samples instanceof Float32Array) || samples.some(v=>!Number.isFinite(v)))throw new RangeError('Expected finite mono Float32 PCM at 22050 Hz');
 const hop=256, n=1024, bins=513, duration=samples.length/sr;
 if(samples.length<n || beats.length<2 || beats.some((t,i)=>!Number.isFinite(t)||t<0||t>=duration||(i&&t<=beats[i-1])))throw new RangeError('Invalid waveform or beat clock');
 if(!Number.isInteger(startBeat)||!Number.isInteger(endBeat)||startBeat<0||endBeat>beats.length||startBeat>=endBeat)throw new RangeError('Invalid beat window');
 // Preserve the author's duration/frame mapping and held final subbeat.
 const frames=1+Math.floor(samples.length/hop);
 const firstFrame=Math.floor(beats[startBeat]/duration*frames);
 const lastBeat=endBeat-1,lastTime=beats[lastBeat]+((beats[lastBeat+1]??beats[lastBeat])-beats[lastBeat])*31/32;
 const lastFrame=Math.floor(lastTime/duration*frames)+1;
 const spect=new Float32Array((lastFrame-firstFrame+1)*bins),window=hannWindow(n),buf=new Float64Array(n*2);
 for(let t=firstFrame;t<=Math.min(lastFrame,frames-1);t++){
  for(let k=0;k<n;k++){buf[k*2]=samples[reflectIndex(t*hop-n/2+k,samples.length)]*window[k];buf[k*2+1]=0;}
  fft(buf);for(let f=0;f<bins;f++)spect[(t-firstFrame)*bins+f]=Math.hypot(buf[2*f],buf[2*f+1]);
 }
 const out=new Float32Array((endBeat-startBeat)*32*bins);
 for(let t=0;t<(endBeat-startBeat)*32;t++){
  const b=startBeat+Math.floor(t/32),part=(t%32)/32,at=beats[b]+((beats[b+1]??beats[b])-beats[b])*part;
  const pos=at/duration*frames,left=Math.floor(pos)-firstFrame,alpha=pos-Math.floor(pos);
  for(let f=0;f<bins;f++)out[t*bins+f]=(1-alpha)*spect[left*bins+f]+alpha*spect[(left+1)*bins+f];
 }
 return out;
}
