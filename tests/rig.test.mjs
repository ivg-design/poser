import { test } from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../ui/rig.js";

test("PathFlipper resolves the selected path when Rive returns vertices before their parent", async () => {
  let written;
  const mcp = async (tool, args) => {
    if (tool === "get_selection") return { selection: [{ id: "path" }] };
    if (tool === "query_objects") return { objects: [
      { id: "a", types: ["StraightVertex"] },
      { id: "b", types: ["StraightVertex"] },
      { id: "path", children: ["a", "b"] },
    ] };
    if (tool === "query_property_values") return { values: { a: { 24: 10, 25: 20 }, b: { 24: 40, 25: 60 } } };
    if (tool === "set_property_values") { written = args.propertyValues; return { success: true }; }
    throw new Error("Unexpected tool: " + tool);
  };
  assert.equal(await createRig(mcp).pathFlip({ vertical: false }), 2);
  assert.deepEqual(written, { a: { 24: 10, 25: 20 }, b: { 24: -20, 25: 60 } });
});

test("manifests keep the newer copy when the in-file record is older than the app's", async () => {
  const MARK = "POSER-RECORD";
  const rec = m => `--[==[${MARK}\n${JSON.stringify(m)}\n${MARK}]==]\nreturn {}\n`;
  const local = { rig: "a", file: "F", kind: "sliders", savedAt: 2, sliders: 3 };
  const files = { "poser a dataBkp": rec({ rig: "a", kind: "sliders", savedAt: 1, sliders: 2 }),
    "poser b dataBkp": rec({ rig: "b", kind: "joystick" }) };
  const mcp = async (tool, args) => {
    if (tool === "session_info") return { activeFileId: "F" };
    if (tool === "assets_tool") return { assets: Object.keys(files).map((name, i) => ({ id: `s${i}`, name, type: "ScriptAsset" })) };
    if (tool === "text_editor") return { content: files[args.path ?? args.name] ?? "" };
    throw new Error("Unexpected tool: " + tool);
  };
  const store = { list: async () => [JSON.stringify(local)] };
  const ms = await createRig(mcp, () => {}, store).manifests();
  assert.equal(ms.find(m => m.rig === "a").sliders, 3);
  assert.equal(ms.find(m => m.rig === "b").kind, "joystick");
});

test("a joystick axis that already drives a NumInput rig is refused", async () => {
  const sliders = { rig: "s", file: "F", kind: "sliders", vmId: "vm", connections: [{ joystickId: "J", axis: "x", slider: "s_s1" }] };
  const mcp = async tool => {
    if (tool === "session_info") return { activeFileId: "F" };
    if (tool === "assets_tool") return { assets: [] };
    throw new Error("Unexpected tool: " + tool);
  };
  const rig = createRig(mcp, () => {}, { list: async () => [JSON.stringify(sliders)] });
  await assert.rejects(rig.bindJoystickToSlider({ sliderRig: "s", slider: "s_s2", joystickId: "J", axis: "x" }), /already drives s_s1/);
});

test("binding a property that is still bound is refused before anything is made", async () => {
  const made = [];
  const mcp = async (tool, args) => {
    if (tool === "viewmodel_editor" && args.command === "listDataBinds") return { dataBinds: [
      { objectId: "J", propertyKey: 299, property: "x", objectName: "example control", viewModelPropertyName: "numbers_s1" }] };
    if (tool === "session_info") return { activeFileId: "F" };
    if (tool === "assets_tool") return { assets: [] };
    if (tool === "viewmodel_editor" && args.command === "listViewModels")
      return { viewModels: [{ id: "vm", viewModelProperties: [{ id: "p", name: "s_s1" }] }] };
    made.push(tool);
    return { ids: ["c"], converters: [{ id: "c" }] };
  };
  const sliders = { rig: "s", file: "F", kind: "sliders", vmId: "vm", artboardId: "A" };
  const rig = createRig(mcp, () => {}, { list: async () => [JSON.stringify(sliders)] });
  await assert.rejects(rig.bindJoystickToSlider({ sliderRig: "s", slider: "s_s1", joystickId: "J", axis: "x" }),
    /x is still bound to numbers_s1/);
  assert.ok(!made.includes("group_editor"));
});

