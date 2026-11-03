import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tracksFrom, sample, poseValues, flatTracks, joystickFormula, sliderFormula, switchFormula,
  easeCubic, mirrorCubic, factorKeys, mirrorVertices, ORDERS, safeName, poseScript,
} from "../ui/engine.js";

const rows = [
  { objectId: "1-1", propertyKey: 24, propertyName: "x", frame: 0, type: "double", value: 10, keyframeId: "k0", interpolationType: "linear" },
  { objectId: "1-1", propertyKey: 24, propertyName: "x", frame: 2, type: "double", value: 30, keyframeId: "k2", interpolationType: "linear" },
  { objectId: "1-1", propertyKey: 24, propertyName: "x", frame: 1, type: "double", value: -5, keyframeId: "k1", interpolationType: "linear" },
  { objectId: "1-1", propertyKey: 25, propertyName: "y", frame: 0, type: "double", value: 7, keyframeId: "y0", interpolationType: "linear" },
  { objectId: "1-1", propertyKey: 25, propertyName: "y", frame: 4, type: "double", value: 7, keyframeId: "y4", interpolationType: "linear" },
  { objectId: "1-2", propertyKey: 9, propertyName: "visible", frame: 0, type: "bool", value: true },
];

test("tracks are grouped per object property, numbers only, sorted by frame", () => {
  const t = tracksFrom(rows);
  assert.equal(t.size, 2);
  assert.deepEqual(t.get("1-1|24").keys.map(k => k.frame), [0, 1, 2]);
});

test("sampling interpolates missing frames the way the timeline plays", () => {
  const keys = tracksFrom(rows).get("1-1|25").keys;
  assert.equal(sample(keys, 2), 7);
  const hold = [{ frame: 0, value: 0, interpolationType: "hold" }, { frame: 4, value: 8 }];
  assert.equal(sample(hold, 2), 0);
  assert.equal(sample(hold, 4), 8);
  assert.equal(sample([{ frame: 0, value: 0 }, { frame: 4, value: 8 }], 1), 2);
});

test("flat tracks are found across the pose frames", () => {
  const flat = flatTracks(tracksFrom(rows), [0, 1, 2, 3, 4]);
  assert.deepEqual(flat.map(t => t.propertyKey), [25]);
});

test("joystick formula: origin plus each direction's delta times its factor", () => {
  const v = [10, -5, 30, 10, 12];                       // origin, L, R, U, D in "L, R, U, D" order
  const f = joystickFormula("Head", "look", v, ORDERS["L, R, U, D"]);
  assert.equal(f, "10 + (-15 * {{Head/look_fL}}) + (20 * {{Head/look_fR}}) + (2 * {{Head/look_fD}})");
  assert.equal(joystickFormula("Head", "look", [3, 3, 3, 3, 3], ORDERS["J&S (R, L, U, D)"]), null);
});

test("joystick formula evaluates to J&S additive results", () => {
  const v = [10, -5, 30, 4, 12];
  const f = joystickFormula("H", "r", v, ORDERS["L, R, U, D"]);
  const evalAt = w => Function(...Object.keys(w), `return ${f.replace(/\{\{H\/r_(f[LRUD])\}\}/g, "$1")};`)(...Object.values(w));
  assert.equal(evalAt({ fL: 0, fR: 1, fU: 0, fD: 0 }), 30);
  assert.equal(evalAt({ fL: 0, fR: 1, fU: 1, fD: 0 }), 30 + (4 - 10));   // corner: both deltas in full
  assert.equal(evalAt({ fL: 0.5, fR: 0, fU: 0, fD: 0 }), 2.5);
});

test("slider formula clamps to positive unless negatives are allowed", () => {
  assert.equal(sliderFormula("H", "s", [0, 10, 0, -4], false),
    "0 + (10 * max(0, {{H/s_s1}}) / 100) + (-4 * max(0, {{H/s_s3}}) / 100)");
  assert.equal(sliderFormula("H", "s", [1, 2], true), "1 + (1 * {{H/s_s1}} / 100)");
});

