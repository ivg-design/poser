// Poser rig operations — every step is a Rive MCP tools/call. Each bind
// records what it created in a manifest (one JSON file per file and rig, in
// the app's data folder; the CLI shares it) so Unbind can restore the pose keys
// and remove exactly those objects. `store` is { list(), save(name, json), remove(name) }.
import * as E from "./engine.js";

const CHUNK = 120;
const chunks = (a, n = CHUNK) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function createRig(mcp, log = () => {}, store) {
  // ------------------------------------------------------------ context

  async function fileKey() {
    const s = await mcp("session_info", {});
    const f = (s.openTabs || []).find(t => t.isActive) || {};
    return String(s.activeFileId ?? f.fileId ?? "file");
  }

  async function artboards() {
    const r = await mcp("list_artboards", {});
    return { list: r.artboards || [], active: r.selectionArtboardId || (r.artboards || []).find(a => a.isActive)?.id };
  }

  async function timelines() {
    const r = await mcp("animation_editor", { command: "listLinearAnimations" });
    return r.linearAnimations || [];
  }

  async function joysticks(artboardId) {
    const r = await mcp("find_objects", { artboardId, type: "joystick" });
    return r.objects || [];
  }

  async function selection() {
    const r = await mcp("get_selection", {});
    return r.selection || [];
  }

  // selected objects and everything under them (a selected mesh image takes its vertices)
  async function selectedScope() {
    const sel = await selection();
    if (!sel.length) return null;
    const r = await mcp("query_objects", { objectIds: sel.map(o => o.id), depth: 12 });
    const scope = new Set();
    const visit = o => { scope.add(o.id); for (const c of o.children || []) typeof c === "string" ? scope.add(c) : visit(c); };
    for (const o of r.objects || []) visit(o);
    for (const o of sel) scope.add(o.id);
    return scope;
  }

  async function poseTracks(timelineId, scope) {
    const r = await mcp("animation_editor", { command: "queryKeyFrames", data: { queryKeyFrames: { animationIds: [timelineId] } } });
    const tracks = E.tracksFrom(r.keyframes?.[timelineId] || []);
    if (scope) for (const k of [...tracks.keys()]) if (!scope.has(tracks.get(k).objectId)) tracks.delete(k);
    return tracks;
  }

  // ------------------------------------------------------------ view model

  async function artboardViewModel(artboardId, artboardName) {
    const q = await mcp("query_property_values", { propertyKeys: { [artboardId]: [583] } });
    let vmId = q.values?.[artboardId]?.["583"];
    const vms = (await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || [];
    let vm = vms.find(v => v.id === vmId);
    if (!vm) {
      const name = `${artboardName || "Artboard"} Poser`;
      await mcp("viewmodel_editor", { command: "createViewModels", data: { createViewModels: { viewModels: [{ name, viewModelProperties: [] }] } } });
      vm = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.name === name);
      await mcp("viewmodel_editor", { command: "bindViewModelToArtboard", data: { bindViewModelToArtboard: { artboardId, viewModelId: vm.id } } });
      log(`Created view model "${name}" for the artboard.`);
    }
    return vm;
  }

  async function ensureNumbers(vm, names) {
    const have = new Set((vm.viewModelProperties || []).map(p => p.name));
    const missing = names.filter(n => !have.has(n));
    if (missing.length) {
      await mcp("viewmodel_editor", { command: "addProperties", data: { addProperties: { viewModels: [
        { viewModelId: vm.id, viewModelProperties: missing.map(name => ({ name, propertyType: "number" })) }] } } });
    }
    const fresh = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === vm.id);
    const byName = Object.fromEntries((fresh.viewModelProperties || []).map(p => [p.name, p.id]));
    for (const n of names) if (!byName[n]) throw new Error(`View model property ${n} was not created.`);
    return { vm: fresh, ids: byName, added: missing };
  }

  // formula converters, created in chunks and found again by their unique names
  async function makeConverters(entries) {
    const ids = [];
    for (const part of chunks(entries)) {
      const r = await mcp("viewmodel_editor", { command: "createConverters", data: { createConverters: {
        converters: part.map(e => ({ converterType: "formula", name: e.name, formula: e.formula })) } } });
      const made = r.converters || [];
      if (made.length !== part.length) throw new Error(`Created ${made.length} of ${part.length} converters.`);
      ids.push(...made.map(c => c.id));
    }
    return ids;
  }

  // The editor does not report bind ids, but new objects get consecutive ids. A marker group made
  // right before each batch fixes the starting point; the batch's binds are the DataBindContext
  // objects that follow it, in order. Unbind deletes exactly those.
  const idNum = id => +String(id).split("-")[1];
  const idAt = (id, n) => `${String(id).split("-")[0]}-${n}`;
  async function bind(vmId, bindings, artboardId) {
    const ids = [];
    for (const part of chunks(bindings)) {
      const marker = (await mcp("group_editor", { name: "poser marker", parentId: artboardId })).group.id;
      await mcp("viewmodel_editor", { command: "databind", data: { databind: { viewModelId: vmId, bindings: part } } });
      const found = [];
      for (let start = idNum(marker) + 1; found.length < part.length && start < idNum(marker) + 20 * part.length + 200; start += 200) {
        const probe = Array.from({ length: 200 }, (_, i) => idAt(marker, start + i));
        const r = await mcp("query_objects", { objectIds: probe, depth: 0 });
        for (const o of (r.objects || []).sort((a, b) => idNum(a.id) - idNum(b.id))) {
          if ((o.types || []).includes("DataBindContext") && found.length < part.length) found.push(o.id);
        }
      }
      await mcp("delete_objects", { objectIds: [marker] });
      if (found.length !== part.length) throw new Error(`Bound ${part.length} properties but found ${found.length} bind objects.`);
      ids.push(...found);
    }
    return ids;
  }

  async function toSource(pairs) {          // [{objectId, propertyKey}] → bind direction object → view model
    for (const p of pairs) {
      await mcp("viewmodel_editor", { command: "modifyDataBind", data: { modifyDataBind: { ...p, direction: "toSource" } } });
    }
  }


  // ------------------------------------------------------------ manifests

  const manifestName = m => `${m.file}__${m.rig}`;
  async function saveManifest(m) { await store.save(manifestName(m), JSON.stringify(m)); }
  async function manifests() {
    const file = await fileKey();
    return (await store.list()).map(j => JSON.parse(j)).filter(m => m.file === file);
  }
  async function dropManifest(m) { await store.remove(manifestName(m)); }

  // ------------------------------------------------------------ joystick

  async function bindJoystick({ artboardId, artboardName, timelineId, order, rig, joystickId, removeKeys, bias, selectedOnly }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    const scope = selectedOnly ? await selectedScope() : null;
    const tracks = await poseTracks(timelineId, scope);
    const frames = [0, 1, 2, 3, 4];
    const rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, frames);
      const formula = E.joystickFormula("__VM__", rig, values, order);
      if (formula) rows.push({ t, values, formula });
    }
    if (!rows.length) throw new Error("No keyed property changes across frames 0–4 in that timeline" + (scope ? " for the selection." : "."));
    log(`${rows.length} properties to bind.`);

    let vm = await artboardViewModel(artboardId, artboardName);
    const names = ["fL", "fR", "fU", "fD", "x", "y"].map(n => `${rig}_${n}`);
    const { vm: vm2, ids, added } = await ensureNumbers(vm, names);
    vm = vm2;

    // factor nodes under one group, keyed by two timelines the joystick scrubs
    const group = (await mcp("group_editor", { name: `poser ${rig}`, parentId: artboardId })).group;
    const nodes = {};
    for (const d of E.DIRECTIONS) {
      nodes[d] = (await mcp("group_editor", { name: `${rig} f${d}`, parentId: group.id })).group?.id;
      if (!nodes[d]) throw new Error(`Factor node f${d} was not created.`);
    }
    const tlNames = { X: `poser ${rig} X`, Y: `poser ${rig} Y` };
    const made = (await mcp("animation_editor", { command: "createLinearAnimations", data: { createLinearAnimations: {
      linearAnimations: Object.values(tlNames).map(name => ({ name, duration: E.FACTOR_FRAMES / 60 })) } } })).animations || [];
    const tl = { X: made.find(a => a.name === tlNames.X)?.id, Y: made.find(a => a.name === tlNames.Y)?.id };
    if (!tl.X || !tl.Y) throw new Error("Factor timelines were not created.");
    for (const axis of ["X", "Y"]) {
      await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: tl[axis], add: E.factorKeys(nodes, axis, bias) } } });
    }
    await mcp("set_property_values", { propertyValues: { [joystickId]: { 301: tl.X, 302: tl.Y } } });

    // factors and the raw joystick position flow into the view model
    const factorBinds = E.DIRECTIONS.map(d => ({ objectId: nodes[d], propertyKey: 13, viewModelPropertyId: ids[`${rig}_f${d}`] }));
    const joyBinds = [{ objectId: joystickId, propertyKey: 299, viewModelPropertyId: ids[`${rig}_x`] },
                      { objectId: joystickId, propertyKey: 300, viewModelPropertyId: ids[`${rig}_y`] }];
    const controlBinds = await bind(vm.id, [...factorBinds, ...joyBinds], artboardId);
    await toSource([...factorBinds, ...joyBinds].map(({ objectId, propertyKey }) => ({ objectId, propertyKey })));

    // one formula converter per posed property
    const conv = rows.map(r => ({ name: E.converterName(rig, r.t.objectId, r.t.propertyName), formula: r.formula.replaceAll("__VM__", vm.name) }));
    log(`Creating ${conv.length} converters…`);
    const convIds = await makeConverters(conv);
    log("Binding properties…");
    const propBinds = await bind(vm.id, rows.map((r, i) => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, viewModelPropertyId: ids[`${rig}_fR`], converterId: convIds[i] })), artboardId);

    const manifest = {
      kind: "joystick", version: 1, file, rig, artboardId, timelineId, order, joystickId, vmId: vm.id, addedProps: added,
      groupId: group.id, nodes, timelines: tl, converters: convIds, bias, binds: [...controlBinds, ...propBinds],
      tracks: rows.map(r => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, propertyName: r.t.propertyName,
        keys: r.t.keys.map(k => ({ frame: k.frame, value: k.value, interpolationType: k.interpolationType })) })),
    };
    if (removeKeys) {
      const ids = rows.flatMap(r => r.t.keys.map(k => k.keyframeId));
      for (const part of chunks(ids, 400)) {
        await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timelineId, delete: part } } });
      }
      manifest.keysRemoved = true;
    }
    await saveManifest(manifest);
    return manifest;
  }

  async function setEaseBias(m, bias) {
    const r = await mcp("animation_editor", { command: "queryKeyFrames", data: { queryKeyFrames: { animationIds: [m.timelines.X, m.timelines.Y] } } });
    for (const axis of ["X", "Y"]) {
      const rows = r.keyframes?.[m.timelines[axis]] || [];
      const want = E.factorKeys(m.nodes, axis, bias);
      const change = [];
      for (const w of want) {
        const row = rows.find(k => k.objectId === w.objectId && k.frame === w.frame);
        if (row) change.push({ keyframeId: row.keyframeId, interpolationType: w.interpolationType, ...(w.cubicParams ? { cubicParams: w.cubicParams } : {}) });
      }
      await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: m.timelines[axis], change } } });
    }
    m.bias = bias;
    await saveManifest(m);
  }

  // ------------------------------------------------------------ sliders

  async function bindSliders({ artboardId, artboardName, timelineId, rig, poses, allowNegative, removeKeys, selectedOnly }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    const scope = selectedOnly ? await selectedScope() : null;
    const tracks = await poseTracks(timelineId, scope);
    const frames = Array.from({ length: poses + 1 }, (_, i) => i);
    const rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, frames);
      const formula = E.sliderFormula("__VM__", rig, values, allowNegative);
      if (formula) rows.push({ t, formula });
    }
    if (!rows.length) throw new Error(`No keyed property changes across frames 0–${poses}.`);
    let vm = await artboardViewModel(artboardId, artboardName);
    const names = frames.slice(1).map(i => `${rig}_s${i}`);
    const { vm: vm2, ids, added } = await ensureNumbers(vm, names);
    vm = vm2;
    const convIds = await makeConverters(rows.map(r => ({ name: E.converterName(rig, r.t.objectId, r.t.propertyName), formula: r.formula.replaceAll("__VM__", vm.name) })));
    const binds = await bind(vm.id, rows.map((r, i) => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, viewModelPropertyId: ids[names[0]], converterId: convIds[i] })), artboardId);
    const manifest = {
      kind: "sliders", version: 1, file, rig, artboardId, timelineId, vmId: vm.id, addedProps: added, sliders: names, converters: convIds, binds,
      tracks: rows.map(r => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, propertyName: r.t.propertyName,
        keys: r.t.keys.map(k => ({ frame: k.frame, value: k.value, interpolationType: k.interpolationType })) })),
    };
    if (removeKeys) {
      for (const part of chunks(rows.flatMap(r => r.t.keys.map(k => k.keyframeId)), 400)) {
        await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timelineId, delete: part } } });
      }
      manifest.keysRemoved = true;
    }
    await saveManifest(manifest);
    return manifest;
  }

  // a joystick (one axis or both) can drive a slider: x (or y) −1..1 → 0..100, or −100..100 with negatives
  async function bindJoystickToSlider({ sliderRig, slider, joystickId, axis, allowNegative }) {
    const m = (await manifests()).find(x => x.kind === "sliders" && x.rig === sliderRig);
    if (!m) throw new Error("Bind the sliders first.");
    const vm = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === m.vmId);
    const sliderPropId = vm.viewModelProperties.find(p => p.name === slider)?.id;
    const formula = allowNegative ? "{Input} * 100" : "max(0, {Input}) * 100";
    const [cid] = await makeConverters([{ name: `poser ${sliderRig} ${slider} from ${joystickId} ${axis}`, formula }]);
    const propertyKey = axis === "y" ? 300 : 299;
    const ids = await bind(m.vmId, [{ objectId: joystickId, propertyKey, viewModelPropertyId: sliderPropId, converterId: cid }], m.artboardId);
    await toSource([{ objectId: joystickId, propertyKey }]);
    m.binds = [...(m.binds || []), ...ids];
    m.converters = [...(m.converters || []), cid];
    await saveManifest(m);
  }

  // ------------------------------------------------------------ switch

  async function bindSwitch({ joystickRig, items }) {
    const m = (await manifests()).find(x => x.kind === "joystick" && x.rig === joystickRig);
    if (!m) throw new Error("Bind a joystick first; the switch reads its position.");
    const vm = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === m.vmId);
    const xId = vm.viewModelProperties.find(p => p.name === `${m.rig}_x`)?.id;
    const conv = items.map((it, i) => ({ name: `poser ${m.rig} switch ${it.id}`, formula: E.switchFormula(vm.name, m.rig, items, i) }));
    const convIds = await makeConverters(conv);
    const ids = await bind(vm.id, items.map((it, i) => ({ objectId: it.id, propertyKey: 18, viewModelPropertyId: xId, converterId: convIds[i] })), m.artboardId);
    m.binds = [...(m.binds || []), ...ids];
    m.switches = [...(m.switches || []), ...items.map((it, i) => ({ objectId: it.id, converter: convIds[i], x: it.x, y: it.y }))];
    await saveManifest(m);
  }

  // ------------------------------------------------------------ unbind

  async function unbind(m) {
    const binds = m.binds || [];
    for (const part of chunks(binds, 400)) await mcp("delete_objects", { objectIds: part });
    if (m.keysRemoved) {
      const add = m.tracks.flatMap(t => t.keys.map(k => ({ objectId: t.objectId, propertyKey: t.propertyKey, frame: k.frame, value: k.value, interpolationType: k.interpolationType || "linear" })));
      for (const part of chunks(add, 400)) {
        await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: m.timelineId, add: part } } });
      }
    }
    // converters go too; the editor's converter list can keep a stale entry until reload
    const extra = [...(m.converters || []), ...(m.switches || []).map(s => s.converter)];
    if (m.kind === "joystick") extra.push(...Object.values(m.nodes), m.groupId, m.timelines.X, m.timelines.Y);
    let leftovers = 0;
    for (const part of chunks(extra, 400)) {
      try { await mcp("delete_objects", { objectIds: part }); } catch { leftovers += part.length; }
    }
    // the view model numbers this rig added (deleting a property removes its instance values)
    const vm = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === m.vmId);
    const propIds = (vm?.viewModelProperties || []).filter(p => (m.addedProps || []).includes(p.name)).map(p => p.id);
    if (propIds.length) await mcp("delete_objects", { objectIds: propIds });
    await dropManifest(m);
    return { binds: binds.length, restored: m.keysRemoved ? m.tracks.length : 0, leftovers };
  }

  // ------------------------------------------------------------ tools

  async function keyAll({ timelineId, frame }) {
    const sel = await selection();
    if (!sel.length) throw new Error("Select the objects to key.");
    const keys = await mcp("query_property_keys", { objectIds: sel.map(o => o.id), animates: true });
    const propKeys = {};
    for (const o of sel) {
      const entry = keys.properties?.[o.id] || keys[o.id] || {};
      propKeys[o.id] = Object.values(entry).filter(v => typeof v === "number");
    }
    const vals = await mcp("query_property_values", { propertyKeys: propKeys });
    const add = [];
    for (const [id, props] of Object.entries(vals.values || {})) {
      for (const [k, v] of Object.entries(props)) if (typeof v === "number") add.push({ objectId: id, propertyKey: +k, frame, value: v, interpolationType: "linear" });
    }
    for (const part of chunks(add, 400)) {
      await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timelineId, add: part } } });
    }
    return add.length;
  }

  async function unkeyFlat({ timelineId, poses }) {
    const tracks = await poseTracks(timelineId, null);
    const flat = E.flatTracks(tracks, Array.from({ length: poses + 1 }, (_, i) => i));
    const ids = flat.flatMap(t => t.keys.map(k => k.keyframeId));
    for (const part of chunks(ids, 400)) {
      await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timelineId, delete: part } } });
    }
    return flat.length;
  }

  async function pasteOrigin({ timelineId, frame, overwrite }) {
    const scope = await selectedScope();
    if (!scope) throw new Error("Select the objects to paste the origin pose onto.");
    const tracks = await poseTracks(timelineId, scope);
    const add = [], change = [];
    for (const t of tracks.values()) {
      const origin = E.sample(t.keys, 0);
      const existing = t.keys.find(k => k.frame === frame);
      if (existing) { if (overwrite) change.push({ keyframeId: existing.keyframeId, value: origin }); }
      else add.push({ objectId: t.objectId, propertyKey: t.propertyKey, frame, value: origin, interpolationType: "linear" });
    }
    await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timelineId, add, change } } });
    return add.length + change.length;
  }

  // PathFlipper: mirror the selected path's vertices around its first vertex
  async function pathFlip({ vertical }) {
    const sel = await selection();
    if (sel.length !== 1) throw new Error("Select one path.");
    const r = await mcp("query_objects", { objectIds: [sel[0].id], depth: 1 });
    const kids = (r.objects?.[0]?.children || []).map(c => (typeof c === "string" ? c : c.id));
    const vk = { x: 24, y: 25, rotation: 84, inRotation: 79, outRotation: 81 };
    const q = await mcp("query_property_values", { propertyKeys: Object.fromEntries(kids.map(id => [id, Object.values(vk)])) });
    const verts = kids.map(id => {
      const v = q.values?.[id] || {};
      return { id, x: v[24], y: v[25], rotation: v[84], inRotation: v[79], outRotation: v[81] };
    }).filter(v => typeof v.x === "number");
    const flipped = E.mirrorVertices(verts, vertical);
    const out = {};
    for (const v of flipped) {
      out[v.id] = { 24: v.x, 25: v.y };
      if (v.rotation !== undefined) out[v.id][84] = v.rotation;
      if (v.inRotation !== undefined) out[v.id][79] = v.inRotation;
      if (v.outRotation !== undefined) out[v.id][81] = v.outRotation;
    }
    await mcp("set_property_values", { propertyValues: out });
    return flipped.length;
  }

  return { fileKey, artboards, timelines, joysticks, selection, bindJoystick, setEaseBias, bindSliders,
           bindJoystickToSlider, bindSwitch, unbind, manifests, keyAll, unkeyFlat, pasteOrigin, pathFlip };
}
