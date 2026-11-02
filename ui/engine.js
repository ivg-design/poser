// Poser engine — pure functions, no editor access (unit-tested in tests/).
//
// The rig model follows Joysticks 'n Sliders: an origin pose on frame 0 and
// further poses on the following frames. Every bound property becomes
//   origin + Σ (pose − origin) · weight
// evaluated by a Rive formula converter, so nothing runs as a script.
//   joystick: weights fL fR fU fD (0..1) — the joystick scrubs two short
//             timelines that drive four factor nodes, and the factors' keyframe
//             curves are the per-direction ease bias. X and Y add, so a corner
//             gets both poses in full.
//   sliders:  weights s1..sN (0..100), optionally negative for inverse poses.
//   switch:   only the item nearest to the joystick position is visible.

export const EPS = 1e-4;
export const FACTOR_FRAMES = 60;            // factor timelines: edge −1 at 0, centre at 30, edge +1 at 60
export const DIRECTIONS = ["L", "R", "U", "D"];

// Pose frame orders. J&S keys right before left; this head was keyed left first.
export const ORDERS = {
  "J&S (R, L, U, D)": { R: 1, L: 2, U: 3, D: 4 },
  "L, R, U, D": { L: 1, R: 2, U: 3, D: 4 },
};

// ---------------------------------------------------------------- keyframes

// queryKeyFrames rows → tracks keyed `${objectId}|${propertyKey}` (numbers only)
export function tracksFrom(rows) {
  const tracks = new Map();
  for (const r of rows || []) {
    if (r.type !== "double") continue;
    const key = `${r.objectId}|${r.propertyKey}`;
    if (!tracks.has(key)) {
      tracks.set(key, { objectId: r.objectId, propertyKey: r.propertyKey, propertyName: r.propertyName, keys: [] });
    }
    tracks.get(key).keys.push({ frame: r.frame, value: r.value, keyframeId: r.keyframeId, interpolationType: r.interpolationType });
  }
  for (const t of tracks.values()) t.keys.sort((a, b) => a.frame - b.frame);
  return tracks;
}

// value of a track at a frame, the way the timeline plays it between keys
export function sample(keys, frame) {
  if (!keys.length) return NaN;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      if (a.interpolationType === "hold") return frame === b.frame ? b.value : a.value;
      return a.value + (b.value - a.value) * (frame - a.frame) / (b.frame - a.frame);
    }
  }
  return last.value;
}

export const poseValues = (track, frames) => frames.map(f => sample(track.keys, f));

// tracks whose value never changes across the pose frames (J&S "Unkey Flat")
export function flatTracks(tracks, frames) {
  const out = [];
  for (const t of tracks.values()) {
    const v = poseValues(t, frames);
    if (v.every(x => Math.abs(x - v[0]) < EPS)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- formulas

const num = v => {
  const s = (Math.round(v * 1e4) / 1e4).toString();
  return s === "-0" ? "0" : s;
};
export const vmRef = (vmName, prop) => `{{${vmName}/${prop}}}`;

// origin + Σ (pose − origin)·weight; null when no pose moves the property
function sumFormula(origin, terms) {
  const parts = terms.filter(t => Math.abs(t.delta) > EPS).map(t => `(${num(t.delta)} * ${t.weight})`);
  if (!parts.length) return null;
  return [num(origin), ...parts].join(" + ");
}

export function joystickFormula(vmName, rig, values, order) {
  return sumFormula(values[0], DIRECTIONS.map(d => ({
    delta: values[order[d]] - values[0],
    weight: vmRef(vmName, `${rig}_f${d}`),
  })));
}

export function sliderFormula(vmName, rig, values, allowNegative) {
  return sumFormula(values[0], values.slice(1).map((v, i) => {
    const s = vmRef(vmName, `${rig}_s${i + 1}`);
    return { delta: v - values[0], weight: allowNegative ? `${s} / 100` : `max(0, ${s}) / 100` };
  }));
}

// switch: 1 when this item is (one of) the nearest to the joystick position, else 0
export function switchFormula(vmName, rig, items, index) {
  const x = vmRef(vmName, `${rig}_x`), y = vmRef(vmName, `${rig}_y`);
  const d = it => `(pow(${x} - ${num(it.x)}, 2) + pow(${y} - ${num(it.y)}, 2))`;
  const nearest = items.map(d).reduce((acc, term) => (acc ? `min(${acc}, ${term})` : term), "");
  return `1 - min(1, ceil(max(0, ${d(items[index])} - ${nearest}) * 1000000))`;
}

// ---------------------------------------------------------------- ease bias

// J&S EaseBias: −100 eases in (1 − cos), +100 eases out (sin), 0 is linear.
// Cubic stand-ins for the sine curves, blended from the linear handles.
const LINEAR = [1 / 3, 1 / 3, 2 / 3, 2 / 3];
const SINE_OUT = [0.39, 0.575, 0.565, 1];
const SINE_IN = [0.47, 0, 0.745, 0.715];
export function easeCubic(bias) {
  const t = Math.min(1, Math.abs(bias) / 100);
  const target = bias >= 0 ? SINE_OUT : SINE_IN;
  const [x1, y1, x2, y2] = LINEAR.map((v, i) => v + (target[i] - v) * t);
  return { x1, y1, x2, y2 };
}
// the same curve run backwards in time (left / up keys go edge → centre)
export const mirrorCubic = c => ({ x1: 1 - c.x2, y1: 1 - c.y2, x2: 1 - c.x1, y2: 1 - c.y1 });

// keys for the factor nodes: X timeline drives fL/fR, Y timeline fU/fD
export function factorKeys(nodeIds, axis, bias = {}) {
  const [neg, pos] = axis === "X" ? ["L", "R"] : ["U", "D"];
  const mid = FACTOR_FRAMES / 2;
  const key = (dir, frame, value, cubic) => ({
    objectId: nodeIds[dir], propertyKey: 13, frame, value,
    ...(cubic ? { interpolationType: "cubic", cubicParams: cubic } : { interpolationType: "linear" }),
  });
  return [
    key(neg, 0, 1, mirrorCubic(easeCubic(bias[neg] || 0))),
    key(neg, mid, 0), key(neg, FACTOR_FRAMES, 0),
    key(pos, 0, 0), key(pos, mid, 0, easeCubic(bias[pos] || 0)),
    key(pos, FACTOR_FRAMES, 1),
  ];
}

// ---------------------------------------------------------------- path flip

// mirror path vertices around the first vertex (horizontally, or vertically);
// rotations are in degrees, as the editor shows them
export function mirrorVertices(vertices, vertical = false) {
  if (!vertices.length) return [];
  const ax = vertices[0].x, ay = vertices[0].y;
  const flipAngle = a => (a === undefined ? undefined : vertical ? -a : 180 - a);
  return vertices.map(v => ({
    ...v,
    x: vertical ? v.x : 2 * ax - v.x,
    y: vertical ? 2 * ay - v.y : v.y,
    rotation: flipAngle(v.rotation),
    inRotation: flipAngle(v.inRotation),
    outRotation: flipAngle(v.outRotation),
  }));
}

// ---------------------------------------------------------------- naming

export const safeName = s => (s || "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "rig";
export const converterName = (rig, objectId, propertyName) => `poser ${rig} ${objectId} ${propertyName}`;