test("after Unbind, binding the same joystick again asks for a file reload", async () => {
  let binds = [{ objectId: "J", propertyKey: 299, property: "x", objectName: "pad", viewModelPropertyId: "p", viewModelPropertyName: "s_s1" }];
  const store = { items: [JSON.stringify({ rig: "s", file: "F", kind: "sliders", vmId: "vm", artboardId: "A", binds: ["b1"], addedProps: ["s_s1"] })],
    list: async () => store.items, remove: async () => { store.items = []; } };
  const mcp = async (tool, args) => {
    if (tool === "session_info") return { activeFileId: "F" };
    if (tool === "assets_tool") return { assets: [] };
    if (tool === "viewmodel_editor" && args.command === "listDataBinds") return { dataBinds: binds };
    if (tool === "viewmodel_editor" && args.command === "listViewModels")
      return { viewModels: [{ id: "vm", viewModelProperties: [{ id: "p", name: "s_s1" }] }] };
    if (tool === "delete_objects") return { deleted: args.objectIds };   // the editor still lists the bind
    throw new Error("Unexpected tool: " + tool);
  };
  const rig = createRig(mcp, () => {}, store);
  await rig.unbind((await rig.manifests())[0]);
  store.items = [JSON.stringify({ rig: "t", file: "F", kind: "sliders", vmId: "vm", artboardId: "A" })];
  await assert.rejects(rig.bindJoystickToSlider({ sliderRig: "t", slider: "s_s1", joystickId: "J", axis: "x" }), /reload the file \(Cmd\+R\)/i);
});

// a small stand-in for the editor: enough of the MCP for the NumInput and Toggler flows
function editor(extra = {}) {
  const calls = [];
  let binds = [];
  const vm = { id: "vm", name: "Board", viewModelProperties: [
    { id: "own", name: "openness", propertyType: "number" }, { id: "txt", name: "title", propertyType: "string" }] };
  let next = 100;
  const mcp = async (tool, args) => {
    calls.push({ tool, args });
    if (extra[tool]) { const r = extra[tool](args); if (r !== undefined) return r; }
    if (tool === "session_info") return { activeFileId: "F" };
    if (tool === "assets_tool") return { assets: [] };
    if (tool === "list_artboards") return { artboards: [{ id: "A", name: "Board", isActive: true }] };
    if (tool === "query_property_values") {
      if (args.propertyKeys.A) return { values: { A: { 583: "vm" } } };
      if (args.propertyKeys.T1) return { values: { T1: { 56: 24, 57: 48, 58: 1, 59: 0 } } };
      return { values: Object.fromEntries(Object.keys(args.propertyKeys).map(id => [id, { 18: 0.5 }])) };
    }
    if (tool === "group_editor") return { group: { id: `9-${next += 500}` } };
    if (tool === "query_objects") return { objects: args.objectIds.slice(0, 4).map(id => ({ id, types: ["DataBindContext"] })) };
    if (tool === "viewmodel_editor") {
      if (args.command === "listDataBinds") return { dataBinds: binds };
      if (args.command === "listViewModels") return { viewModels: [vm] };
      if (args.command === "createConverters") return { converters: args.data.createConverters.converters.map(() => ({ id: `c${next++}` })) };
      if (args.command === "addProperties") {
        for (const p of args.data.addProperties.viewModels[0].viewModelProperties) vm.viewModelProperties.push({ id: `p${next++}`, propertyType: "number", ...p });
        return {};
      }
      return {};
    }
    if (tool === "animation_editor") {
      if (args.command === "listLinearAnimations") return { linearAnimations: [{ id: "T1", name: "Timeline 1" }] };
      if (args.command === "createLinearAnimations") return { animations: args.data.createLinearAnimations.linearAnimations.map(a => ({ id: `tl ${a.name}`, name: a.name })) };
      if (args.command === "queryKeyFrames") return { keyframes: { T1: [0, 1, 2].map(frame => ({ objectId: "o", propertyKey: 13, propertyName: "x", frame, type: "double", value: frame * 10, keyframeId: `k${frame}` })) } };
      return {};
    }
    return {};
  };
  const saved = new Map();
  const store = { list: async () => [...saved.values()], save: async (n, j) => { saved.set(n, j); }, remove: async n => { saved.delete(n); } };
  return { mcp, calls, store, vm, setBinds: b => { binds = b; } };
}
const made = (calls, tool, command) => calls.filter(c => c.tool === tool && (!command || c.args.command === command));
const bindNumInput = (rig, inputs = []) => rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 2, inputs, allowNegative: false, removeKeys: false, selectedOnly: false });

