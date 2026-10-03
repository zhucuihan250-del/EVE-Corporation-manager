/* CCPWGL2 is MIT; meshes and textures remain CCP's intellectual property.
 * Isolated in an iframe so its global render loop and input listeners are
 * destroyed when the fitting view closes. No member or character data leaves
 * this site's origin. */
"use strict";
(async function () {
  const canvas = document.getElementById("ship-canvas"), loading = document.getElementById("loading");
  const query = new URLSearchParams(location.search), typeId = Number(query.get("ship"));
  let currentShip = null, resetPose = null;
  let expired = false;
  function report(status, detail) {
    parent.postMessage({ type: "fitting-3d-status", status, detail, typeId }, location.origin);
  }
  const deadline = setTimeout(() => {
    expired = true;
    loading.hidden = false;
    loading.textContent = "3D 模型加载超时，请重试。";
    if (window.tny) tny.options.render = false;
    report("error", loading.textContent);
  }, 120000);
  try {
    if (!Number.isSafeInteger(typeId) || typeId <= 0) throw new Error("请先选择舰船。");
    const subsystems = query.get("subsystems") || "";
    const response = await fetch(`/api/fitting/3d/model/${typeId}?subsystems=${encodeURIComponent(subsystems)}`, { credentials: "same-origin", signal: AbortSignal.timeout(60000) });
    const model = await response.json();
    if (!response.ok) throw new Error(model.error || "无法加载舰船模型。");
    const root = new URL(model.resourceRoot, location.origin).href;
    loading.textContent = "正在初始化 3D 预览…";
    const factory = new EveSOFDataHandler();
    tw2.Register({ paths: { res: root, r: root }, dnaHandler: async dna => {
      const data = await factory.Handle(dna);
      // Fitting is a stationary subject view, not an in-space combat scene.
      // Authored exhaust/electrical child VFX are unnecessary here; retain the
      // original hull mesh, materials, locators and strategic-cruiser parts.
      data.enableChildren = false;
      return data;
    } });
    let lastRender = 0;
    await tny.Initialize({
      canvas: "ship-canvas", camera: { canvas: "ship-canvas", rotationX: -0.25, rotationY: 0.8, distance: 300 },
      audioEnabled: false,
      device: { webgl2: true, antialias: true, alpha: true, effectProfile: tw2.const.DeviceEffectProfile.DX11, shaderQuality: tw2.const.DeviceShaderQuality.MEDIUM },
      client: { clearColor: [0, 0, 0, 0] },
      render: dt => { const now = performance.now(); if (!document.hidden && now - lastRender >= 1000 / 30) { lastRender = now; tny.Render(dt); } }
    });
    // Use the game's small lighting cubes, not its 25 MiB full nebula backdrop.
    // A fitting preview is a subject scene: no skybox, starfield or world effects.
    loading.textContent = "正在加载舰船光照…";
    const scene = await tny.FetchScene({});
    const wrappedScene = scene.wrapped;
    wrappedScene.backgroundRenderingEnabled = false;
    wrappedScene.Initialize();
    await Promise.all([
      wrappedScene.SetEnvMapReflection("res:/dx9/scene/universe/a01_cube_refl.dds"),
      wrappedScene.SetEnvMapDiffuse("res:/dx9/scene/universe/a01_cube_blur.dds"),
      wrappedScene.SetEnvMapBlur("res:/dx9/scene/universe/a01_cube_blur.dds")
    ]);
    loading.textContent = "正在构建舰船模型…";
    currentShip = await scene.Fetch(model.dna || model.resourcePath, progress => {
      if (!expired) loading.textContent = `正在加载真实舰船模型 ${Math.round(progress.percent || 0)}%`;
    });
    if (expired) return;
    const camera = tny.GetCamera();
    // The first render updates geometry bounds and the wrapped orbit camera.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (expired) return;
    clearTimeout(deadline);
    const fitCamera = () => camera.FitToScreen(currentShip, { margin: 1.17, aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight) });
    if (!fitCamera()) throw new Error("无法确定舰船模型尺寸，请重试。");
    resetPose = { rotationX: camera.rotationX, rotationY: camera.rotationY, distance: camera.distance };
    canvas.classList.add("hologram");
    loading.hidden = true;
    document.getElementById("controls").hidden = false;
    document.getElementById("hint").hidden = false;
    document.getElementById("reset").onclick = () => { camera.ResetMotion?.(); Object.assign(camera, resetPose); fitCamera(); };
    document.getElementById("hologram").onclick = event => { const enabled = canvas.classList.toggle("hologram"); event.currentTarget.setAttribute("aria-pressed", String(enabled)); };
    // The renderer's camera already supports touch orbit/pinch. Modern wheel
    // events are handled explicitly (its legacy camera uses mousewheel).
    canvas.addEventListener("wheel", event => { event.preventDefault(); camera.CommitMotion?.(); camera.distance = Math.max(1, Math.min(1e8, camera.distance * Math.exp(event.deltaY * .0015))); }, { passive: false });
    canvas.addEventListener("contextmenu", event => event.preventDefault());
    canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); loading.hidden = false; loading.textContent = "3D 显示已中断，请重新加载预览。"; report("error", loading.textContent); });
    const observer = new ResizeObserver(() => { tw2.device?.Resize?.(); fitCamera(); }); observer.observe(canvas);
    document.addEventListener("visibilitychange", () => { tny.options.render = !document.hidden; });
    window.__fitting3d = { ship: currentShip, camera, model, renderer: "ccpwgl2", ready: true };
    report("ready", "真实 3D 模型，可旋转和缩放");
  } catch (error) {
    clearTimeout(deadline);
    loading.textContent = error instanceof Error && /^[\u4e00-\u9fff]/.test(error.message) ? error.message : "真实 3D 模型暂无法显示，请重试或检查浏览器 WebGL 支持。";
    loading.hidden = false;
    report("error", loading.textContent);
    // Keep diagnostics useful in local QA without exposing upstream payloads.
    console.warn("Fitting 3D renderer failed", error instanceof Error ? `${error.name}: ${error.message.slice(0, 240)}` : "Error");
  }
}());
