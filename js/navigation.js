// Camera navigation: mouse layouts, keyboard flying, on-screen buttons and help.
//
// Mouse: CesiumJS' own ScreenSpaceCameraController, with the event types re-mapped per layout
// (see MOUSE_MODES). Keyboard and on-screen buttons share one "pressed" set and move the camera
// every frame while something is held. Translation speed scales with the distance to the surface
// in the middle of the screen, so the same keys work at outcrop and at overview scale.

import {
  KEYMAP, NAV_HELP, MOUSE_MODES, ORBIT_RATE, TURN_RATE,
  codeFor, motionFromKeys, isMoving, moveSpeed, forwardStep, angleStep, isTypingTarget,
} from './navmath.js';

const PREFS_KEY = 'isua-viewer-navigation-v1';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode: fine */ }
}

/**
 * @param {object} opts
 * @param {Cesium.Viewer} opts.viewer
 * @param {object} opts.Cesium
 * @param {function} opts.flyHome
 * @param {function} [opts.onChange] called when a keyboard/button movement ends
 */
export function setupNavigation({ viewer, Cesium, flyHome, onChange = () => {} }) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  const ctrl = scene.screenSpaceCameraController;
  const ET = Cesium.CameraEventType;
  const MOD = Cesium.KeyboardEventModifier;

  ctrl.minimumZoomDistance = 0.2; // allow close-up inspection of hand-sample-scale features
  ctrl.enableCollisionDetection = true;

  const prefs = { mouse: 'model', speed: 1, pad: true, ...loadPrefs() };
  const pressed = new Set();
  const downCodes = new Map(); // KeyboardEvent.code -> KEYMAP code (so "+" released after Shift still stops)
  let fast = false;
  let pivot = null; // fixed point for orbiting while an orbit key is held
  let last = null;
  let moved = false;
  let cached = { t: -Infinity, p: undefined }; // centre point, re-picked at most every 150 ms

  // ------------------------------------------------------------------ mouse layouts
  function setMouseMode(mode) {
    if (!MOUSE_MODES[mode]) mode = 'model';
    prefs.mouse = mode;
    if (mode === 'model') {
      ctrl.rotateEventTypes = [ET.RIGHT_DRAG, { eventType: ET.LEFT_DRAG, modifier: MOD.CTRL }];
      ctrl.tiltEventTypes = [ET.LEFT_DRAG, ET.PINCH];
      ctrl.zoomEventTypes = [ET.WHEEL, ET.MIDDLE_DRAG, ET.PINCH];
      ctrl.lookEventTypes = [{ eventType: ET.LEFT_DRAG, modifier: MOD.SHIFT }];
    } else {
      ctrl.rotateEventTypes = [ET.LEFT_DRAG];
      ctrl.tiltEventTypes = [ET.MIDDLE_DRAG, ET.PINCH, { eventType: ET.LEFT_DRAG, modifier: MOD.CTRL },
        { eventType: ET.RIGHT_DRAG, modifier: MOD.CTRL }];
      ctrl.zoomEventTypes = [ET.RIGHT_DRAG, ET.WHEEL, ET.PINCH];
      ctrl.lookEventTypes = [{ eventType: ET.LEFT_DRAG, modifier: MOD.SHIFT }];
    }
    savePrefs(prefs);
    renderHelp();
  }

  // ------------------------------------------------------------------ geometry helpers
  const centre = () => new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);

  /** World position of whatever is in the middle of the screen (model, else globe), or undefined. */
  function centrePoint() {
    const c = centre();
    let p;
    if (scene.pickPositionSupported) {
      try { p = scene.pickPosition(c); } catch { p = undefined; }
    }
    if (!p) p = camera.pickEllipsoid(c, scene.globe.ellipsoid);
    return p;
  }

  /** centrePoint() is a depth-buffer pick (costly on slow GPUs): reuse it for a few frames. */
  function centrePointCached(now) {
    if (now - cached.t > 150) cached = { t: now, p: centrePoint() };
    return cached.p;
  }

  function distanceTo(p) {
    return p ? Cesium.Cartesian3.distance(camera.positionWC, p) : undefined;
  }

  /** Distance used to scale translation speed: to the centre point, else height above the ellipsoid. */
  function referenceDistance() {
    const d = distanceTo(centrePoint());
    if (Number.isFinite(d) && d > 0) return d;
    return Math.abs(camera.positionCartographic.height) || 100;
  }

  /** Pivot for orbiting: the centre point, or a point straight ahead if the view is empty. */
  function orbitPivot() {
    const p = centrePoint();
    if (p) return p;
    const d = Math.max(Math.abs(camera.positionCartographic.height), 10);
    return Cesium.Cartesian3.add(camera.positionWC, Cesium.Cartesian3.multiplyByScalar(camera.directionWC, d, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  }

  /** Rotate the camera around `p`: `h` around the local vertical, `v` over/under (radians). */
  function orbitAround(p, h, v) {
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(p);
    camera.lookAtTransform(frame);
    if (h) camera.rotateRight(h);
    // In this frame rotateDown() moves the camera up over the pivot (checked in the end-to-end test).
    if (v) camera.rotateDown(v);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  // ------------------------------------------------------------------ per-frame movement
  function tick() {
    const now = performance.now();
    const m = motionFromKeys(pressed);
    if (!isMoving(m)) {
      last = null; pivot = null; cached.t = -Infinity;
      if (moved) { moved = false; onChange(); }
      return;
    }
    // Real elapsed time, so speed does not depend on the frame rate (capped for long stalls).
    const dt = last ? Math.min((now - last) / 1000, 0.25) : 1 / 30;
    last = now;
    moved = true;
    camera.cancelFlight();

    if (m.orbitH || m.orbitV) {
      if (!pivot) pivot = orbitPivot();
      orbitAround(pivot,
        angleStep(ORBIT_RATE, dt, m.orbitH, { fast }),
        angleStep(ORBIT_RATE, dt, m.orbitV, { fast }));
    } else pivot = null;

    if (m.yaw) {
      // Turn around the local vertical (not the camera's tilted "up"), so the horizon stays level.
      const n = scene.globe.ellipsoid.geodeticSurfaceNormal(camera.positionWC, new Cesium.Cartesian3());
      camera.look(n, -angleStep(TURN_RATE, dt, m.yaw, { fast }));
    }
    if (m.pitch) camera.lookUp(angleStep(TURN_RATE, dt, m.pitch, { fast }));

    if (m.forward || m.right || m.up) {
      const ahead = distanceTo(centrePointCached(now));
      const speed = moveSpeed(Number.isFinite(ahead) ? ahead : referenceDistance(), { fast, factor: prefs.speed });
      if (m.forward) camera.moveForward(forwardStep(speed, dt, m.forward, ahead));
      if (m.right) camera.moveRight(speed * dt * m.right);
      if (m.up) {
        const n = scene.globe.ellipsoid.geodeticSurfaceNormal(camera.positionWC, new Cesium.Cartesian3());
        camera.move(n, speed * dt * m.up);
      }
    }
  }
  scene.preRender.addEventListener(tick);

  // ------------------------------------------------------------------ one-shot actions
  /** Rotate around the centre point until north is up (same distance and viewing angle). */
  function northUp() {
    camera.cancelFlight();
    const p = orbitPivot();
    const range = Math.max(distanceTo(p) || 100, 1);
    camera.lookAt(p, new Cesium.HeadingPitchRange(0, camera.pitch, range));
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    onChange();
  }

  /** Look straight down on the centre point from the current distance. */
  function topDown() {
    camera.cancelFlight();
    const p = orbitPivot();
    const range = Math.max(distanceTo(p) || 100, 1);
    camera.lookAt(p, new Cesium.HeadingPitchRange(camera.heading, -Cesium.Math.PI_OVER_TWO + 1e-4, range));
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    onChange();
  }

  const ACTIONS = { KeyN: northUp, KeyT: topDown, KeyH: () => flyHome() };

  // ------------------------------------------------------------------ keyboard
  function keyTarget(e) {
    return !isTypingTarget(e.target) && !isTypingTarget(document.activeElement) && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  document.addEventListener('keydown', (e) => {
    fast = e.shiftKey;
    if (!keyTarget(e)) return;
    const code = codeFor(e);
    if (KEYMAP[code]) {
      downCodes.set(e.code, code);
      pressed.add(code);
      e.preventDefault(); // arrows must not scroll the side panel
    } else if (ACTIONS[e.code] && !e.repeat) {
      ACTIONS[e.code]();
      e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => {
    fast = e.shiftKey;
    const code = downCodes.get(e.code) ?? codeFor(e);
    downCodes.delete(e.code);
    pressed.delete(code);
  });
  const releaseAll = () => { pressed.clear(); downCodes.clear(); fast = false; };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  // ------------------------------------------------------------------ on-screen pad
  const PAD = [
    // [code or action, label, title, grid area]
    ['KeyE', '⤒', 'Up (E)', 'up'], ['KeyW', '▲', 'Forward / zoom in (W)', 'fw'], ['KeyQ', '⤓', 'Down (Q)', 'dn'],
    ['KeyA', '◀', 'Move left (A)', 'lt'], ['KeyS', '▼', 'Back / zoom out (S)', 'bk'], ['KeyD', '▶', 'Move right (D)', 'rt'],
    ['ArrowLeft', '⟲', 'Rotate left around the centre (←)', 'ol'], ['ArrowUp', '⌃', 'Orbit over (↑)', 'ou'],
    ['ArrowRight', '⟳', 'Rotate right around the centre (→)', 'or'], ['ArrowDown', '⌄', 'Orbit under (↓)', 'od'],
    ['KeyN', 'N', 'North up (N)', 'nu'], ['KeyT', '⊙', 'Top-down view (T)', 'td'], ['help', '?', 'Navigation help', 'hp'],
  ];
  const pad = document.createElement('div');
  pad.id = 'nav-pad';
  pad.setAttribute('aria-label', 'Navigation buttons');
  for (const [code, label, title, area] of PAD) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.gridArea = area;
    b.dataset.code = code;
    if (KEYMAP[code]) {
      const start = (ev) => { ev.preventDefault(); b.setPointerCapture?.(ev.pointerId); pressed.add(code); fast = ev.shiftKey; };
      const stop = () => pressed.delete(code);
      b.addEventListener('pointerdown', start);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('lostpointercapture', stop);
    } else if (code === 'help') {
      b.addEventListener('click', () => {
        const sec = document.querySelector('#sec-nav');
        if (sec) { sec.open = true; sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        document.querySelector('#panel')?.classList.remove('collapsed');
      });
    } else {
      b.addEventListener('click', () => ACTIONS[code]());
    }
    pad.append(b);
  }
  document.querySelector('#cesium').append(pad);

  // ------------------------------------------------------------------ panel section
  function renderHelp() {
    const table = document.querySelector('#nav-help');
    if (!table) return;
    const rows = [['', 'Mouse'], ...MOUSE_MODES[prefs.mouse].help, ['', 'Keyboard (click the 3D view first)'], ...NAV_HELP];
    table.replaceChildren(...rows.map(([k, v]) => {
      const tr = document.createElement('tr');
      if (!k) {
        const th = document.createElement('th');
        th.colSpan = 2;
        th.textContent = v;
        tr.append(th);
      } else {
        const a = document.createElement('td'); a.textContent = k;
        const b = document.createElement('td'); b.textContent = v;
        tr.append(a, b);
      }
      return tr;
    }));
  }

  const sel = document.querySelector('#sel-mouse');
  const speed = document.querySelector('#in-speed');
  const speedOut = document.querySelector('#out-speed');
  const chkPad = document.querySelector('#chk-pad');
  if (sel) {
    sel.replaceChildren(...Object.entries(MOUSE_MODES).map(([k, v]) => new Option(v.label, k)));
    sel.value = prefs.mouse;
    sel.addEventListener('change', () => setMouseMode(sel.value));
  }
  const showSpeed = () => { if (speedOut) speedOut.value = `${prefs.speed}×`; };
  if (speed) {
    speed.value = String(Math.log2(prefs.speed));
    speed.addEventListener('input', () => { prefs.speed = 2 ** Number(speed.value); showSpeed(); savePrefs(prefs); });
  }
  showSpeed();
  const applyPad = () => { pad.hidden = !prefs.pad; };
  if (chkPad) {
    chkPad.checked = prefs.pad;
    chkPad.addEventListener('change', () => { prefs.pad = chkPad.checked; applyPad(); savePrefs(prefs); });
  }
  applyPad();
  setMouseMode(prefs.mouse);

  // The 3D canvas must be focusable so a click on it moves keyboard focus away from the panel.
  scene.canvas.tabIndex = 0;
  scene.canvas.addEventListener('pointerdown', () => scene.canvas.focus({ preventScroll: true }));

  return {
    setMouseMode, northUp, topDown, pressed,
    get prefs() { return { ...prefs }; },
  };
}