test("a NumInput pose can read a number the view model already has, and Unbind leaves that number", async () => {
  const ed = editor();
  const rig = createRig(ed.mcp, () => {}, ed.store);
  const m = await bindNumInput(rig, ["openness", ""]);
  assert.deepEqual(m.sliders, ["openness", "num_s2"]);
  assert.deepEqual(m.addedProps, ["num_s2"]);
  const formula = JSON.stringify(made(ed.calls, "viewmodel_editor").filter(c => /onverter/.test(c.args.command || "")).map(c => c.args));
  assert.match(formula, /Board\/openness/);
  assert.deepEqual(await rig.numbers("A"), ["openness"]);   // numbers a rig added aren't offered
  await rig.unbind((await rig.manifests())[0]);
  assert.ok(ed.calls.at(-1) && !made(ed.calls, "delete_objects").some(c => c.args.objectIds.includes("own")));
});

test("Connect puts an empty timeline on the axis and Disconnect takes it off again", async () => {
  const ed = editor();
  const rig = createRig(ed.mcp, () => {}, ed.store);
  await bindNumInput(rig);
  await rig.bindJoystickToSlider({ sliderRig: "num", slider: "num_s1", joystickId: "J", axis: "y" });
  const set = made(ed.calls, "set_property_values").find(c => c.args.propertyValues.J).args.propertyValues.J;
  assert.deepEqual(set, { 302: "tl num s1", 300: -1 });   // y timeline; the handle rests where the input is 0
  const m = (await rig.manifests())[0];
  const { bind, timeline } = m.connections[0];
  assert.equal(timeline, "tl num s1");
  await rig.disconnectSlider(m, "num_s1");
  assert.ok(made(ed.calls, "delete_objects").some(c => c.args.objectIds.includes("tl num s1")));
  const after = (await rig.manifests())[0];
  assert.deepEqual(after.connections, []);
  assert.equal(after.binds.includes(bind), false);
});

test("a second joystick on an input that already has one is refused", async () => {
  const ed = editor();
  const rig = createRig(ed.mcp, () => {}, ed.store);
  await bindNumInput(rig);
  await rig.bindJoystickToSlider({ sliderRig: "num", slider: "num_s1", joystickId: "J", axis: "x" });
  await assert.rejects(rig.bindJoystickToSlider({ sliderRig: "num", slider: "num_s1", joystickId: "K", axis: "x" }), /already has a joystick/);
});

const items = [{ id: "a", name: "a", x: -1, y: 0 }, { id: "b", name: "b", x: 1, y: 0 }];

test("a toggler on a free joystick owns it: slider timeline, first item at rest, opacity restored by Unbind", async () => {
  const ed = editor();
  const rig = createRig(ed.mcp, () => {}, ed.store);
  const m = await rig.bindToggler({ artboardId: "A", artboardName: "Board", rig: "t", joystickId: "J", axes: "x", items });
  assert.equal(m.kind, "toggler");
  assert.deepEqual(m.addedProps, ["t_x"]);
  assert.deepEqual(m.timelines, { X: "tl t X" });
  const set = made(ed.calls, "set_property_values").find(c => c.args.propertyValues.J).args.propertyValues.J;
  assert.deepEqual(set, { 301: "tl t X", 299: -1 });
  assert.equal(m.items[0].opacity, 0.5);
  await rig.unbind((await rig.manifests())[0]);
  const rest = made(ed.calls, "set_property_values").at(-1).args.propertyValues;
  assert.deepEqual(rest, { J: { 299: 0 }, a: { 18: 0.5 }, b: { 18: 0.5 } });
  assert.ok(made(ed.calls, "delete_objects").some(c => c.args.objectIds.includes("tl t X")));
  assert.equal((await rig.manifests()).length, 0);
});

