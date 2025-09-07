// renderer.js — DPR-aware, shader warp, edit/interact, tests

console.log("[Crumple] renderer boot");

window.addEventListener("DOMContentLoaded", () => {
  // ---------- DOM ----------
  const webview = document.getElementById("page");
  const glc = document.getElementById("gl");
  const hud = document.getElementById("hud");

  const urlIn = document.getElementById("url");
  const goBtn = document.getElementById("go");
  const snapBtn = document.getElementById("snap");
  const autoChk = document.getElementById("auto");
  const modeBtn = document.getElementById("mode");
  const baseIn = document.getElementById("base");
  const clearBtn = document.getElementById("clear");

  // Tests
  const tGrad = document.getElementById("tGrad");
  const tGrid = document.getElementById("tGrid");
  const tSnap = document.getElementById("tSnap");
  const tForce = document.getElementById("tForce");
  const tClearTex = document.getElementById("tClearTex");
  const tToggleLive = document.getElementById("tToggleLive");
  const tCenter = document.getElementById("tCenter");
  const tScrollTest = document.getElementById("tScrollTest");
  const tReport = document.getElementById("tReport");

  const required = [
    webview,
    glc,
    hud,
    urlIn,
    goBtn,
    snapBtn,
    autoChk,
    modeBtn,
    baseIn,
    clearBtn,
    tGrad,
    tGrid,
    tSnap,
    tForce,
    tClearTex,
    tToggleLive,
    tCenter,
    tScrollTest,
    tReport,
  ];
  if (required.some((el) => !el)) {
    console.error("[Crumple] Missing DOM nodes — is index.html up to date?");
    alert(
      "index.html is not up to date (missing controls). Please update all files.",
    );
    return;
  }

  // Status banner if preload is missing
  const status = document.createElement("div");
  status.style.cssText =
    "position:fixed;right:8px;top:8px;background:#7c2d12;color:#fff;padding:6px 10px;border-radius:8px;z-index:9999;font:12px system-ui;display:none;";
  document.body.appendChild(status);
  function showStatus(msg) {
    status.textContent = msg;
    status.style.display = "block";
  }
  if (!window.native)
    showStatus(
      "Preload missing → capture disabled; use Gradient/UV Grid tests",
    );

  // ---------- State ----------
  let mode = "edit"; // 'edit' | 'interact'
  let base = 0.7; // 0.3..1.0
  let lenses = []; // {x,y,r,k} normalized (0..1) in HUD space
  let dragging = -1;
  let wcId = null;
  let liveHidden = false;
  const dbg = { haveTex: false, texW: 0, texH: 0, lastSnap: 0 };
  let lastMapped = null; // {x,y,t} in DIP

  // DPR handling
  function dpr() {
    return window.devicePixelRatio || 1;
  }

  // ---------- Fit canvases to webview (DPR-aware) ----------
  function fit() {
    const r = webview.getBoundingClientRect();
    const scale = dpr();
    glc.style.width = hud.style.width = r.width + "px";
    glc.style.height = hud.style.height = r.height + "px";
    glc.width = Math.max(2, Math.floor(r.width * scale));
    glc.height = Math.max(2, Math.floor(r.height * scale));
    hud.width = glc.width;
    hud.height = glc.height;
    drawAll();
  }
  window.addEventListener("resize", fit);

  // ---------- WebGL shader ----------
  const gl = glc.getContext("webgl2", {
    premultipliedAlpha: true,
    alpha: true,
    antialias: true,
  });
  if (!gl) {
    alert("WebGL2 not available");
    return;
  }

  const vs = `#version 300 es
precision highp float;
layout(location=0) in vec2 a; out vec2 v;
void main(){ v=a*0.5+0.5; gl_Position=vec4(a,0.,1.); }`;
  const fs = `#version 300 es
precision highp float; in vec2 v; out vec4 o; uniform sampler2D t; const int MAXL=16; uniform int LN; uniform vec4 L[MAXL]; uniform float B;
vec2 baseMap(vec2 u){ float s=max(0.01,B); return (u-vec2(0.5))/s + vec2(0.5);} vec2 lensMap(vec2 u){ for(int i=0;i<MAXL;i++){ if(i>=LN) break; vec4 P=L[i]; vec2 d=u-P.xy; float r2=dot(d,d); float s=max(1e-5,P.z); float m=1./(1.+P.w*exp(-r2/(2.*s*s))); u=P.xy + d*m; } return u; }
void main(){ vec2 u=v; u=baseMap(u); u=lensMap(u); if(any(lessThan(u,vec2(0.)))||any(greaterThan(u,vec2(1.)))) o=vec4(0.,0.,0.,1.); else o=texture(t,u); }`;

  function sh(t, src) {
    const s = gl.createShader(t);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw gl.getShaderInfoLog(s);
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw gl.getProgramInfoLog(prog);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u_t = U("t"),
    u_LN = U("LN"),
    u_L0 = U("L[0]"),
    u_B = U("B"); // NOTE: L[0]!

  let tex = null;
  function ensureTex() {
    if (tex) return;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function drawGL() {
    gl.viewport(0, 0, glc.width, glc.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!tex || !dbg.haveTex) return;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u_t, 0);
    const LN = Math.min(16, lenses.length);
    gl.uniform1i(u_LN, LN);
    if (LN > 0) {
      const arr = new Float32Array(4 * LN);
      for (let i = 0; i < LN; i++) {
        const L = lenses[i];
        arr[i * 4 + 0] = L.x;
        arr[i * 4 + 1] = 1 - L.y; // flip to shader UV (top=1)
        arr[i * 4 + 2] = L.r;
        arr[i * 4 + 3] = L.k;
      }
      gl.uniform4fv(u_L0, arr);
    }

    gl.uniform1f(u_B, base);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- HUD ----------
  const h2d = hud.getContext("2d");
  function drawHUD() {
    h2d.clearRect(0, 0, hud.width, hud.height);
    h2d.font = "12px system-ui";
    h2d.textBaseline = "top";
    h2d.fillStyle = "rgba(0,0,0,.5)";
    h2d.fillRect(8, 8, 340, 58);
    h2d.fillStyle = "#e5e7eb";
    h2d.fillText(
      `${mode.toUpperCase()} • ${lenses.length} lens${lenses.length !== 1 ? "es" : ""}`,
      12,
      12,
    );
    h2d.fillText(
      dbg.haveTex
        ? `SNAP ${dbg.texW}×${dbg.texH} ${(performance.now() - dbg.lastSnap) | 0}ms ago`
        : "SNAP: none",
      12,
      28,
    );

    // crosshair (show in both modes)
    if (lastMapped && performance.now() - lastMapped.t < 800) {
      const r = webview.getBoundingClientRect();
      const ux = (lastMapped.x / r.width) * hud.width;
      const uy = (lastMapped.y / r.height) * hud.height;
      h2d.strokeStyle = "rgba(16,185,129,0.9)";
      h2d.beginPath();
      h2d.moveTo(ux - 8, uy);
      h2d.lineTo(ux + 8, uy);
      h2d.moveTo(ux, uy - 8);
      h2d.lineTo(ux, uy + 8);
      h2d.stroke();
      h2d.fillStyle = "#10b981";
      h2d.fillText(`→ ${lastMapped.x | 0}, ${lastMapped.y | 0}`, 12, 44);
    }

    if (mode !== "edit") return;
    h2d.lineWidth = 1.5;
    for (const L of lenses) {
      const cx = L.x * hud.width,
        cy = L.y * hud.height,
        r = L.r * Math.min(hud.width, hud.height);
      h2d.strokeStyle = "rgba(167,139,250,0.9)";
      h2d.beginPath();
      h2d.arc(cx, cy, r, 0, Math.PI * 2);
      h2d.stroke();
      h2d.fillStyle = "rgba(167,139,250,0.95)";
      h2d.beginPath();
      h2d.arc(cx, cy, 4, 0, Math.PI * 2);
      h2d.fill();
    }
  }
  function drawAll() {
    drawGL();
    drawHUD();
  }

  // ---------- Capture via preload (image decode path) ----------
  webview.addEventListener("dom-ready", () => {
    try {
      wcId = webview.getWebContentsId();
    } catch {}
    if (window.native) snap();
  });
  webview.addEventListener("did-stop-loading", () => {
    if (window.native) setTimeout(snap, 50);
  });

  async function snap() {
    if (!window.native || !wcId) return;
    const dataURL = await window.native.capture(wcId);
    if (!dataURL) return;
    try {
      const img = new Image();
      img.src = dataURL;
      await img.decode();
      ensureTex();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      dbg.haveTex = true;
      dbg.texW = img.naturalWidth;
      dbg.texH = img.naturalHeight;
      dbg.lastSnap = performance.now();
      drawAll();
    } catch (err) {
      console.warn("snap decode failed", err);
    }
  }

  let pend = false,
    t0 = 0;
  function scheduleSnap() {
    if (!autoChk.checked || !window.native) return;
    t0 = performance.now();
    if (pend) return;
    pend = true;
    const loop = () => {
      if (performance.now() - t0 > 120) {
        pend = false;
        snap();
      } else requestAnimationFrame(loop);
    };
    loop();
  }

  // ---------- Lens edit on HUD ----------
  function addLens(px, py) {
    lenses.push({
      x: px / hud.width,
      y: py / hud.height,
      r: 180 / Math.min(hud.width, hud.height),
      k: 2.0,
    });
    if (lenses.length > 16) lenses.shift();
    drawAll();
  }
  function pickLens(px, py) {
    const ux = px / hud.width,
      uy = py / hud.height;
    let bi = -1,
      bd = 1e9;
    const thr = (14 / Math.min(hud.width, hud.height)) ** 2;
    for (let i = 0; i < lenses.length; i++) {
      const L = lenses[i];
      const dx = L.x - ux,
        dy = L.y - uy;
      const d = dx * dx + dy * dy;
      if (d < thr && d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  }
  function evtToCanvasPx(e) {
    const r = hud.getBoundingClientRect();
    const scale = dpr();
    return {
      x: (e.clientX - r.left) * scale,
      y: (e.clientY - r.top) * scale,
      rect: r,
    };
  }

  hud.addEventListener("contextmenu", (e) => e.preventDefault());

  hud.addEventListener("pointerdown", (e) => {
    const p = evtToCanvasPx(e);
    if (mode === "edit") {
      if (e.altKey || e.button === 2) {
        addLens(p.x, p.y);
        e.preventDefault();
        return;
      }
      const i = pickLens(p.x, p.y);
      if (e.shiftKey) {
        if (i >= 0) {
          lenses.splice(i, 1);
          drawAll();
        }
        return;
      }
      if (i >= 0) {
        dragging = i;
      } else {
        addLens(p.x, p.y);
      }
      e.preventDefault();
    } else {
      try {
        hud.setPointerCapture(e.pointerId);
      } catch {}
      beginInteract(e);
    }
  });
  hud.addEventListener("pointermove", (e) => {
    if (mode === "edit" && dragging >= 0) {
      const p = evtToCanvasPx(e);
      const L = lenses[dragging];
      L.x = p.x / hud.width;
      L.y = p.y / hud.height;
      drawAll();
    } else if (mode === "interact" && forwarding.active) {
      forwardMove(e);
    }
  });
  function finishInteract(e) {
    if (mode === "interact" && forwarding.active) {
      endInteract(e);
      scheduleSnap();
    }
    if (hud.hasPointerCapture?.(e.pointerId)) {
      try {
        hud.releasePointerCapture(e.pointerId);
      } catch {}
    }
  }
  hud.addEventListener("pointerup", finishInteract);
  hud.addEventListener("pointercancel", finishInteract);
  hud.addEventListener("lostpointercapture", finishInteract);

  hud.addEventListener(
    "wheel",
    (e) => {
      const p = evtToCanvasPx(e);
      if (mode === "edit") {
        const i = pickLens(p.x, p.y);
        if (i < 0) return;
        const L = lenses[i];
        if (e.altKey) {
          L.k = Math.max(0, Math.min(4, L.k + -e.deltaY * 0.002));
        } else {
          const norm = 1 / Math.min(hud.width, hud.height);
          L.r = Math.max(
            20 * norm,
            Math.min(800 * norm, L.r + -e.deltaY * 0.002),
          );
        }
        drawAll();
        e.preventDefault();
      } else {
        forwardWheel(e);
      }
    },
    { passive: false },
  );

  // ---------- Mapping (FORWARD, same as shader) ----------
  // HUD canvas px -> shader UV (top=1)
  function uvFromCanvasPx(px, py) {
    return { x: px / hud.width, y: 1 - py / hud.height };
  }

  function forwardMap(uvS) {
    // shader UV in, shader UV out
    const B = Math.max(0.01, base);
    let u = { x: (uvS.x - 0.5) / B + 0.5, y: (uvS.y - 0.5) / B + 0.5 };

    for (let i = 0; i < lenses.length; i++) {
      const L = lenses[i];
      const Lx = L.x,
        Ly = 1 - L.y; // flip lens Y into shader space
      const dx = u.x - Lx,
        dy = u.y - Ly;
      const s = Math.max(1e-5, L.r);
      const r2 = dx * dx + dy * dy;
      const m = 1 / (1 + L.k * Math.exp(-r2 / (2 * s * s)));
      u = { x: Lx + dx * m, y: Ly + dy * m };
    }
    return u;
  }

  // Convert HUD px -> webview DIP (CSS px)
  function screenToSourceDIP(pxCanvas, pyCanvas) {
    const uvS = uvFromCanvasPx(pxCanvas, pyCanvas); // shader UV
    const uS = forwardMap(uvS); // shader UV after warp
    const r = webview.getBoundingClientRect(); // DIP
    const ux = Math.min(Math.max(uS.x, 0), 1);
    const uyS = Math.min(Math.max(uS.y, 0), 1);
    return { x: ux * r.width, y: (1 - uyS) * r.height }; // back to top-origin DIP
  }

  // ---------- Interact mode: sendInputEvent via webview ----------
  const forwarding = { active: false };
  function mouseButton(btn) {
    return ["left", "middle", "right"][btn] || "left";
  }

  async function sendWebviewEvent(ev) {
    try {
      await webview.sendInputEvent(ev);
    } catch (e) {
      console.warn("webview.sendInputEvent failed; falling back to IPC", e);
      if (window.native && wcId) {
        await window.native.sendInput(wcId, ev);
      }
    }
  }

  function beginInteract(e) {
    const p = evtToCanvasPx(e);
    const m = screenToSourceDIP(p.x, p.y);
    try {
      webview.focus();
    } catch {}
    sendWebviewEvent({
      type: "mouseDown",
      x: Math.round(m.x),
      y: Math.round(m.y),
      button: mouseButton(e.button),
      clickCount: 1,
    });
    forwarding.active = true;
    e.preventDefault();
    lastMapped = { x: m.x, y: m.y, t: performance.now() };
    drawHUD();
  }
  function forwardMove(e) {
    if (!forwarding.active) return;
    const p = evtToCanvasPx(e);
    const m = screenToSourceDIP(p.x, p.y);
    sendWebviewEvent({
      type: "mouseMove",
      x: Math.round(m.x),
      y: Math.round(m.y),
    });
    lastMapped = { x: m.x, y: m.y, t: performance.now() };
    if (mode === "interact") drawHUD();
  }
  function endInteract(e) {
    const p = evtToCanvasPx(e);
    const m = screenToSourceDIP(p.x, p.y);
    sendWebviewEvent({
      type: "mouseUp",
      x: Math.round(m.x),
      y: Math.round(m.y),
      button: mouseButton(e.button),
      clickCount: 1,
    });
    forwarding.active = false;
    lastMapped = { x: m.x, y: m.y, t: performance.now() };
    drawHUD();
  }
  function forwardWheel(e) {
    const p = evtToCanvasPx(e);
    const m = screenToSourceDIP(p.x, p.y);
    sendWebviewEvent({
      type: "mouseWheel",
      x: Math.round(m.x),
      y: Math.round(m.y),
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
    scheduleSnap();
    e.preventDefault();
    lastMapped = { x: m.x, y: m.y, t: performance.now() };
    if (mode === "interact") drawHUD();
  }

  // ---------- UI ----------
  function loadURL() {
    let u = urlIn.value.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    webview.loadURL(u);
    setTimeout(() => {
      if (window.native) snap();
    }, 200);
  }
  urlIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadURL();
  });
  goBtn.onclick = loadURL;
  snapBtn.onclick = () => snap();
  modeBtn.onclick = () => {
    mode = mode === "edit" ? "interact" : "edit";
    modeBtn.textContent = mode === "edit" ? "Edit" : "Interact";
    drawHUD();
  };
  baseIn.oninput = () => {
    base = +baseIn.value;
    drawAll();
  };
  clearBtn.onclick = () => {
    lenses.length = 0;
    drawAll();
  };

  // Toggle with 'E'
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "e") {
      mode = mode === "edit" ? "interact" : "edit";
      modeBtn.textContent = mode === "edit" ? "Edit" : "Interact";
      drawHUD();
    }
  });

  // ----- Tests -----
  async function genCanvasBitmap(painter) {
    const c = document.createElement("canvas");
    const r = webview.getBoundingClientRect();
    const scale = dpr();
    c.width = Math.max(2, Math.floor(r.width * scale));
    c.height = Math.max(2, Math.floor(r.height * scale));
    const ctx = c.getContext("2d");
    painter(ctx, c.width, c.height);
    return await createImageBitmap(c);
  }
  async function testGradient() {
    const bmp = await genCanvasBitmap((ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#111");
      g.addColorStop(0.5, "#7e22ce");
      g.addColorStop(1, "#22d3ee");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    ensureTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      bmp.width,
      bmp.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bmp,
    );
    dbg.haveTex = true;
    dbg.texW = bmp.width;
    dbg.texH = bmp.height;
    dbg.lastSnap = performance.now();
    drawAll();
  }
  async function testGrid() {
    const bmp = await genCanvasBitmap((ctx, w, h) => {
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#2b2d3f";
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#9aa2b1";
      ctx.font = "12px system-ui";
      ctx.fillText("UV GRID", 10, 10);
    });
    ensureTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      bmp.width,
      bmp.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bmp,
    );
    dbg.haveTex = true;
    dbg.texW = bmp.width;
    dbg.texH = bmp.height;
    dbg.lastSnap = performance.now();
    drawAll();
  }
  function testSnap() {
    snap();
  }
  function testForceLens() {
    lenses = [{ x: 0.5, y: 0.5, r: 0.25, k: 2.0 }];
    base = 0.8;
    baseIn.value = String(base);
    drawAll();
  }
  function testClearTex() {
    if (tex) {
      gl.deleteTexture(tex);
      tex = null;
    }
    dbg.haveTex = false;
    drawAll();
  }
  function testToggleLive() {
    liveHidden = !liveHidden;
    webview.style.opacity = liveHidden ? "0" : "1";
    tToggleLive.textContent = liveHidden ? "Show live" : "Hide live";
  }
  function testReport() {
    const r = webview.getBoundingClientRect();
    console.log("[REPORT]", {
      wcId,
      canvas: {
        w: glc.width,
        h: glc.height,
        cssW: r.width,
        cssH: r.height,
        dpr: dpr(),
      },
      tex: {
        have: dbg.haveTex,
        w: dbg.texW,
        h: dbg.texH,
        age: ((performance.now() - dbg.lastSnap) | 0) + "ms",
      },
      lenses,
      base,
      native: !!window.native,
    });
    alert("Report printed to DevTools console");
  }
  async function testCenterClick() {
    const r = webview.getBoundingClientRect();
    try {
      webview.focus();
    } catch {}
    await sendWebviewEvent({
      type: "mouseDown",
      x: Math.round(r.width / 2),
      y: Math.round(r.height / 2),
      button: "left",
      clickCount: 1,
    });
    await sendWebviewEvent({
      type: "mouseUp",
      x: Math.round(r.width / 2),
      y: Math.round(r.height / 2),
      button: "left",
      clickCount: 1,
    });
    console.log("[TEST] center click sent");
  }
  async function testScroll() {
    const r = webview.getBoundingClientRect();
    await sendWebviewEvent({
      type: "mouseWheel",
      x: Math.round(r.width / 2),
      y: Math.round(r.height / 2),
      deltaX: 0,
      deltaY: -120,
    });
    console.log("[TEST] scroll sent");
  }

  tGrad.onclick = testGradient;
  tGrid.onclick = testGrid;
  tSnap.onclick = testSnap;
  tForce.onclick = testForceLens;
  tClearTex.onclick = testClearTex;
  tToggleLive.onclick = testToggleLive;
  tReport.onclick = testReport;
  tCenter.onclick = testCenterClick;
  tScrollTest.onclick = testScroll;

  // Debug API
  window.Crumple = {
    webview,
    centerClick: testCenterClick,
    scroll: testScroll,
    report: testReport,
  };

  // ---------- Boot ----------
  fit();
  drawAll();
  if (window.native) snap();
});
