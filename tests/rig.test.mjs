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