test("a toggler reads a Joystick rig's joystick, and that rig can't be unbound under it", async () => {
  const ed = editor();
  ed.vm.viewModelProperties.push({ id: "lx", name: "look_x", propertyType: "number" }, { id: "ly", name: "look_y", propertyType: "number" });
  await ed.store.save("F__look", JSON.stringify({ rig: "look", file: "F", kind: "joystick", joystickId: "J", vmId: "vm", artboardId: "A", tracks: [], timelines: {}, nodes: {} }));
  const rig = createRig(ed.mcp, () => {}, ed.store);
  await assert.rejects(rig.bindToggler({ artboardId: "A", rig: "t", joystickId: "J", axes: "x", items }), /can't be a slider/);
  const m = await rig.bindToggler({ artboardId: "A", rig: "t", joystickId: "J", axes: "xy", items });
  assert.equal(m.source, "look");
  assert.deepEqual(m.addedProps, []);
  assert.deepEqual(m.timelines, {});
  const look = (await rig.manifests()).find(x => x.rig === "look");
  await assert.rejects(rig.unbind(look), /toggler "t" reads this rig's joystick/);
});

test("a rig name another tab already uses is refused, not unbound", async () => {
  const ed = editor();
  await ed.store.save("F__look", JSON.stringify({ rig: "look", file: "F", kind: "joystick", joystickId: "J", vmId: "vm", tracks: [] }));
  const rig = createRig(ed.mcp, () => {}, ed.store);
  await assert.rejects(rig.bindToggler({ artboardId: "A", rig: "look", joystickId: "K", axes: "xy", items }), /taken by a Joystick rig/);
  assert.equal(made(ed.calls, "delete_objects").length, 0);
});

test("the rig records which number each pose reads, and says when the timeline holds more poses", async () => {
  const ed = editor();
  const rig = createRig(ed.mcp, () => {}, ed.store);
  const m = await rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 1, inputs: [""], allowNegative: false, removeKeys: false, selectedOnly: false });
  assert.deepEqual(m.poseInputs, ["num_s1"]);
  assert.match(m.note, /keys up to frame 2, past pose 1/);
  assert.equal((await bindNumInput(rig)).note, "");
});

test("Only the selection with nothing selected is refused instead of binding everything", async () => {
  const ed = editor({ get_selection: () => ({ selection: [] }) });
  const rig = createRig(ed.mcp, () => {}, ed.store);
  await assert.rejects(rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 2, selectedOnly: true }), /nothing is selected/);
  assert.equal(made(ed.calls, "viewmodel_editor", "createConverters").length, 0);
});

// the pose timeline as the editor sees it at Unbind: still there, deleted, or deleted with its name reused
function timelineEditor() {
  const state = { alive: true, list: [{ id: "T1", name: "Timeline 1" }] };
  const ed = editor({
    query_objects: a => (a.objectIds[0] === "T1" ? { objects: state.alive ? [{ id: "T1", types: ["LinearAnimation"] }] : [] } : undefined),
    animation_editor: a => (a.command === "listLinearAnimations" ? { linearAnimations: state.list } : undefined),
  });
  return { ...ed, state, rig: createRig(ed.mcp, () => {}, ed.store) };
}
const bindAndRemoveKeys = rig => rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 2, allowNegative: false, removeKeys: true, selectedOnly: false });
const keysAddedTo = calls => made(calls, "animation_editor", "modifyKeyFrames").filter(c => c.args.data.modifyKeyFrames.add).map(c => c.args.data.modifyKeyFrames.animationId);
const created = calls => made(calls, "animation_editor", "createLinearAnimations").flatMap(c => c.args.data.createLinearAnimations.linearAnimations);

test("Unbind uses the original timeline when it still exists", async () => {
  const t = timelineEditor();
  await bindAndRemoveKeys(t.rig);
  const r = await t.rig.unbind((await t.rig.manifests())[0]);
  assert.deepEqual(keysAddedTo(t.calls), ["T1"]);
  assert.deepEqual(created(t.calls), []);
  assert.equal(r.recreated, undefined);
});

test("Unbind makes a deleted timeline again, with its name and settings, and puts the keys there", async () => {
  const t = timelineEditor();
  const m = await bindAndRemoveKeys(t.rig);
  assert.equal(m.timelineName, "Timeline 1");
  t.state.alive = false; t.state.list = [];
  const r = await t.rig.unbind((await t.rig.manifests())[0]);
  assert.deepEqual(created(t.calls), [{ name: "Timeline 1", duration: 2 }]);   // 48 frames at 24 fps
  assert.deepEqual(keysAddedTo(t.calls), ["tl Timeline 1"]);
  assert.equal(r.recreated, "Timeline 1");
  assert.ok(made(t.calls, "set_property_values").some(c => JSON.stringify(c.args.propertyValues["tl Timeline 1"]) === JSON.stringify({ 56: 24, 57: 48, 58: 1, 59: 0 })));
});

