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
  // Rive's formula parser rejects "a - -0.5", so a negative spot is added instead of subtracted
  const less = (a, c) => (num(c).startsWith("-") ? `${a} + ${num(-c)}` : `${a} - ${num(c)}`);
  const d = it => `(pow(${less(x, it.x)}, 2) + pow(${less(y, it.y)}, 2))`;
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
// ---------------------------------------------------------------- script rig

// The script rig's view model: the artboard's view model gets one nested property, `<rig>`, a
// view model holding the joystick position (x, y) and one number per posed property (p0…pN).
export const scriptVmName = rig => `poser ${rig}`;
export const scriptName = rig => `poser ${rig}`;
const list = vs => vs.map(num).join(", ");

// AnimaScript source for a joystick rig. rows: [{ values }] with values on frames 0…4; order maps
// each direction to its frame. The joystick's x/y (−1…1) become four eased direction factors
// (J&S EaseBias: linear blended toward sin for +bias, 1 − cos for −bias), and each property is
// origin + Σ (pose − origin) · factor, written to its view-model number.
export function poseScript(rig, rows, order, bias = {}) {
  const delta = d => rows.map(r => r.values[order[d]] - r.values[0]);
  const ease = DIRECTIONS.map(d => num(Math.max(-100, Math.min(100, bias[d] || 0))));
  return `// Poser rig "${rig}", generated by Poser 3. Binding the rig again or changing its ease
// bias in Poser rewrites this file.
//
// The joystick pushes x and y (-1 to 1) into the view model "${scriptVmName(rig)}". This script
// turns them into four eased direction factors and writes one number per posed property:
//   p = origin + (left - origin) * fL + (right - origin) * fR + (up - origin) * fU + (down - origin) * fD
// Each posed property is bound to its number. Corners add both poses in full.
import { Node, Context } from "rive/host";
import { PropertyNumber } from "rive/data";

const RIG = "${rig}";
const COUNT = ${rows.length};
// ease bias per direction, -100 (ease in) to 100 (ease out): L, R, U, D
const EASE: StaticArray<f64> = [${ease.join(", ")}];
const ORIGIN: StaticArray<f64> = [${list(rows.map(r => r.values[0]))}];
const DL: StaticArray<f64> = [${list(delta("L"))}];
const DR: StaticArray<f64> = [${list(delta("R"))}];
const DU: StaticArray<f64> = [${list(delta("U"))}];
const DD: StaticArray<f64> = [${list(delta("D"))}];

function ease(t: f64, bias: f64): f64 {
    let b = Math.min(1, Math.abs(bias) / 100);
    let curve = bias >= 0 ? Math.sin(t * Math.PI / 2) : 1 - Math.cos(t * Math.PI / 2);
    return t + (curve - t) * b;
}

export class ${className(rig)} extends Node {
    x: PropertyNumber? = null;
    y: PropertyNumber? = null;
    outs: Array<PropertyNumber> = [];
    slots: Array<i32> = [];
    context: Context? = null;
    ready: bool = false;
    tries: i32 = 0;

    override init(context: Context): bool {
        this.context = context;
        this.connect();
        return true;
    }

    // the view model may not be bound yet when init runs, so keep trying for a while
    override advance(seconds: f64): bool {
        if (this.ready) return false;
        this.connect();
        return !this.ready;
    }

    connect(): void {
        let context = this.context;
        if (context == null) return;
        let vm = context.viewModel();
        if (vm == null) vm = context.rootViewModel();
        let nested = vm == null ? null : vm.getViewModel(RIG);
        if (nested == null) {
            this.tries++;
            if (this.tries == 120) context.log("Poser " + RIG + ": no view model property '" + RIG + "' reached this script.");
            return;
        }
        let poses = nested.value;
        this.x = poses.getNumber("x");
        this.y = poses.getNumber("y");
        for (let i = 0; i < COUNT; i++) {
            let p = poses.getNumber("p" + i.toString());
            if (p != null) {
                this.outs.push(p);
                this.slots.push(i);
            }
        }
        let x = this.x;
        let y = this.y;
        if (x != null) x.addListenerWith(this, (self: ${className(rig)}): void => { self.apply(); });
        if (y != null) y.addListenerWith(this, (self: ${className(rig)}): void => { self.apply(); });
        this.ready = true;
        this.apply();
    }

    apply(): void {
        let px = this.x;
        let py = this.y;
        let jx = px == null ? 0 : Math.max(-1, Math.min(1, px.value));
        let jy = py == null ? 0 : Math.max(-1, Math.min(1, py.value));
        let fL = ease(Math.max(0, -jx), EASE[0]);
        let fR = ease(Math.max(0, jx), EASE[1]);
        let fU = ease(Math.max(0, -jy), EASE[2]);
        let fD = ease(Math.max(0, jy), EASE[3]);
        for (let k = 0; k < this.outs.length; k++) {
            let i = this.slots[k];
            this.outs[k].value = ORIGIN[i] + DL[i] * fL + DR[i] * fR + DU[i] * fU + DD[i] * fD;
        }
    }
}
`;
}
const className = rig => `Poser_${rig}`;

