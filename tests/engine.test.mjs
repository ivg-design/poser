import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tracksFrom, sample, poseValues, flatTracks, joystickFormula, sliderFormula, switchFormula,
  easeCubic, mirrorCubic, factorKeys, mirrorVertices, ORDERS, safeName, poseScript,
  sliderInputs, axisFormula, axisRest, connectionTimeline, itemSpots, numInputScriptLuau, togglerScriptLuau,
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

test("slider formula reads the picked inputs, and a blank pick makes a new number", () => {
  assert.deepEqual(sliderInputs("n", 3, ["open", "", undefined]), ["open", "n_s2", "n_s3"]);
  const f = sliderFormula("V", "n", [0, 10, 20], true, ["open", "n_s2"]);
  assert.match(f, /\{\{V\/open\}\}/);
  assert.match(f, /\{\{V\/n_s2\}\}/);
  assert.match(sliderFormula("V", "n", [0, 10], false), /\{\{V\/n_s1\}\}/);
});

test("a slider's whole travel is 0 to 100; with negatives the centre is 0", () => {
  const run = (f, x) => Function("Input", `return ${f.replace("{Input}", "Input")}`)(x);
  assert.equal(run(axisFormula(false), axisRest(false)), 0);
  assert.equal(run(axisFormula(false), 1), 100);
  assert.equal(run(axisFormula(true), axisRest(true)), 0);
  assert.equal(run(axisFormula(true), -1), -100);
});

test("connection timelines are named after the rig and input", () => {
  assert.equal(connectionTimeline("num", "num_s1"), "num s1");
  assert.equal(connectionTimeline("num", "openness"), "num openness");
});

test("toggler spots: a ring on both axes, a line on one", () => {
  assert.deepEqual(itemSpots(3, "x").map(s => s.x), [-1, 0, 1]);
  assert.ok(itemSpots(3, "x").every(s => s.y === 0));
  assert.deepEqual(itemSpots(2, "y").map(s => s.y), [-1, 1]);
  const ring = itemSpots(4, "xy");
  assert.deepEqual([ring[0].x, ring[0].y], [0, -1]);
});

test("a one-axis toggler formula reads only that axis and picks the nearest", () => {
  const items = [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }];
  const pos = { x: "t_x", y: null };
  const f = i => switchFormula("V", "t", items, i, pos);
  assert.ok(!/t_y/.test(f(0)));
  const run = (i, x) => Function("x", "pow", "min", "max", "ceil",
    `return ${f(i).replaceAll("{{V/t_x}}", "x")}`)(x, Math.pow, Math.min, Math.max, Math.ceil);
  assert.deepEqual([run(0, 0.9), run(1, 0.9), run(2, 0.9)], [0, 0, 1]);
  assert.deepEqual([run(0, -0.1), run(1, -0.1), run(2, -0.1)], [0, 1, 0]);
});

test("NumInput and Toggler scripts carry their inputs and values, with no --!strict", () => {
  const n = numInputScriptLuau("num", ["openness", "num_s2"], [{ values: [1, 11, 21] }, { values: [2, 2, 5] }], false);
  assert.match(n, /local INPUTS = \{ "openness", "num_s2" \}/);
  assert.match(n, /local ORIGIN = \{ 1, 2 \}/);
  assert.match(n, /\{ 10, 0 \},\n  \{ 20, 3 \},/);
  assert.match(n, /math\.max\(0, input\(self, j\)\)/);
  assert.ok(!numInputScriptLuau("num", ["a"], [{ values: [0, 1] }], true).includes("math.max"));
  const t = togglerScriptLuau("t", [{ x: -1, y: 0 }, { x: 1, y: 0 }], { x: "t_x", y: null });
  assert.match(t, /local INPUTS = \{ "t_x" \}/);
  assert.match(t, /\{ -1, 1 \},/);
  assert.ok(![n, t].some(s => s.includes("--!strict")));
});