test("a different timeline that took the name is left alone", async () => {
  const t = timelineEditor();
  await bindAndRemoveKeys(t.rig);
  t.state.alive = false; t.state.list = [{ id: "T2", name: "Timeline 1" }];
  const r = await t.rig.unbind((await t.rig.manifests())[0]);
  assert.equal(r.recreated, "Timeline 1 restored");
  assert.deepEqual(keysAddedTo(t.calls), ["tl Timeline 1 restored"]);
});

test("a rig recorded before timelines were tracked still gets one, long enough for its keys", async () => {
  const t = timelineEditor();
  t.state.alive = false; t.state.list = [];
  await t.store.save("F__old", JSON.stringify({ rig: "old", file: "F", kind: "sliders", vmId: "vm", artboardId: "A", timelineId: "T1", keysRemoved: true,
    tracks: [{ objectId: "o", propertyKey: 13, keys: [{ frame: 0, value: 0 }, { frame: 89, value: 1 }] }] }));
  await t.rig.unbind((await t.rig.manifests())[0]);
  assert.deepEqual(created(t.calls), [{ name: "old poses", duration: 1.5 }]);   // 90 frames at 60 fps
  assert.deepEqual(keysAddedTo(t.calls), ["tl old poses"]);
});

test("if the timeline can't be made, Unbind stops before removing anything", async () => {
  const failing = editor({
    query_objects: a => (a.objectIds[0] === "T1" ? { objects: [] } : undefined),
    animation_editor: a => (a.command === "createLinearAnimations" ? { animations: [] } : undefined),
  });
  await failing.store.save("F__num", JSON.stringify({ rig: "num", file: "F", kind: "sliders", vmId: "vm", artboardId: "A", timelineId: "T1", timelineName: "Poses", keysRemoved: true, binds: ["b1"], tracks: [] }));
  const rig = createRig(failing.mcp, () => {}, failing.store);
  await assert.rejects(rig.unbind((await rig.manifests())[0]), /was not created/);
  assert.equal(made(failing.calls, "delete_objects").length, 0);
  assert.equal((await rig.manifests()).length, 1);
});

// a pose timeline whose keys carry the given curve fields
function curvedEditor(curve) {
  const ed = editor({ animation_editor: a => (a.command === "queryKeyFrames" ? { keyframes: { T1: [0, 1].map(frame => ({ objectId: "o", propertyKey: 13, propertyName: "x",
    frame, type: "double", value: frame * 10, keyframeId: `k${frame}`, ...curve })) } } : undefined) });
  return { ...ed, rig: createRig(ed.mcp, () => {}, ed.store) };
}
const bindCurved = rig => rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 1, allowNegative: false, removeKeys: true, selectedOnly: false });
const restored = calls => made(calls, "animation_editor", "modifyKeyFrames").flatMap(c => c.args.data.modifyKeyFrames.add || []);

test("Unbind puts custom curves back on the pose keys", async () => {
  const cubicParams = { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.9 };
  const t = curvedEditor({ interpolationType: "cubic", cubicParams });
  await bindCurved(t.rig);
  assert.doesNotMatch(t.rig.takeWarning(), /curve/);
  const record = (await t.rig.manifests())[0];
  assert.deepEqual(record.tracks[0].keys[1], { frame: 1, value: 10, interpolationType: "cubic", cubicParams });
  await t.rig.unbind(record);
  assert.deepEqual(restored(t.calls).map(k => [k.frame, k.interpolationType, k.cubicParams]), [[0, "cubic", cubicParams], [1, "cubic", cubicParams]]);
  assert.ok(restored(t.calls).every(k => !("keyframeId" in k)));
});

test("elastic keys keep their settings too", async () => {
  const elasticParams = { amplitude: 1.5, period: 0.5, easing: 1 };
  const t = curvedEditor({ interpolationType: "elastic", elasticParams });
  await bindCurved(t.rig);
  await t.rig.unbind((await t.rig.manifests())[0]);
  assert.deepEqual(restored(t.calls)[0].elasticParams, elasticParams);
});

test("a curve the editor didn't report is warned about at bind", async () => {
  const t = curvedEditor({ interpolationType: "cubic" });
  await bindCurved(t.rig);
  assert.match(t.rig.takeWarning(), /2 pose keys have curves Poser couldn't read/);
});

test("no warning when the keys stay on the timeline", async () => {
  const t = curvedEditor({ interpolationType: "cubic" });
  await t.rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 1, allowNegative: false, removeKeys: false, selectedOnly: false });
  assert.doesNotMatch(t.rig.takeWarning(), /curve/);
});

