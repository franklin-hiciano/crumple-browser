const MAX_LENSES = 16;
window.addEventListener('DOMContentLoaded', () => {
  const glc = document.getElementById('gl');
  const hud = document.getElementById('hud');
  const modeBtn = document.getElementById('mode');
  const baseIn = document.getElementById('base');
  const loadImg = document.getElementById('loadImg');
  const imgPicker = document.getElementById('imgPicker');

  let mode='edit', base=+baseIn.value||0.8, lenses=[];
  function dpr(){ return window.devicePixelRatio||1; }
  function fit(){ const r=document.getElementById('stage').getBoundingClientRect(); const scale=dpr(); glc.style.width=hud.style.width=r.width+'px'; glc.style.height=hud.style.height=r.height+'px'; glc.width=Math.max(2,Math.floor(r.width*scale)); glc.height=Math.max(2,Math.floor(r.height*scale)); hud.width=glc.width; hud.height=glc.height; drawAll(); }
  window.addEventListener('resize', fit);

  const gl=glc.getContext('webgl2',{premultipliedAlpha:true,alpha:true,antialias:true}); if(!gl){ alert('WebGL2 not available'); return; }
  const vs=`#version 300 es
precision highp float; layout(location=0) in vec2 a; out vec2 v; void main(){ v=a*0.5+0.5; gl_Position=vec4(a,0.,1.);} `;
  const fs=`#version 300 es
precision highp float; in vec2 v; out vec4 o; uniform sampler2D t; const int MAXL=16; uniform int LN; uniform vec4 L[MAXL]; uniform float B;
vec2 baseMap(vec2 u){ float s=max(0.01,B); return (u-vec2(0.5))/s + vec2(0.5);} vec2 lensMap(vec2 u){ for(int i=0;i<MAXL;i++){ if(i>=LN) break; vec4 P=L[i]; vec2 d=u-P.xy; float r2=dot(d,d); float s=max(1e-5,P.z); float m=1./(1.+P.w*exp(-r2/(2.*s*s))); u=P.xy + d*m; } return u; }
void main(){ vec2 u=v; u=baseMap(u); u=lensMap(u); if(any(lessThan(u,vec2(0.)))||any(greaterThan(u,vec2(1.)))) o=vec4(0.,0.,0.,1.); else o=texture(t,u); }`;
  function sh(t,s){ const o=gl.createShader(t); gl.shaderSource(o,s); gl.compileShader(o); if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o); return o; }
  const prog=gl.createProgram(); gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs)); gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(prog); if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw gl.getProgramInfoLog(prog);
  const quad=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,quad); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  const U=n=>gl.getUniformLocation(prog,n); const u_t=U('t'), u_LN=U('LN'), u_L0=U('L[0]'), u_B=U('B');

  let tex=null; function ensureTex(){ if(tex) return; tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); }
  const dbg={haveTex:false, texW:0, texH:0};

  function drawGL(){ gl.viewport(0,0,glc.width,glc.height); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); if(!tex||!dbg.haveTex) return; gl.useProgram(prog); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tex); gl.uniform1i(u_t,0); const LN=Math.min(MAX_LENSES,lenses.length); gl.uniform1i(u_LN,LN); if(LN>0){ const arr=new Float32Array(4*LN); for(let i=0;i<LN;i++){ const L=lenses[i]; arr[i*4+0]=L.x; arr[i*4+1]=1-L.y; arr[i*4+2]=L.r; arr[i*4+3]=L.k; } gl.uniform4fv(u_L0,arr);} gl.uniform1f(u_B,base); gl.drawArrays(gl.TRIANGLE_STRIP,0,4); }
  const h2d=hud.getContext('2d');
  function drawHUD(){ h2d.clearRect(0,0,hud.width,hud.height); h2d.font='12px system-ui'; h2d.textBaseline='top'; h2d.fillStyle='rgba(0,0,0,.5)'; h2d.fillRect(6,6,220,44); h2d.fillStyle='#e5e7eb'; h2d.fillText(`${mode.toUpperCase()} • ${lenses.length} lens${lenses.length!==1?'es':''}`,10,10); h2d.fillText(dbg.haveTex?`${dbg.texW}×${dbg.texH}`:'Tex: none',10,26); if(mode!=='edit') return; h2d.lineWidth=1.5; for(const L of lenses){ const cx=L.x*hud.width, cy=L.y*hud.height, r=L.r*Math.min(hud.width,hud.height); h2d.strokeStyle='rgba(167,139,250,0.9)'; h2d.beginPath(); h2d.arc(cx,cy,r,0,Math.PI*2); h2d.stroke(); h2d.fillStyle='rgba(167,139,250,0.95)'; h2d.beginPath(); h2d.arc(cx,cy,4,0,Math.PI*2); h2d.fill(); } }
  function drawAll(){ drawGL(); drawHUD(); }

  async function loadSample(){ const img=new Image(); img.src='assets/sample_uvgrid.png'; await img.decode(); ensureTex(); gl.bindTexture(gl.TEXTURE_2D,tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img); dbg.haveTex=true; dbg.texW=img.naturalWidth; dbg.texH=img.naturalHeight; drawAll(); }
  loadImg.onclick=()=>imgPicker.click();
  imgPicker.onchange=async (e)=>{ const f=e.target.files?.[0]; if(!f) return; const bmp=await createImageBitmap(f); ensureTex(); gl.bindTexture(gl.TEXTURE_2D,tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,bmp.width,bmp.height,0,gl.RGBA,gl.UNSIGNED_BYTE,bmp); dbg.haveTex=true; dbg.texW=bmp.width; dbg.texH=bmp.height; drawAll(); imgPicker.value=''; };

  function addLens(px,py){ lenses.push({ x:px/hud.width, y:py/hud.height, r:160/Math.min(hud.width,hud.height), k:2.0 }); if(lenses.length>MAX_LENSES) lenses.shift(); drawAll(); }
  function pickLens(px,py){ const ux=px/hud.width, uy=py/hud.height; let bi=-1, bd=1e9; const thr=(14/Math.min(hud.width,hud.height))**2; for(let i=0;i<lenses.length;i++){ const L=lenses[i]; const dx=L.x-ux, dy=L.y-uy; const d=dx*dx+dy*dy; if(d<thr && d<bd){ bd=d; bi=i; } } return bi; }
  function evtToCanvasPx(e){ const r=hud.getBoundingClientRect(); const scale=dpr(); return { x:(e.clientX-r.left)*scale, y:(e.clientY-r.top)*scale }; }

  let dragging=-1;
  hud.addEventListener('pointerdown', e=>{ const p=evtToCanvasPx(e); if(mode==='edit'){ if(e.shiftKey){ const i=pickLens(p.x,p.y); if(i>=0){ lenses.splice(i,1); drawAll(); } return; } const i=pickLens(p.x,p.y); if(i>=0){ dragging=i; } else { addLens(p.x,p.y); } e.preventDefault(); } });
  window.addEventListener('pointermove', e=>{ if(mode==='edit' && dragging>=0){ const p=evtToCanvasPx(e); const L=lenses[dragging]; L.x=p.x/hud.width; L.y=p.y/hud.height; drawAll(); } });
  window.addEventListener('pointerup', e=>{ dragging=-1; });
  hud.addEventListener('wheel', e=>{ if(mode!=='edit') return; const p=evtToCanvasPx(e); const i=pickLens(p.x,p.y); if(i<0) return; const L=lenses[i]; if(e.altKey){ L.k=Math.max(0,Math.min(4, L.k + (-e.deltaY*0.002))); } else { const norm=1/Math.min(hud.width,hud.height); L.r=Math.max(20*norm, Math.min(800*norm, L.r + (-e.deltaY*0.002))); } drawAll(); e.preventDefault(); }, {passive:false});

  modeBtn.onclick=()=>{ mode=(mode==='edit')?'interact':'edit'; modeBtn.textContent=(mode==='edit')?'Edit':'Interact'; drawHUD(); };
  baseIn.oninput=()=>{ base=+baseIn.value; drawAll(); };

  fit(); loadSample();
});