// What Poser puts in a script it creates: an empty Node, so the script can be dropped on an
// artboard before the rig is bound (a utility script cannot be placed).
export function placeholderScript(rig, language) {
  const T = className(rig);
  return language === "luau" ? `-- Poser rig "${rig}". Drop this script on the artboard, then bind the rig in Poser,
-- which writes its code here.
type ${T} = {}

function draw(self: ${T}, renderer: Renderer) end

return function(): Node<${T}>
  return { draw = draw }
end
` : `// Poser rig "${rig}". Drop this script on the artboard, then bind the rig in Poser,
// which writes its code here.
import { Node } from "rive/host";

export class ${T} extends Node {}
`;
}

// The same rig as Luau, for an editor Node script (the editor's script templates are Luau, and a
// Luau script asset stays Luau whatever it holds). Tables are 1-based; numbers are p0…pN.
export function poseScriptLuau(rig, rows, order, bias = {}) {
  const delta = d => rows.map(r => r.values[order[d]] - r.values[0]);
  const ease = DIRECTIONS.map(d => num(Math.max(-100, Math.min(100, bias[d] || 0))));
  const T = className(rig);
  return `-- Poser rig "${rig}", generated by Poser 3. Binding the rig again or changing its ease
-- bias in Poser rewrites this file.
--
-- The joystick pushes x and y (-1 to 1) into the view model "${scriptVmName(rig)}". This script
-- turns them into four eased direction factors and writes one number per posed property:
--   p = origin + (left - origin) * fL + (right - origin) * fR + (up - origin) * fU + (down - origin) * fD
-- Each posed property is bound to its number. Corners add both poses in full.

type ${T} = {
  context: Context?,
  poses: ViewModel?,
  x: Property<number>?,
  y: Property<number>?,
  outs: { Property<number> },
  slots: { number },
  ready: boolean,
}

local RIG = "${rig}"
local COUNT = ${rows.length}
-- ease bias per direction, -100 (ease in) to 100 (ease out): L, R, U, D
local EASE = { ${ease.join(", ")} }
local ORIGIN = { ${list(rows.map(r => r.values[0]))} }
local DL = { ${list(delta("L"))} }
local DR = { ${list(delta("R"))} }
local DU = { ${list(delta("U"))} }
local DD = { ${list(delta("D"))} }

local function ease(t: number, bias: number): number
  local b = math.min(1, math.abs(bias) / 100)
  local curve = if bias >= 0 then math.sin(t * math.pi / 2) else 1 - math.cos(t * math.pi / 2)
  return t + (curve - t) * b
end

local function apply(self: ${T})
  local px = self.x
  local py = self.y
  local jx = if px then math.clamp(px.value, -1, 1) else 0
  local jy = if py then math.clamp(py.value, -1, 1) else 0
  local fL = ease(math.max(0, -jx), EASE[1])
  local fR = ease(math.max(0, jx), EASE[2])
  local fU = ease(math.max(0, -jy), EASE[3])
  local fD = ease(math.max(0, jy), EASE[4])
  for k, p in self.outs do
    local i = self.slots[k]
    p.value = ORIGIN[i] + DL[i] * fL + DR[i] * fR + DU[i] * fU + DD[i] * fD
  end
end

-- the view model is absent on the first init, so keep trying until it is there
local function connect(self: ${T})
  local context = self.context
  if self.ready or context == nil then
    return
  end
  local vm = context:viewModel()
  if vm == nil then
    return
  end
  local nested = vm:getViewModel(RIG)
  if nested == nil then
    return
  end
  local poses = nested.value
  self.poses = poses
  self.x = poses:getNumber("x")
  self.y = poses:getNumber("y")
  for i = 1, COUNT do
    local p = poses:getNumber("p" .. tostring(i - 1))
    if p then
      table.insert(self.outs, p)
      table.insert(self.slots, i)
    end
  end
  local x = self.x
  local y = self.y
  if x then
    x:addListener(function()
      apply(self)
    end)
  end
  if y then
    y:addListener(function()
      apply(self)
    end)
  end
  self.ready = true
  apply(self)
end

function init(self: ${T}, context: Context): boolean
  self.context = context
  connect(self)
  return true
end

function advance(self: ${T}, seconds: number): boolean
  connect(self)
  return not self.ready
end

function update(self: ${T}) end

function draw(self: ${T}, renderer: Renderer) end

return function(): Node<${T}>
  return {
    context = nil,
    poses = nil,
    x = nil,
    y = nil,
    outs = {},
    slots = {},
    ready = false,
    init = init,
    advance = advance,
    update = update,
    draw = draw,
  }
end
`;
}

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