test("a record script with nothing in it is reported, not silently skipped", async () => {
  const assets = [{ id: "a1", name: "poser gone dataBkp", type: "ScriptAsset" }, { id: "a2", name: "poser kept dataBkp", type: "ScriptAsset" }];
  const mcp = async tool => {
    if (tool === "session_info") return { activeFileId: "F" };
    if (tool === "assets_tool") return { assets };
    if (tool === "text_editor") return "";
    if (tool === "query_property_values") return { values: {} };
    throw new Error("Unexpected tool: " + tool);
  };
  const rig = createRig(mcp, () => {}, { list: async () => [JSON.stringify({ rig: "kept", file: "F", kind: "sliders", tracks: [] })] });
  const ms = await rig.manifests();
  assert.deepEqual(ms.map(m => m.rig), ["kept"]);        // the app's copy still counts
  assert.deepEqual(rig.unreadableRecords(), ["gone"]);
});

test("one object that's already gone doesn't stop Unbind removing the others", async () => {
  const removed = [];
  const ed = editor({ delete_objects: a => {
    if (a.objectIds.includes("stale")) { if (a.objectIds.length > 1) throw new Error("batch refused"); throw new Error("no such object"); }
    removed.push(...a.objectIds);
    return { deleted: a.objectIds };
  } });
  await ed.store.save("F__num", JSON.stringify({ rig: "num", file: "F", kind: "sliders", vmId: "vm", artboardId: "A", tracks: [],
    converters: ["c1", "stale", "c2"] }));
  const rig = createRig(ed.mcp, () => {}, ed.store);
  const r = await rig.unbind((await rig.manifests())[0]);
  assert.ok(removed.includes("c1") && removed.includes("c2"));
  assert.equal(r.leftovers, 1);
});

// an editor where the timeline Connect made has keys on it, or where the key check itself fails
function keyedEditor(connectionKeys) {
  const ed = editor({ animation_editor: a => {
    if (a.command !== "queryKeyFrames") return undefined;
    if (!a.data.queryKeyFrames.animationIds.includes("tl num s1")) return undefined;
    if (connectionKeys === "fail") throw new Error("no answer");
    return { keyframes: { "tl num s1": Array.from({ length: connectionKeys }, (_, i) => ({ keyframeId: `u${i}` })) } };
  } });
  return { ...ed, rig: createRig(ed.mcp, () => {}, ed.store) };
}
const connected = async t => {
  await bindNumInput(t.rig);
  await t.rig.bindJoystickToSlider({ sliderRig: "num", slider: "num_s1", joystickId: "J", axis: "x" });
  t.calls.length = 0;
  return (await t.rig.manifests())[0];
};
const deletedIds = calls => made(calls, "delete_objects").flatMap(c => c.args.objectIds);
const handleSet = calls => made(calls, "set_property_values").some(c => c.args.propertyValues.J);

test("Unbind keeps a joystick timeline that has keys, and leaves its handle alone", async () => {
  const t = keyedEditor(6);
  const r = await t.rig.unbind(await connected(t));
  assert.ok(!deletedIds(t.calls).includes("tl num s1"));
  assert.deepEqual(r.keptTimelines, ["num s1"]);
  assert.equal(handleSet(t.calls), false);
});

test("Unbind still removes a joystick timeline that's empty", async () => {
  const t = keyedEditor(0);
  const r = await t.rig.unbind(await connected(t));
  assert.ok(deletedIds(t.calls).includes("tl num s1"));
  assert.deepEqual(r.keptTimelines, []);
  assert.equal(handleSet(t.calls), true);
});

test("Disconnect keeps a keyed timeline too, and removes the connection", async () => {
  const t = keyedEditor(2);
  const r = await t.rig.disconnectSlider(await connected(t), "num_s1");
  assert.equal(r.kept, "num s1");
  assert.ok(!deletedIds(t.calls).includes("tl num s1"));
  assert.equal(handleSet(t.calls), false);
  assert.deepEqual((await t.rig.manifests())[0].connections, []);
});

test("if the key check fails, the timeline stays", async () => {
  const t = keyedEditor("fail");
  const r = await t.rig.unbind(await connected(t));
  assert.ok(!deletedIds(t.calls).includes("tl num s1"));
  assert.deepEqual(r.keptTimelines, ["num s1"]);
});

