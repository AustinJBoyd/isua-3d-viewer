// Navigation maths without CesiumJS, so it can be unit-tested in Node.
//
// Key bindings use KeyboardEvent.code (the physical key), so W/A/S/D sit in the same place on
// Danish, English and other QWERTY-style keyboards.

/** Physical key -> [axis, direction]. Axes are explained in NAV_HELP. */
export const KEYMAP = {
  KeyW: ['forward', 1], KeyS: ['forward', -1],
  NumpadAdd: ['forward', 1], NumpadSubtract: ['forward', -1], // + / − anywhere: see codeFor()
  KeyD: ['right', 1], KeyA: ['right', -1],
  KeyE: ['up', 1], KeyQ: ['up', -1], PageUp: ['up', 1], PageDown: ['up', -1],
  ArrowLeft: ['orbitH', -1], ArrowRight: ['orbitH', 1],
  ArrowUp: ['orbitV', 1], ArrowDown: ['orbitV', -1],
  KeyJ: ['yaw', -1], KeyL: ['yaw', 1],
  KeyI: ['pitch', 1], KeyK: ['pitch', -1],
};

/**
 * The KEYMAP code for a keyboard event. Letters and arrows use the physical key; + and − use the
 * character, because their position differs between layouts (on a Danish keyboard "+" is where
 * "-" is on an English one).
 */
export function codeFor(e) {
  if (e.key === '+') return 'NumpadAdd';
  if (e.key === '-' || e.key === '−') return 'NumpadSubtract';
  return e.code;
}

export const AXES = ['forward', 'right', 'up', 'orbitH', 'orbitV', 'yaw', 'pitch'];

/** Rows for the help table: keys, what they do. */
export const NAV_HELP = [
  ['W / S  (or + / −)', 'move forward / back = zoom in / out'],
  ['A / D', 'move sideways (strafe) left / right'],
  ['E / Q  (or Page Up / Down)', 'move straight up / down'],
  ['← / →', 'rotate around the point in the middle of the screen'],
  ['↑ / ↓', 'orbit over / under that point (view from higher / lower)'],
  ['J / L,  I / K', 'turn your head left / right, look up / down (stay in place)'],
  ['Shift (hold)', '4× faster'],
  ['N', 'north up (rotate around the centre point until north is up)'],
  ['T', 'top-down view of the centre point (for map figures)'],
  ['H', 'home: show all loaded models'],
];

export const MIN_DISTANCE_M = 0.3; // never move closer than this to the surface ahead
export const ORBIT_RATE = 0.7; // rad/s
export const TURN_RATE = 0.6; // rad/s

/**
 * Combine the pressed keys (a Set of KeyboardEvent.code values, plus pad buttons that use the
 * same codes) into a motion vector: each axis -1, 0 or +1.
 */
export function motionFromKeys(pressed) {
  const m = Object.fromEntries(AXES.map((a) => [a, 0]));
  for (const code of pressed) {
    const k = KEYMAP[code];
    if (k) m[k[0]] += k[1];
  }
  for (const a of AXES) m[a] = Math.sign(m[a]); // opposite keys cancel
  return m;
}

export const isMoving = (m) => AXES.some((a) => m[a] !== 0);

/**
 * Translation speed in m/s. It scales with the distance to what you are looking at, so the same
 * key press feels the same at outcrop scale (a few metres) and at overview scale (kilometres):
 * at speed factor 1 you cover half the remaining distance per second.
 */
export function moveSpeed(distance, { fast = false, factor = 1 } = {}) {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 100;
  const v = Math.min(Math.max(d * 0.5, 0.25), 20000);
  return v * factor * (fast ? 4 : 1);
}

/**
 * Forward step for one frame: `speed * dt`, but never closer than MIN_DISTANCE_M to the surface
 * straight ahead (`ahead` = distance to it, or undefined if nothing is ahead).
 */
export function forwardStep(speed, dt, direction, ahead) {
  let step = speed * dt * direction;
  if (direction > 0 && Number.isFinite(ahead)) step = Math.min(step, Math.max(ahead - MIN_DISTANCE_M, 0));
  return step;
}

/** Rotation for one frame (radians). */
export const angleStep = (rate, dt, direction, { fast = false } = {}) => rate * dt * direction * (fast ? 2 : 1);

/** Smallest signed angle a - b, in (-π, π]. */
export function angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** True when keyboard input is meant for a text field rather than for the 3D view. */
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color'].includes((el.type || '').toLowerCase());
}

/** Mouse layouts. 'model' = orbit on left drag (default); 'map' = CesiumJS default. */
export const MOUSE_MODES = {
  model: {
    label: 'Model (orbit with left drag)',
    help: [
      ['Left drag', 'rotate / orbit around the point under the mouse'],
      ['Right drag  (or Ctrl + left drag)', 'pan (move sideways)'],
      ['Wheel', 'zoom in / out towards the mouse pointer'],
      ['Middle drag', 'zoom'],
      ['Shift + left drag', 'look around (turn your head)'],
    ],
  },
  map: {
    label: 'Map (CesiumJS default)',
    help: [
      ['Left drag', 'pan (move the map)'],
      ['Right drag  or  wheel', 'zoom in / out'],
      ['Middle drag  (or Ctrl + left drag)', 'rotate / tilt around the point under the mouse'],
      ['Shift + left drag', 'look around (turn your head)'],
    ],
  },
};
