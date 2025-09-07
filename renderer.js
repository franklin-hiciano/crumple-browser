// Image-only testbed with fisheye shader, reveal mask, and stroke-to-micro-lenses
const MAX_LENSES = 64; // bump for strokes

window.addEventListener('DOMContentLoaded', () => {
  const glc     = document.getElementById('gl');
  const hud     = document.getElementById('hud');
  const modeBtn = document.getElementById('mode');
  const baseIn  = document.getElementById('base');
  const loadImg = document.getElementById('loadImg');
  const imgPicker = document.getElementById('imgPicker');
  const revealChk = document.getElementById('reveal');
  const softIn = document.getElementById('soft');

  let mode   = 'edit'; // 'edit' | 'interact' (interact is noop here)
  let base   = +baseIn.value || 0.8;
  let soft   = +softIn.value || 1.0; // softness multiplier for reveal band
  let reveal = false;
  let lenses = [];     // {x,y,r,k} in normalized HUD space

  // Stroke temp state
  let stroking = false;
  let strokePts = []; // in canvas px
  let strokePreview = false;

  function dpr(){ return window.devicePixelRatio || 1; }

  function fit(){
    const r = document.getElementById('stage').getBoundingClientRect();
    const scale = dpr();
    glc.style.width = hud.style.width = r.width + 'px';
    glc.style.height= hud.style.height= r.height + 'px';
    glc.width = Math.max(2, Math.floor(r.width * scale));
    glc.height= Math.max(2, Math.floor(r.height * scale));
    hud.width = glc.width; hud.height = glc.height;
    drawAll();
  }
  window.addEventListener('resize', fit);

  const gl = glc.getContext('webgl2', { premultipliedAlpha:true, alpha:true, antialias:true });
  if (!gl) { alert('WebGL2 not available'); return; }

  const vs = `#version 300 es
precision highp float; layout(location=0) in vec2 a; out vec2 v; void main(){ v=a*0.5+0.5; gl_Position=vec4(a,0.,1.);} `;

  const fs = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D t;
const int MAXL=64;
uniform int LN;
uniform vec4 L[MAXL];    // xy=center (0..1), z=sigma (0..1), w=k (strength)
uniform float B;         // base compression 0.3..1.0
uniform int REVEAL;      // 0/1
uniform float SOFT;      // softness multiplier for reveal mask

vec2 baseMap(vec2 u){ float s=max(0.01,B); return (u-vec2(0.5))/s + vec2(0.5); }

// Classic gaussian fisheye per lens
vec2 lensMap(vec2 u){
  for(int i=0;i<MAXL;i++){
    if(i>=LN) break;
    vec4 P=L[i];
    vec2 d=u-P.xy;
    float r2=dot(d,d);
    float s=max(1e-5,P.z);
    float m=1.0/(1.0 + P.w*exp(-r2/(2.0*s*s)));
    u=P.xy + d*m;
  }
  return u;
}

// Reveal mask from the same circles (soft gaussian union)
float maskCircles(vec2 uv){
  float M = 0.0;
  for(int i=0;i<MAXL;i++){
    if(i>=LN) break;
    vec4 P=L[i];
    float s = max(1e-5, P.z*SOFT); // soften/harden edge by scaling sigma
    float d2 = dot(uv-P.xy, uv-P.xy);
    float m = exp(-d2/(2.0*s*s));
    M = max(M, m);
  }
  return clamp(M, 0.0, 1.0);
}

void main(){
  vec2 u=v;
  u=baseMap(u);
  u=lensMap(u);

  if(any(lessThan(u,vec2(0.)))||any(greaterThan(u,vec2(1.)))){
    o=vec4(0.,0.,0.,1.);
    return;
  }

  vec4 col = texture(t,u);

  if (REVEAL==1){
    float M = maskCircles(v); // note: mask in screen space (v), not warped u
    col.rgb *= M;
  }
  o = col;
}`;

  function sh(t,s){ const o=gl.createShader(t); gl.shaderSource(o,s); gl.compileShader(o); if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o); return o; }
  const prog=gl.createProgram(); gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs)); gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(prog); if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw gl.getProgramInfoLog(prog);
  const quad=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  const U=n=>gl.getUniformLocation(prog,n);
  const u_t=U('t'), u_LN=U('LN'), u_L0=U('L[0]'), u_B=U('B'), u_REVEAL=U('REVEAL'), u_SOFT=U('SOFT');

  let tex=null; function ensureTex(){ if(tex) return; tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); }

  const dbg={ haveTex:false, texW:0, texH:0 };

  function drawGL(){
    gl.viewport(0,0,glc.width,glc.height);
    gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    if(!tex || !dbg.haveTex) return;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u_t,0);
    const LN=Math.min(MAX_LENSES,lenses.length); gl.uniform1i(u_LN,LN);
    if(LN>0){
      const arr=new Float32Array(4*LN);
      for(let i=0;i<LN;i++){ const L=lenses[i]; arr[i*4+0]=L.x; arr[i*4+1]=1-L.y; arr[i*4+2]=L.r; arr[i*4+3]=L.k; }
      gl.uniform4fv(u_L0,arr);
    }
    gl.uniform1f(u_B, base);
    gl.uniform1i(u_REVEAL, reveal ? 1 : 0);
    gl.uniform1f(u_SOFT, soft);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  }

  const h2d=hud.getContext('2d');
  function drawHUD(){
    h2d.clearRect(0,0,hud.width,hud.height);
    h2d.font='12px system-ui'; h2d.textBaseline='top';
    h2d.fillStyle='rgba(0,0,0,.5)'; h2d.fillRect(6,6,360,44);
    h2d.fillStyle='#e5e7eb';
    h2d.fillText(`${mode.toUpperCase()} • ${lenses.length} lens${lenses.length!==1?'es':''} • ${reveal?'REVEAL':''}`, 10, 10);
    h2d.fillText(dbg.haveTex?`${dbg.texW}×${dbg.texH}`:'Tex: none',10,26);

    // Lenses
    if(mode==='edit'){
      h2d.lineWidth=1.5;
      for(const L of lenses){
        const cx=L.x*hud.width, cy=L.y*hud.height, r=L.r*Math.min(hud.width,hud.height);
        h2d.strokeStyle='rgba(167,139,250,0.9)'; h2d.beginPath(); h2d.arc(cx,cy,r,0,Math.PI*2); h2d.stroke();
        h2d.fillStyle='rgba(167,139,250,0.95)'; h2d.beginPath(); h2d.arc(cx,cy,4,0,Math.PI*2); h2d.fill();
      }
      // Stroke preview
      if (strokePreview && strokePts.length>1){
        h2d.strokeStyle='rgba(80,200,255,0.9)';
        h2d.lineWidth=2.0;
        h2d.beginPath();
        h2d.moveTo(strokePts[0].x, strokePts[0].y);
        for (let i=1;i<strokePts.length;i++) h2d.lineTo(strokePts[i].x, strokePts[i].y);
        h2d.stroke();
      }
    }
  }
  function drawAll(){ drawGL(); drawHUD(); }

  // Load bundled sample
  async function loadSample(){
    const img = new Image(); img.src='assets/sample_uvgrid.png';
    await img.decode();
    ensureTex(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
    dbg.haveTex=true; dbg.texW=img.naturalWidth; dbg.texH=img.naturalHeight;
    drawAll();
  }

  // Image picker
  loadImg.onclick = ()=> imgPicker.click();
  imgPicker.onchange = async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    ensureTex(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,bmp.width,bmp.height,0,gl.RGBA,gl.UNSIGNED_BYTE,bmp);
    dbg.haveTex=true; dbg.texW=bmp.width; dbg.texH=bmp.height;
    drawAll();
    imgPicker.value = '';
  };

  // Lens editing
  function addLens(px,py){
    lenses.push({ x:px/hud.width, y:py/hud.height, r: 160/Math.min(hud.width,hud.height), k:2.0 });
    if(lenses.length>MAX_LENSES) lenses.shift();
    drawAll();
  }
  function pickLens(px,py){
    const ux=px/hud.width, uy=py/hud.height; let bi=-1, bd=1e9;
    const thr=(14/Math.min(hud.width,hud.height))**2;
    for(let i=0;i<lenses.length;i++){
      const L=lenses[i]; const dx=L.x-ux, dy=L.y-uy; const d=dx*dx+dy*dy;
      if(d<thr && d<bd){ bd=d; bi=i; }
    }
    return bi;
  }
  function evtToCanvasPx(e){ const r=hud.getBoundingClientRect(); const scale=dpr(); return { x:(e.clientX-r.left)*scale, y:(e.clientY-r.top)*scale }; }

  let dragging=-1;
  hud.addEventListener('pointerdown', e=>{
    const p=evtToCanvasPx(e);
    if(mode==='edit'){
      // Start stroke if Alt is held
      if (e.altKey){
        stroking = true; strokePreview = true; strokePts = [p];
        e.preventDefault(); return;
      }
      if(e.shiftKey){ const i=pickLens(p.x,p.y); if(i>=0){ lenses.splice(i,1); drawAll(); } return; }
      const i=pickLens(p.x,p.y);
      if(i>=0){ dragging=i; } else { addLens(p.x,p.y); }
      e.preventDefault();
    }
  });
  window.addEventListener('pointermove', e=>{
    const p=evtToCanvasPx(e);
    if(mode==='edit'){
      if (stroking){
        const last = strokePts[strokePts.length-1];
        const dx = p.x-last.x, dy=p.y-last.y;
        if (dx*dx+dy*dy > 9){ // add if >3px movement
          strokePts.push(p);
          drawAll();
        }
      } else if (dragging>=0){
        const L=lenses[dragging]; L.x=p.x/hud.width; L.y=p.y/hud.height; drawAll();
      }
    }
  });
  window.addEventListener('pointerup', e=>{
    if(mode==='edit'){
      if (stroking){
        stroking=false;
        // Convert stroke to micro-lenses
        commitStroke();
        strokePreview=false; strokePts=[];
      }
      dragging=-1;
    }
  });

  hud.addEventListener('wheel', e=>{
    const p=evtToCanvasPx(e);
    if(mode!=='edit') return;
    const i=pickLens(p.x,p.y); if(i<0) return;
    const L=lenses[i];
    if (e.altKey){ L.k=Math.max(0,Math.min(4, L.k + (-e.deltaY*0.002))); }
    else {
      const norm=1/Math.min(hud.width,hud.height);
      L.r=Math.max(20*norm, Math.min(800*norm, L.r + (-e.deltaY*0.002)));
    }
    drawAll(); e.preventDefault();
  }, {passive:false});

  // Stroke → micro-lenses
  function commitStroke(){
    if (strokePts.length<2) { drawAll(); return; }
    // Choose spacing in canvas px relative to desired radius
    const Rpx = 140; // base radius in px (will convert to normalized below)
    const spacing = Rpx * 0.7;
    // Build resampled points along arc length
    const pts = resampleBySpacing(strokePts, spacing);
    // Create lenses along the stroke
    const minDim = Math.min(hud.width, hud.height);
    const rNorm = Rpx / minDim;
    for (const q of pts){
      lenses.push({ x:q.x/hud.width, y:q.y/hud.height, r:rNorm, k:2.0 });
      if (lenses.length > MAX_LENSES) lenses.shift();
    }
    drawAll();
  }

  function resampleBySpacing(points, spacing){
    if (points.length<=1) return points.slice();
    const out = [points[0]];
    let acc = 0;
    for (let i=1;i<points.length;i++){
      const a = out[out.length-1], b = points[i];
      const dx=b.x-a.x, dy=b.y-a.y;
      const d=Math.hypot(dx,dy);
      if (d+acc >= spacing){
        const t=(spacing-acc)/d;
        const nx=a.x+dx*t, ny=a.y+dy*t;
        out.push({x:nx, y:ny});
        acc = 0;
      } else {
        acc += d;
      }
    }
    if (out[out.length-1] !== points[points.length-1]) out.push(points[points.length-1]);
    return out;
  }

  // UI
  modeBtn.onclick = ()=>{ mode = (mode==='edit') ? 'interact' : 'edit'; modeBtn.textContent = (mode==='edit') ? 'Edit' : 'Interact'; drawHUD(); };
  baseIn.oninput   = ()=>{ base = +baseIn.value; drawAll(); };
  revealChk.onchange = ()=>{ reveal = revealChk.checked; drawAll(); };
  softIn.oninput   = ()=>{ soft = +softIn.value; drawAll(); };

  // Boot
  fit();
  loadSample();
});