test("a toggler's keyed axis timeline stays while the empty one goes", async () => {
  const ed = editor({ animation_editor: a => (a.command === "queryKeyFrames" && a.data.queryKeyFrames.animationIds.includes("tl t X")
    ? { keyframes: { "tl t X": [{ keyframeId: "u" }], "tl t Y": [] } } : undefined) });
  const rig = createRig(ed.mcp, () => {}, ed.store);
  await rig.bindToggler({ artboardId: "A", artboardName: "Board", rig: "t", joystickId: "J", axes: "xy", items });
  ed.calls.length = 0;
  const r = await rig.unbind((await rig.manifests())[0]);
  assert.deepEqual(r.keptTimelines, ["t X"]);
  assert.ok(deletedIds(ed.calls).includes("tl t Y") && !deletedIds(ed.calls).includes("tl t X"));
  assert.deepEqual(made(ed.calls, "set_property_values").at(-1).args.propertyValues.J, { 300: 0 });
});

// an editor where making a script opens it and moves the selection off the keys
function scriptEditor(selected) {
  const assets = [], texts = {}, created = [];
  let ed;
  ed = editor({
    get_selection: () => ({ selection: selected }),
    manage_scripts: a => {
      for (const c of a.data.create) {
        assets.push({ id: `s${assets.length}`, name: c.name, moduleName: c.name, type: "script", scriptProtocol: /dataBkp/.test(c.name) ? "utility" : "node" });
        texts[c.name] = c.content;
      }
      selected = [{ id: "the new script" }];
      return {};
    },
    assets_tool: () => ({ assets }),
    text_editor: a => {
      if (a.command === "view") return { content: texts[a.path] ?? "" };
      texts[a.path] = a.new_string ?? a.text;
      return {};
    },
    find_objects: a => ({ objects: a.type === "ScriptedDrawable" ? [{ id: "pl", type: "ScriptedDrawable" }] : [] }),
    query_property_values: a => {
      const [id, keys] = Object.entries(a.propertyKeys)[0];
      if (keys.includes(848)) return { values: { pl: { 848: "s0" } } };
      if (keys.includes(901)) return { values: { [id]: { 901: `cf ${id}` } } };
      if (keys.includes(959)) return { values: { [id]: { 959: 0 } } };
      return undefined;
    },
    script_diagnostics: () => [],
    viewmodel_editor: a => {
      if (a.command === "createViewModels") {
        for (const v of a.data.createViewModels.viewModels) created.push({ id: `v ${v.name}`, name: v.name, viewModelProperties: v.viewModelProperties.map(p => ({ ...p, id: `${v.name} ${p.name}` })) });
        return {};
      }
      if (a.command === "listViewModels") return { viewModels: [ed.vm, ...created] };
      if (a.command === "listViewModelInstances") return { instances: [{ id: "inst", name: "Default", viewModelProperties: [] }] };
      return undefined;
    },
  });
  return { ...ed, rig: createRig(ed.mcp, () => {}, ed.store) };
}
const scriptNumInput = rig => rig.bindSliders({ artboardId: "A", artboardName: "Board", timelineId: "T1", rig: "num", poses: 2, inputs: [""], drive: "script", allowNegative: false, removeKeys: false, selectedOnly: true });

test("the script drive binds the selection on the first click, though making the script drops it", async () => {
  const t = scriptEditor([{ id: "o" }]);
  const m = await scriptNumInput(t.rig);
  assert.equal(m.tracks.length, 1);
  assert.equal(m.drive, "script");
  const order = t.calls.map(c => c.tool);
  assert.ok(order.indexOf("get_selection") < order.indexOf("manage_scripts"));
});

test("a joystick script rig binds the selection on the first click too", async () => {
  const t = scriptEditor([{ id: "o" }]);
  const m = await t.rig.bindJoystickScript({ artboardId: "A", artboardName: "Board", timelineId: "T1", order: { L: 1, R: 2, U: 3, D: 4 }, rig: "look", joystickId: "J", removeKeys: false, bias: {}, selectedOnly: true });
  assert.equal(m.tracks.length, 1);
});

test("a selection with no keys is refused before any script is made", async () => {
  const t = scriptEditor([{ id: "elsewhere" }]);
  await assert.rejects(scriptNumInput(t.rig), /no number keys for the selection/);
  assert.equal(made(t.calls, "manage_scripts").length, 0);
});
