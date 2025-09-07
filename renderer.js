// Multi-window Crumple — click board to create tiles; per-tile shader warp with live capture
const MAX_LENSES = 16;
const LIVE_FPS = 20;

window.addEventListener('DOMContentLoaded', () => {
  const board = document.getElementById('board');
  const palette = document.getElementById('palette');
  const urlIn = document.getElementById('urlIn');

  const modeBtn = document.getElementById('mode');
  const baseIn  = document.getElementById('base');
  const liveChk = document.getElementById('live');
  const newBtn  = document.getElementById('new');

  let globalMode = 'edit';  // applied to focused tile
  let zCounter = 10;
  let tiles = [];
  let pendingCreate = null; // {x,y} origin for new tile
  let focused = null;

  function dpr(){ return window.devicePixelRatio || 1; }

  // ----- Palette (click board to place new tile) -----
  function openPalette(x,y){
    pendingCreate = { x, y };
    palette.style.left = Math.round(x - 170) + 'px';
    palette.style.top  = Math.round(y - 24) + 'px';
    palette.classList.remove('hidden');
    urlIn.value = '';
    urlIn.focus();
  }
  function closePalette(){ palette.classList.add('hidden'); pendingCreate = null; }
  urlIn.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape') { closePalette(); }
    if (e.key === 'Enter') {
      const v = urlIn.value.trim();
      if (!v) return;
      let url = v.match(/^https?:\/\//i) ? v : 'https://' + v;
      const x = (pendingCreate?.x ?? 140) - 210; // default 420w
      const y = (pendingCreate?.y ?? 140) - 160; // default 320h
      closePalette();
      createTile({ url, x:Math.max(8,x), y:Math.max(46,y), w:420, h:320 });
    }
  });

  board.addEventListener('mousedown', (e)=>{
    if (e.target === board) openPalette(e.clientX, e.clientY);
  });
  newBtn.onclick = ()=>{ board.focus(); }; // hint to click board

  // ----- Tile class -----
  class Tile {
    constructor({url, x, y, w, h}){
      this.url = url || 'https://example.org';
      this.x=x||80; this.y=y||80; this.w=w||480; this.h=h||360;
      this.z = ++zCounter;
      this.mode = globalMode; // 'edit'|'interact'
      this.base = +baseIn.value || 0.70;
      this.live = !!liveChk.checked;
      this.lenses = []; this.dragging = -1;
      this.forwarding = { active:false };
      this.wcId = null;
      this.dbg = { haveTex:false, texW:0, texH:0, lastSnap:0 };

      this._buildDOM();
      this._initGL();
      this._bindEvents();
      this._fit();
      this.load(this.url);
      this.setLive(this.live);
      this.focus();
    }

    _buildDOM(){
      const el = document.createElement('div');
      el.className = 'tile';
      el.style.left = this.x+'px'; el.style.top=this.y+'px';
      el.style.width = this.w+'px'; el.style.height=this.h+'px';
      el.style.zIndex = this.z;

      const title = document.createElement('div');
      title.className = 'titlebar';
      const urlSpan = document.createElement('div'); urlSpan.className='url'; urlSpan.textContent = this.url;
      const closeBtn = document.createElement('button'); closeBtn.className='btn'; closeBtn.textContent='✕';
      const modeBtn = document.createElement('button'); modeBtn.className='btn'; modeBtn.textContent='E';
      title.append(urlSpan, modeBtn, closeBtn);

      const view = document.createElement('div');
      view.className = 'view';
      const webview = document.createElement('webview');
      webview.allowpopups = true;
      webview.src = this.url;
      webview.setAttribute('disableblinkfeatures','Auxclick');
      const gl = document.createElement('canvas'); gl.className='gl';
      const hud = document.createElement('canvas'); hud.className='hud'; hud.setAttribute('oncontextmenu','return false');

      const hNW = document.createElement('div'); hNW.className='handle nw';
      const hNE = document.createElement('div'); hNE.className='handle ne';
      const hSW = document.createElement('div'); hSW.className='handle sw';
      const hSE = document.createElement('div'); hSE.className='handle se';

      view.append(webview, gl, hud);
      el.append(title, view, hNW, hNE, hSW, hSE);
      board.appendChild(el);

      this.el=el; this.title=title; this.urlSpan=urlSpan; this.modeBtn=modeBtn; this.closeBtn=closeBtn;
      this.view=view; this.webview=webview; this.glc=gl; this.hud=hud;
      this.hNW=hNW; this.hNE=hNE; this.hSW=hSW; this.hSE=hSE;
    }

    _initGL(){
      const gl = this.glc.getContext('webgl2', { premultipliedAlpha:true, alpha:true, antialias:true });
      if (!gl) { alert('WebGL2 not available'); return; }
      this.gl = gl;
      const vs = `#version 300 es
precision highp float; layout(location=0) in vec2 a; out vec2 v; void main(){ v=a*0.5+0.5; gl_Position=vec4(a,0.,1.);} `;
      const fs = `#version 300 es
precision highp float; in vec2 v; out vec4 o; uniform sampler2D t; const int MAXL=16; uniform int LN; uniform vec4 L[MAXL]; uniform float B;
vec2 baseMap(vec2 u){ float s=max(0.01,B); return (u-vec2(0.5))/s + vec2(0.5);} vec2 lensMap(vec2 u){ for(int i=0;i<MAXL;i++){ if(i>=LN) break; vec4 P=L[i]; vec2 d=u-P.xy; float r2=dot(d,d); float s=max(1e-5,P.z); float m=1./(1.+P.w*exp(-r2/(2.*s*s))); u=P.xy + d*m; } return u; }
void main(){ vec2 u=v; u=baseMap(u); u=lensMap(u); if(any(lessThan(u,vec2(0.)))||any(greaterThan(u,vec2(1.)))) o=vec4(0.,0.,0.,1.); else o=texture(t,u); }`;
      const sh=(t,s)=>{const o=gl.createShader(t); gl.shaderSource(o,s); gl.compileShader(o); if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o); return o;};
      const prog=gl.createProgram(); gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs)); gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(prog); if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw gl.getProgramInfoLog(prog);
      this.prog=prog; gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
      const U = n=>gl.getUniformLocation(prog,n);
      this.u_t=U('t'); this.u_LN=U('LN'); this.u_L0=U('L[0]'); this.u_B=U('B');
      this.tex=null;
    }

    _bindEvents(){
      // focus/z-order
      this.el.addEventListener('mousedown', ()=> this.focus());

      // title drag
      let dragging=false, dx=0, dy=0;
      this.title.addEventListener('mousedown', (e)=>{
        this.focus(); dragging=true; dx=e.clientX - this.x; dy=e.clientY - this.y; e.preventDefault();
      });
      window.addEventListener('mousemove', (e)=>{
        if(!dragging) return;
        this.x = Math.round(e.clientX - dx);
        this.y = Math.round(e.clientY - dy);
        this._place();
      });
      window.addEventListener('mouseup', ()=> dragging=false);

      // close
      this.closeBtn.onclick = ()=> this.destroy();

      // local mode toggle
      this.modeBtn.onclick = ()=>{ this.toggleMode(); };

      // resize handles
      const rs = (corner)=>{
        let rz=false, sx=0, sy=0, ox=0, oy=0, ow=0, oh=0;
        const onDown=(e)=>{ this.focus(); rz=true; sx=e.clientX; sy=e.clientY; ox=this.x; oy=this.y; ow=this.w; oh=this.h; e.preventDefault(); };
        const onMove=(e)=>{
          if(!rz) return;
          const dx=e.clientX - sx, dy=e.clientY - sy;
          if (corner==='se'){ this.w=Math.max(260, ow+dx); this.h=Math.max(200, oh+dy); }
          if (corner==='sw'){ this.x=Math.round(ox+dx); this.w=Math.max(260, ow-dx); this.h=Math.max(200, oh+dy); }
          if (corner==='ne'){ this.y=Math.round(oy+dy); this.h=Math.max(200, oh-dy); this.w=Math.max(260, ow+dx); }
          if (corner==='nw'){ this.x=Math.round(ox+dx); this.y=Math.round(oy+dy); this.w=Math.max(260, ow-dx); this.h=Math.max(200, oh-dy); }
          this._place(); this._fit();
        };
        const onUp=()=> rz=false;
        return { onDown, onMove, onUp };
      };
      const HSE = rs('se'), HSW=rs('sw'), HNE=rs('ne'), HNW=rs('nw');
      this.hSE.addEventListener('mousedown', HSE.onDown);
      this.hSW.addEventListener('mousedown', HSW.onDown);
      this.hNE.addEventListener('mousedown', HNE.onDown);
      this.hNW.addEventListener('mousedown', HNW.onDown);
      window.addEventListener('mousemove', (e)=>{ HSE.onMove(e); HSW.onMove(e); HNE.onMove(e); HNW.onMove(e); });
      window.addEventListener('mouseup', (e)=>{ HSE.onUp(e); HSW.onUp(e); HNE.onUp(e); HNW.onUp(e); });

      // webview events
      this.webview.addEventListener('dom-ready', () => {
        try { this.wcId = this.webview.getWebContentsId(); } catch {}
        if (this.live) this.snap(); // first frame
      });
      this.webview.addEventListener('did-stop-loading', () => {
        if (this.live) setTimeout(()=>this.snap(), 50);
        this.urlSpan.textContent = this.webview.getURL();
      });

      // HUD interactions
      const hud = this.hud;
      hud.addEventListener('pointerdown', (e)=>{
        const p = this._evtToCanvasPx(e);
        if (this.mode === 'edit'){
          if (e.altKey || e.button===2){ this._addLens(p.x,p.y); e.preventDefault(); return; }
          const i = this._pickLens(p.x,p.y);
          if (e.shiftKey){ if (i>=0){ this.lenses.splice(i,1); this._drawAll(); } return; }
          if (i>=0){ this.dragging=i; } else { this._addLens(p.x,p.y); }
          e.preventDefault();
        } else {
          try { hud.setPointerCapture(e.pointerId); } catch {}
          this._beginInteract(e);
        }
      });
      hud.addEventListener('pointermove', (e)=>{
        if (this.mode==='edit' && this.dragging>=0){
          const p=this._evtToCanvasPx(e); const L=this.lenses[this.dragging];
          L.x=p.x/this.hud.width; L.y=p.y/this.hud.height; this._drawAll();
        } else if (this.mode==='interact' && this.forwarding.active){
          this._forwardMove(e);
        }
      });
      const finish=(e)=>{
        if (this.mode==='interact' && this.forwarding.active){ this._endInteract(e); this._scheduleSnap(); }
        this.dragging=-1;
        if (hud.hasPointerCapture?.(e.pointerId)) { try { hud.releasePointerCapture(e.pointerId); } catch {} }
      };
      hud.addEventListener('pointerup', finish);
      hud.addEventListener('pointercancel', finish);
      hud.addEventListener('lostpointercapture', finish);
      hud.addEventListener('wheel', (e)=>{
        const p=this._evtToCanvasPx(e);
        if (this.mode==='edit'){
          const i=this._pickLens(p.x,p.y); if(i<0) return;
          const L=this.lenses[i];
          if (e.altKey){ L.k=Math.max(0,Math.min(4, L.k + (-e.deltaY*0.002))); }
          else {
            const norm=1/Math.min(this.hud.width,this.hud.height);
            L.r=Math.max(20*norm, Math.min(800*norm, L.r + (-e.deltaY*0.002)));
          }
          this._drawAll(); e.preventDefault();
        } else {
          this._forwardWheel(e);
        }
      }, {passive:false});

      // local mode button
      this.modeBtn.title = 'Toggle Edit/Interact (E)';
    }

    focus(){
      if (focused && focused !== this) focused.el.classList.remove('focus');
      focused = this; this.el.classList.add('focus'); this.z = ++zCounter; this.el.style.zIndex = this.z;
      // adopt global toolbar state into this tile
      this.mode = globalMode;
      this.base = +baseIn.value;
      this.setLive(liveChk.checked);
      this._drawAll();
    }

    toggleMode(){
      this.mode = (this.mode==='edit') ? 'interact' : 'edit';
      this.modeBtn.textContent = (this.mode==='edit') ? 'E' : 'I';
      this._drawAll();
    }

    load(url){
      this.url = url; this.urlSpan.textContent = url;
      let u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      this.webview.loadURL(u);
    }

    setLive(on){
      this.live = !!on;
      this.webview.style.opacity = this.live ? '0' : '1'; // hide live webview when streaming
      if (this.live && !this._loop) this._loop = requestAnimationFrame((t)=>this._liveTick(t));
      if (!this.live && this._loop){ cancelAnimationFrame(this._loop); this._loop = null; }
    }

    destroy(){
      if (this._loop){ cancelAnimationFrame(this._loop); this._loop=null; }
      this.el.remove();
      tiles = tiles.filter(t=>t!==this);
      if (focused===this) focused=null;
    }

    _place(){
      this.el.style.left=this.x+'px'; this.el.style.top=this.y+'px';
      this.el.style.width=this.w+'px'; this.el.style.height=this.h+'px';
    }

    _fit(){
      const r = this.view.getBoundingClientRect();
      const scale = dpr();
      this.glc.style.width = this.hud.style.width = r.width + 'px';
      this.glc.style.height= this.hud.style.height= r.height + 'px';
      this.glc.width = Math.max(2, Math.floor(r.width * scale));
      this.glc.height= Math.max(2, Math.floor(r.height * scale));
      this.hud.width = this.glc.width; this.hud.height = this.glc.height;
      this._drawAll();
      if (this.live) this._scheduleSnap();
    }

    async snap(){
      if (!window.native || !this.wcId) return;
      try {
        const dataURL = await window.native.capture(this.wcId);
        if (!dataURL) return;
        const img = new Image();
        img.src = dataURL;
        await img.decode();
        this._ensureTex(); const gl=this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        this.dbg.haveTex=true; this.dbg.texW=img.naturalWidth; this.dbg.texH=img.naturalHeight; this.dbg.lastSnap=performance.now();
        this._drawAll();
      } catch (err) {
        console.warn('snap failed', err);
      }
    }

    _scheduleSnap(){
      this._snapT0 = performance.now();
      if (this._pend) return;
      this._pend=true;
      const step = ()=>{
        if (!this._pend) return;
        if (performance.now() - this._snapT0 > (1000/LIVE_FPS)){
          this._pend=false; this.snap();
        } else requestAnimationFrame(step);
      };
      step();
    }

    _liveTick(ts){
      if (!this.live){ this._loop=null; return; }
      this._scheduleSnap();
      this._loop = requestAnimationFrame((t)=>this._liveTick(t));
    }

    _ensureTex(){
      if (this.tex) return;
      const gl=this.gl;
      this.tex=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    _drawGL(){
      const gl=this.gl; if(!gl) return;
      gl.viewport(0,0,this.glc.width,this.glc.height);
      gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
      if(!this.tex || !this.dbg.haveTex) return;
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.u_t,0);
      const LN=Math.min(MAX_LENSES,this.lenses.length); gl.uniform1i(this.u_LN,LN);
      if(LN>0){
        const arr=new Float32Array(4*LN);
        for(let i=0;i<LN;i++){ const L=this.lenses[i];
          arr[i*4+0]=L.x; arr[i*4+1]=1-L.y; arr[i*4+2]=L.r; arr[i*4+3]=L.k;
        }
        gl.uniform4fv(this.u_L0,arr);
      }
      gl.uniform1f(this.u_B, this.base);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    }

    _drawHUD(){
      const ctx=this.hud.getContext('2d');
      ctx.clearRect(0,0,this.hud.width,this.hud.height);
      ctx.font='12px system-ui'; ctx.textBaseline='top';
      ctx.fillStyle='rgba(0,0,0,.5)'; ctx.fillRect(6,6,220,44);
      ctx.fillStyle='#e5e7eb';
      ctx.fillText(`${this.mode.toUpperCase()} • ${this.lenses.length} lens${this.lenses.length!==1?'es':''}`, 10, 10);
      const age = this.dbg.lastSnap ? (performance.now()-this.dbg.lastSnap|0) : '—';
      ctx.fillText(this.dbg.haveTex ? `SNAP ${this.dbg.texW}×${this.dbg.texH} ${age}ms` : 'SNAP: none', 10, 26);

      if(this.mode!=='edit') return;
      ctx.lineWidth=1.5;
      for(const L of this.lenses){
        const cx=L.x*this.hud.width, cy=L.y*this.hud.height, r=L.r*Math.min(this.hud.width,this.hud.height);
        ctx.strokeStyle='rgba(167,139,250,0.9)'; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
        ctx.fillStyle='rgba(167,139,250,0.95)'; ctx.beginPath(); ctx.arc(cx,cy,4,0,Math.PI*2); ctx.fill();
      }
    }
    _drawAll(){ this._drawGL(); this._drawHUD(); }

    // ----- mapping (forward shader space) -----
    _forwardMap(uvS){
      const B=Math.max(0.01,this.base);
      let u={ x:(uvS.x-0.5)/B + 0.5, y:(uvS.y-0.5)/B + 0.5 };
      for(let i=0;i<this.lenses.length;i++){
        const L=this.lenses[i]; const Lx=L.x, Ly=1-L.y;
        const dx=u.x-Lx, dy=u.y-Ly;
        const s=Math.max(1e-5,L.r), r2=dx*dx+dy*dy;
        const m=1/(1 + L.k*Math.exp(-r2/(2*s*s)));
        u={ x:Lx + dx*m, y:Ly + dy*m };
      }
      return u;
    }
    _uvFromCanvas(px,py){ return { x:px/this.hud.width, y:1 - (py/this.hud.height) }; }
    _screenToDIP(px,py){
      const uvS=this._uvFromCanvas(px,py);
      const uS=this._forwardMap(uvS);
      const r=this.webview.getBoundingClientRect();
      const ux=Math.min(Math.max(uS.x,0),1), uy=Math.min(Math.max(uS.y,0),1);
      return { x: ux*r.width, y: (1-uy)*r.height };
    }

    // ----- interact forwarding -----
    async _send(ev){
      try { await this.webview.sendInputEvent(ev); }
      catch(e){
        if (window.native && this.wcId) await window.native.sendInput(this.wcId, ev);
      }
    }
    _evtToCanvasPx(e){
      const r=this.hud.getBoundingClientRect(); const scale=dpr();
      return { x:(e.clientX-r.left)*scale, y:(e.clientY-r.top)*scale };
    }
    _beginInteract(e){
      const p=this._evtToCanvasPx(e); const m=this._screenToDIP(p.x,p.y);
      try{ this.webview.focus(); }catch{}
      this._send({ type:'mouseDown', x:Math.round(m.x), y:Math.round(m.y), button:['left','middle','right'][e.button]||'left', clickCount:1 });
      this.forwarding.active=true; e.preventDefault();
    }
    _forwardMove(e){
      const p=this._evtToCanvasPx(e); const m=this._screenToDIP(p.x,p.y);
      this._send({ type:'mouseMove', x:Math.round(m.x), y:Math.round(m.y) });
    }
    _endInteract(e){
      const p=this._evtToCanvasPx(e); const m=this._screenToDIP(p.x,p.y);
      this._send({ type:'mouseUp', x:Math.round(m.x), y:Math.round(m.y), button:['left','middle','right'][e.button]||'left', clickCount:1 });
      this.forwarding.active=false;
    }
    _forwardWheel(e){
      const p=this._evtToCanvasPx(e); const m=this._screenToDIP(p.x,p.y);
      this._send({ type:'mouseWheel', x:Math.round(m.x), y:Math.round(m.y), deltaX:e.deltaX, deltaY:e.deltaY });
      this._scheduleSnap(); e.preventDefault();
    }

    // ----- lens edit -----
    _addLens(px,py){
      this.lenses.push({ x:px/this.hud.width, y:py/this.hud.height, r: 160/Math.min(this.hud.width,this.hud.height), k:2.0 });
      if(this.lenses.length>MAX_LENSES) this.lenses.shift();
      this._drawAll();
    }
    _pickLens(px,py){
      const ux=px/this.hud.width, uy=py/this.hud.height; let bi=-1, bd=1e9;
      const thr=(14/Math.min(this.hud.width,this.hud.height))**2;
      for(let i=0;i<this.lenses.length;i++){
        const L=this.lenses[i]; const dx=L.x-ux, dy=L.y-uy; const d=dx*dx+dy*dy;
        if(d<thr && d<bd){ bd=d; bi=i; }
      }
      return bi;
    }
  }

  function createTile(opts){
    const t = new Tile(opts||{});
    tiles.push(t);
    return t;
  }

  // ----- Global toolbar controls -----
  modeBtn.onclick = ()=>{
    globalMode = (globalMode==='edit') ? 'interact' : 'edit';
    modeBtn.textContent = (globalMode==='edit') ? 'Edit' : 'Interact';
    if (focused){ focused.mode = globalMode; focused._drawAll(); }
  };
  baseIn.oninput = ()=>{
    if (focused){ focused.base = +baseIn.value; focused._drawAll(); }
  };
  liveChk.onchange = ()=>{
    if (focused){ focused.setLive(liveChk.checked); }
  };

  // Keyboard: toggle mode on focused tile
  document.addEventListener('keydown', (e)=>{
    if (e.key.toLowerCase() === 'e'){ if (focused) { focused.toggleMode(); globalMode = focused.mode; modeBtn.textContent = (globalMode==='edit') ? 'Edit' : 'Interact'; } }
  });

  // Boot with one tile
  createTile({ url:'https://example.org', x:80, y:80, w:480, h:360 });
});