test("switch formula keeps only the nearest item visible", () => {
  const items = [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }];
  const pow = Math.pow, min = Math.min, max = Math.max, ceil = Math.ceil;
  const run = (i, x, y) => Function("pow", "min", "max", "ceil", `return ${switchFormula("H", "j", items, i)
    .replace(/\{\{H\/j_x\}\}/g, `(${x})`).replace(/\{\{H\/j_y\}\}/g, `(${y})`)};`)(pow, min, max, ceil);
  assert.deepEqual([0, 1, 2].map(i => run(i, 0.9, 0.1)), [0, 1, 0]);
  assert.deepEqual([0, 1, 2].map(i => run(i, -0.2, -0.9)), [0, 0, 1]);
  // Rive's formula parser rejects a minus followed by a negative number
  assert.ok(items.every((_, i) => !/-\s*-/.test(switchFormula("H", "j", items, i))));
});

test("ease bias: 0 is linear, +100 sine-out, −100 sine-in; mirrored for edge→centre keys", () => {
  assert.deepEqual(Object.values(easeCubic(0)).map(v => +v.toFixed(4)), [0.3333, 0.3333, 0.6667, 0.6667]);
  assert.deepEqual(easeCubic(100), { x1: 0.39, y1: 0.575, x2: 0.565, y2: 1 });
  assert.deepEqual(easeCubic(-100), { x1: 0.47, y1: 0, x2: 0.745, y2: 0.715 });
  const m = mirrorCubic(easeCubic(100));
  assert.deepEqual(Object.values(m).map(v => +v.toFixed(3)), [0.435, 0, 0.61, 0.425]);
});

test("factor keys: centre is 0, each edge reaches 1", () => {
  const keys = factorKeys({ L: "nL", R: "nR", U: "nU", D: "nD" }, "X");
  const at = (id, f) => keys.find(k => k.objectId === id && k.frame === f).value;
  assert.equal(at("nL", 0), 1); assert.equal(at("nL", 30), 0); assert.equal(at("nR", 60), 1); assert.equal(at("nR", 30), 0);
  assert.equal(factorKeys({ U: "nU", D: "nD" }, "Y", { D: 50 }).find(k => k.objectId === "nD" && k.frame === 30).interpolationType, "cubic");
});

test("path flip mirrors around the first vertex", () => {
  const v = [{ x: 10, y: 0, rotation: 30 }, { x: 20, y: 5, inRotation: 90, outRotation: 0 }];
  assert.deepEqual(mirrorVertices(v).map(p => [p.x, p.y]), [[10, 0], [0, 5]]);
  assert.equal(mirrorVertices(v)[0].rotation, 150);
  assert.deepEqual(mirrorVertices(v, true).map(p => [p.x, p.y, p.outRotation]), [[10, 0, undefined], [20, -5, -0]]);
});

test("rig names are safe view model property prefixes", () => {
  assert.equal(safeName(" Head look! "), "Head_look");
  assert.equal(safeName(""), "rig");
});

test("pose script carries origins, per-direction deltas and ease bias", () => {
  const src = poseScript("look", [{ values: [100, 60, 140, 100, 100] }, { values: [1, 1, 1, 0.25, 1] }], ORDERS["L, R, U, D"], { L: 50, D: -120 });
  assert.match(src, /export class Poser_look extends Node/);
  assert.match(src, /const COUNT = 2;/);
  assert.match(src, /const EASE: StaticArray<f64> = \[50, 0, 0, -100\];/);
  assert.match(src, /const ORIGIN: StaticArray<f64> = \[100, 1\];/);
  assert.match(src, /const DL: StaticArray<f64> = \[-40, 0\];/);
  assert.match(src, /const DR: StaticArray<f64> = \[40, 0\];/);
  assert.match(src, /const DU: StaticArray<f64> = \[0, -0.75\];/);
});
