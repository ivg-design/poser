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

  // A rig's record (what Poser created, and the pose keys it moved into the rig) is kept in two
  // places: the app data folder, and a script in the Rive file named "poser <rig> dataBkp", so it
  // travels with the file. The record is one long comment, in the file's script language (an
  // editor running AnimaScript does not load a new Luau script, and the other way round), so the
  // script compiles clean and runs no code. Poser reads and writes the script's code file
  // directly (key 909), which works even before the editor has loaded a new script.
  const manifestName = m => `${m.file}__${m.rig}`;
  const recordName = rig => `poser ${rig} dataBkp`;
  const RECORD = /^poser (.+) dataBkp$/;
  const MARK = "POSER-RECORD";

  const scriptAssets = async () =>
    (await mcp("assets_tool", { command: "listAssets", data: { listAssets: { typeFilter: "script" } } })).assets || [];
  const recordAssets = async () => (await scriptAssets()).filter(a => RECORD.test(a.name));
  const codeFileOf = async assetId =>
    (await mcp("query_property_values", { propertyKeys: { [assetId]: [901] } })).values?.[assetId]?.["901"];
  const readSource = async codeFile =>
    (await mcp("query_property_values", { propertyKeys: { [codeFile]: [909] } })).values?.[codeFile]?.["909"] || "";
  const writeSource = (codeFile, text) => mcp("set_property_values", { propertyValues: { [codeFile]: { 909: text } } });
  // The file's script engine decides the language: the backboard's scriptingVm (key 472: 0 luau,
  // 1 wasm). A Luau file can't run AnimaScript and a wasm file can't compile Luau, so a script in
  // the other language is never a Node. The editor won't switch the engine; a CLI push sets it.
  // The backboard is the first object of the client that made the file's first artboard.
  async function fileLanguage() {
    const prefixes = [...new Set((await artboards()).list.map(a => a.id.split("-")[0]))];
    for (const p of [...prefixes, "0"]) {
      const id = `${p}-1`;
      try {
        const v = (await mcp("query_property_values", { propertyKeys: { [id]: [472] } })).values?.[id]?.["472"];
        if (v !== undefined) return v === 1 ? "animascript" : "luau";
      } catch {}
    }
    return "luau";
  }

  async function readText(path) {
    const v = await mcp("text_editor", { command: "view", path });
    return typeof v === "string" ? v : v?.content ?? v?.text ?? "";
  }

  // the editor's view ends with a newline the stored text does not have
  async function writeText(path, text) {
    const old = (await readText(path)).replace(/\n$/, "");
    if (old.trim()) await mcp("text_editor", { command: "str_replace", path, old_string: old, new_string: text });
    else await mcp("text_editor", { command: "insert", path, text });
  }

  // Through the editor when it has the script loaded (its buffer wins over the code file), else
  // straight into the code file; read back so a write that didn't land is an error, not a surprise.
  async function readScript(name) {
    try { const text = await readText(name); if (text.trim()) return text; } catch {}
    return readSource(await codeFileOf((await scriptAsset(name)).id));
  }
  async function writeScript(name, text) {
    try { await writeText(name, text); }
    catch { await writeSource(await codeFileOf((await scriptAsset(name)).id), text); }
    if ((await readScript(name)).trim() !== text.trim()) throw new Error(`Could not write the script "${name}".`);
  }

  // one key per line and one entry per line in each list, so the editor never gets one huge line;
  // a comment closer can only occur inside a JSON string, where an escape keeps it inert
  const recordJson = (m, language) => {
    const json = "{\n" + Object.entries(m).map(([k, v]) => `  ${JSON.stringify(k)}: ` + (Array.isArray(v) && v.length
      ? "[\n" + v.map(x => "    " + JSON.stringify(x)).join(",\n") + "\n  ]" : JSON.stringify(v))).join(",\n") + "\n}";
    return language === "luau" ? json.replaceAll("]==]", "]\\u003d=]") : json.replaceAll("*/", "*\\/");
  };
  const recordText = (m, language) => {
    const about = [`Poser dataBkp for the rig "${m.rig}". Generated by Poser 3: don't edit or rename it.`,
      "It holds the rig's record: what Poser created in this file, and the pose keys it moved into the",
      "rig. Unbind in Poser reads it to remove the rig and put the keys back. The script runs no code."];
    return language === "luau"
      ? `${about.map(l => "-- " + l).join("\n")}\n--[==[${MARK}\n${recordJson(m, language)}\n${MARK}]==]\nreturn {}\n`
      : `${about.map(l => "// " + l).join("\n")}\n/* ${MARK}\n${recordJson(m, language)}\n${MARK} */\n`;
  };
  const parseRecord = text => {
    const i = text.indexOf(MARK), j = text.lastIndexOf(MARK);
    try { return i >= 0 && j > i ? JSON.parse(text.slice(i + MARK.length, j)) : null; } catch { return null; }
  };

  // the app's copy always lands; trouble with the in-file copy is a warning, not a failed bind
  let warning = "";
  const takeWarning = () => { const w = warning; warning = ""; return w; };
  async function saveManifest(m) {
    await store.save(manifestName(m), JSON.stringify(m));
    try { await saveRecordScript(m); } catch (e) { warning = String(e.message || e); }
  }
  async function saveRecordScript(m) {
    const name = recordName(m.rig);
    const language = await fileLanguage();
    let asset = (await recordAssets()).find(a => a.name === name);
    if (!asset) {
      await mcp("manage_scripts", { command: "create", data: { create: [{ name, code_file_type: "luau", content: "return {}\n" }] } });
      asset = (await recordAssets()).find(a => a.name === name);
      if (!asset) throw new Error(`Could not create the script "${name}"; the record is kept in Poser.`);
    }
    const codeFile = await codeFileOf(asset.id);
    if (!codeFile) throw new Error(`The script "${name}" has no code file; the record is kept in Poser.`);
    await mcp("set_property_values", { propertyValues: { [codeFile]: { 959: CODE_FILE_TYPE[language] } } });
    await writeScript(name, recordText(m, language));
  }

  // the records in the open file win over the app's copies
  async function manifests() {
    const file = await fileKey();
    const byRig = new Map((await store.list()).map(j => JSON.parse(j)).filter(m => m.file === file).map(m => [m.rig, m]));
    for (const a of await recordAssets()) {
      let m = null;
      try { m = parseRecord(await readScript(a.name)); } catch {}
      if (m?.rig) byRig.set(m.rig, { ...m, file });
    }
    return [...byRig.values()];
  }

  async function dropManifest(m) {
    await store.remove(manifestName(m));
    const asset = (await recordAssets()).find(a => a.name === recordName(m.rig));
    if (asset) await mcp("delete_objects", { objectIds: [asset.id] });
  }

  // a rigged timeline's pose keys live in its manifest, so binding it again finds nothing:
  // the same rig name rebinds (unbind restores the keys first), another rig name is refused
  async function claim(file, timelineId, rig) {
    const ms = (await store.list()).map(j => JSON.parse(j)).filter(m => m.file === file);
    const other = ms.find(m => m.rig !== rig && m.timelineId === timelineId);
    if (other) throw new Error(`That timeline is already rigged as "${other.rig}". Use rig name "${other.rig}" to rebind it, or unbind it in Tools.`);
    const same = ms.find(m => m.rig === rig);
    if (same) { log(`Rig "${rig}" exists: unbinding it first.`); await unbind(same); }
  }

  function noChanges(tracks, scope) {
    const where = scope ? " for the selection" : "";
    return new Error(tracks.size
      ? `None of the ${tracks.size} keyed properties in that timeline change across the pose frames${where}.`
      : `That timeline has no number keys${where}.`);
  }

  // ------------------------------------------------------------ joystick

  async function bindJoystick({ artboardId, artboardName, timelineId, order, rig, joystickId, removeKeys, bias, selectedOnly }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    await claim(file, timelineId, rig);
    const scope = selectedOnly ? await selectedScope() : null;
    const tracks = await poseTracks(timelineId, scope);
    const frames = [0, 1, 2, 3, 4];
    const rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, frames);
      const formula = E.joystickFormula("__VM__", rig, values, order);
      if (formula) rows.push({ t, values, formula });
    }
    if (!rows.length) throw noChanges(tracks, scope);
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

  // ------------------------------------------------------------ joystick, AnimaScript drive

  // One AnimaScript computes every posed value and writes it into a nested view model; each
  // property is bound to its number with no converter. The MCP can create only Luau scripts and
  // cannot place a script on an artboard, so the user adds the empty AnimaScript; Poser writes it.
  // The editor's Node template is Luau. A script's language is its code file's type (key 959:
  // 0 luau, 1 wgsl, 2 document, 3 animaScript), not its text, so Poser sets it before writing.
  // Placing a script is a step the MCP has no tool for: Poser copies a placement (ScriptedDrawable)
  // that already exists in the file and points it at the script; a file with none needs the script
  // dropped on the artboard once.
  const CODE_FILE_TYPE = { luau: 0, animascript: 3 };
  // The rig script has to be a Node, and the editor makes a script a Node when it compiles it in
  // the file's own engine. In a Luau file Poser creates it as a Luau Node. A file that runs
  // AnimaScript (wasm) compiles no Luau and the MCP can't create AnimaScript, so nothing made there
  // is a Node (only a CLI push makes one). The open editor compiles a switched script in its new
  // language only after the file is reopened.
  async function ensureScript(rig, artboardId) {
    const name = E.scriptName(rig);
    const language = await fileLanguage();
    const find = async () => (await scriptAssets()).find(a => a.moduleName === name || a.name === name);
    let asset = await find();
    // a placed script was a Node when it was dropped, even if a language switch since left it uncompiled
    const placed = asset ? await placedOn(artboardId, asset.id) : false;
    if (asset && !placed && asset.scriptProtocol !== "node") {
      const text = await readScript(name).catch(() => "");
      if (text.trim() && !text.includes("Poser")) throw new Error(`"${name}" is a plain script, not a Node, so it can't be placed. Rename or delete it, then bind again.`);
      await mcp("delete_objects", { objectIds: [asset.id] });   // empty or Poser's own: make it again
      asset = null;
    }
    const made = {};
    if (!asset) {
      if (language !== "luau") throw new Error("This file runs AnimaScript scripts, and the Rive editor can't make an AnimaScript Node script, so the script drive can't run here. Use the formula drive.");
      await mcp("manage_scripts", { command: "create", data: { create: [{ name, code_file_type: "luau",
        content: E.placeholderScript(rig, "luau") }] } });
      for (let i = 0; i < 20; i++) {   // the protocol is set when the editor compiles it
        asset = await find();
        if (asset?.scriptProtocol === "node") break;
        await new Promise(r => setTimeout(r, 250));
      }
      if (asset?.scriptProtocol !== "node") throw new Error(`The editor didn't make "${name}" a Node script.`);
      made.script = true;
      log(`Created the Node script "${name}".`);
    }
    try { made.placement = placed ? null : await placeScript(name, artboardId); }
    catch (e) { throw made.script ? new Error(`Poser created the Node script "${name}". ${e.message}`) : e; }
    return { name, language, made };
  }

  const placedOn = async (artboardId, assetId) => {
    const here = await placements(artboardId);
    if (!here.length) return false;
    const v = (await mcp("query_property_values", { propertyKeys: Object.fromEntries(here.map(o => [o.id, [848]])) })).values || {};
    return here.some(o => v[o.id]?.["848"] === assetId);
  };

  async function scriptAsset(name) {
    const assets = (await mcp("assets_tool", { command: "listAssets", data: { listAssets: { typeFilter: "script" } } })).assets || [];
    const asset = assets.find(a => a.moduleName === name || a.name === name);
    if (!asset) throw new Error(`Script "${name}" was not found among the file's assets.`);
    return asset;
  }

  const placements = async artboardId => ((await mcp("find_objects", { artboardId, type: "ScriptedDrawable" })).objects || [])
    .filter(o => o.type === "ScriptedDrawable");

  // returns the id of a placement Poser made, or null when the script was already placed
  async function placeScript(name, artboardId) {
    const assetId = (await scriptAsset(name)).id;
    if (await placedOn(artboardId, assetId)) return null;
    const here = await placements(artboardId);
    let source = here[0], from = artboardId;
    if (!source) {
      for (const ab of (await artboards()).list) {
        const found = await placements(ab.id);
        if (found.length) { source = found[0]; from = ab.id; break; }
      }
    }
    if (!source) throw new Error(`Drag "${name}" from the Assets panel onto the artboard, then bind again. Poser can't place a script itself (it copies one already placed when the file has one).`);
    const before = new Set((await placements(from)).map(o => o.id));
    await mcp("duplicate_objects", { objectIds: [source.id] });
    const copy = (await placements(from)).find(o => !before.has(o.id));
    if (!copy) throw new Error(`Could not place "${name}" on the artboard.`);
    if (from !== artboardId) await mcp("reparent_objects", { operations: [{ objectId: copy.id, newParentId: artboardId }] });
    // the copy's inputs belong to the other script
    const inputs = ((await mcp("find_objects", { artboardId, type: "ScriptInput" })).objects || []).filter(o => o.parentId === copy.id);
    if (inputs.length) await mcp("delete_objects", { objectIds: inputs.map(o => o.id) });
    await mcp("set_property_values", { propertyValues: { [copy.id]: { 848: assetId } } });
    await mcp("rename_objects", { renames: [{ id: copy.id, name }] });
    log(`Placed "${name}" on the artboard.`);
    return copy.id;
  }

  async function setLanguage(name, language) {
    const codeFile = await codeFileOf((await scriptAsset(name)).id);
    if (!codeFile) throw new Error(`Script "${name}" has no code file.`);
    const type = async () => (await mcp("query_property_values", { propertyKeys: { [codeFile]: [959] } })).values?.[codeFile]?.["959"];
    if (await type() === CODE_FILE_TYPE[language]) return;
    await mcp("set_property_values", { propertyValues: { [codeFile]: { 959: CODE_FILE_TYPE[language] } } });
    if (await type() !== CODE_FILE_TYPE[language]) throw new Error(`Could not switch "${name}" to ${language}.`);
    log(`Switched "${name}" to ${language === "luau" ? "Luau" : "AnimaScript"}.`);
  }

  async function reloadHint(name, language) {
    await new Promise(r => setTimeout(r, 1500));
    const d = ((await mcp("script_diagnostics", {})) || []).find(x => x.script === name);
    const wrong = (d?.diagnostics || []).some(x => x.severity === "error" && x.source === (language === "luau" ? "rasc" : "luau"));
    return wrong ? `Reload the file in the Rive editor (Cmd+R) so it compiles "${name}" as ${language === "luau" ? "Luau" : "AnimaScript"}.` : "";
  }

  const scriptSource = (language, rig, rows, order, bias) =>
    (language === "luau" ? E.poseScriptLuau : E.poseScript)(rig, rows, order, bias);

  const listVMs = async () => (await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || [];
  const listInstances = async viewModelId => (await mcp("viewmodel_editor", { command: "listViewModelInstances",
    data: { listViewModelInstances: { viewModelId } } })).instances || [];

  // `poser <rig>` view model (x, y, p0…pN) with a Default instance, nested in the artboard's view
  // model as `<rig>`, and every instance of the artboard's view model pointed at it
  async function poseViewModel(vm, rig, origins) {
    const name = E.scriptVmName(rig);
    // a failed bind can leave these behind; a bound rig was already removed by claim()
    const stale = (await listVMs()).filter(v => v.name === name).map(v => v.id);
    const staleProp = (vm.viewModelProperties || []).filter(p => p.name === rig && p.propertyType === "viewModel").map(p => p.id);
    if (stale.length || staleProp.length) await mcp("delete_objects", { objectIds: [...staleProp, ...stale] });
    const props = ["x", "y", ...origins.map((_, i) => `p${i}`)];
    await mcp("viewmodel_editor", { command: "createViewModels", data: { createViewModels: { viewModels: [
      { name, viewModelProperties: props.map(n => ({ name: n, propertyType: "number" })) }] } } });
    const poses = (await listVMs()).find(v => v.name === name);
    if (!poses) throw new Error(`View model "${name}" was not created.`);
    const ids = Object.fromEntries((poses.viewModelProperties || []).map(p => [p.name, p.id]));
    for (const n of props) if (!ids[n]) throw new Error(`View model property ${n} was not created.`);
    const value = n => n[0] === "p" ? String(origins[+n.slice(1)]) : "0";
    await mcp("viewmodel_editor", { command: "createViewModelInstances", data: { createViewModelInstances: { viewModelId: poses.id,
      instances: [{ name: "Default", instanceProperties: props.map(n => ({ viewModelPropertyId: ids[n], propertyType: "number", value: value(n) })) }] } } });
    const made = await listInstances(poses.id);   // the editor adds an "Instance" of its own
    const inst = made.find(i => i.name === "Default") || made[0];
    if (!inst) throw new Error(`View model "${name}" has no instance.`);
    await mcp("set_property_values", { propertyValues: { [poses.id]: { 564: inst.id } } });
    await mcp("viewmodel_editor", { command: "addProperties", data: { addProperties: { viewModels: [
      { viewModelId: vm.id, viewModelProperties: [{ name: rig, propertyType: "viewModel", viewModelId: poses.id }] }] } } });
    const nestedProp = ((await listVMs()).find(v => v.id === vm.id)?.viewModelProperties || []).find(p => p.name === rig);
    if (!nestedProp) throw new Error(`Could not add "${rig}" to view model "${vm.name}".`);
    for (const parent of await listInstances(vm.id)) {
      const slot = (parent.viewModelProperties || []).find(p => p.name === rig);
      if (slot) await mcp("set_property_values", { propertyValues: { [slot.id]: { 577: inst.id } } });
    }
    return { poses, ids, nestedPropId: nestedProp.id, path: `${vm.name} -> ${rig}` };
  }

  async function bindJoystickScript({ artboardId, artboardName, timelineId, order, rig, joystickId, removeKeys, bias, selectedOnly, language }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    const script = await ensureScript(rig, artboardId);   // before claim unbinds an earlier rig
    if (language && language !== script.language) log(`This file runs ${script.language === "luau" ? "Luau" : "AnimaScript"} scripts, so the rig script is ${script.language === "luau" ? "Luau" : "AnimaScript"}.`);
    await claim(file, timelineId, rig);
    const scope = selectedOnly ? await selectedScope() : null;
    const tracks = await poseTracks(timelineId, scope);
    const rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, [0, 1, 2, 3, 4]);
      if (E.joystickFormula("__VM__", rig, values, order)) rows.push({ t, values });
    }
    if (!rows.length) throw noChanges(tracks, scope);
    log(`${rows.length} properties to bind.`);

    const vm = await artboardViewModel(artboardId, artboardName);
    const pv = await poseViewModel(vm, rig, rows.map(r => r.values[0]));
    log("Binding properties…");
    // nested properties bind with the nested view model's id plus the route from the artboard's
    const joyBinds = [{ objectId: joystickId, propertyKey: 299, viewModelPropertyId: pv.ids.x, path: pv.path },
                      { objectId: joystickId, propertyKey: 300, viewModelPropertyId: pv.ids.y, path: pv.path }];
    const made = [];
    let note = "";
    try {
      made.push(...await bind(pv.poses.id, joyBinds, artboardId));
      await toSource(joyBinds.map(({ objectId, propertyKey }) => ({ objectId, propertyKey })));
      made.push(...await bind(pv.poses.id, rows.map((r, i) => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey,
        viewModelPropertyId: pv.ids[`p${i}`], path: pv.path })), artboardId));
      await setLanguage(script.name, script.language);
      await writeScript(script.name, scriptSource(script.language, rig, rows, order, bias));
      note = await reloadHint(script.name, script.language);
    } catch (e) {
      // leave the file as it was: no half-made rig
      await mcp("delete_objects", { objectIds: [...made, pv.nestedPropId, pv.poses.id] }).catch(() => {});
      throw e;
    }

    const manifest = {
      kind: "joystick", drive: "script", version: 1, file, rig, artboardId, timelineId, order, joystickId, vmId: vm.id,
      poseVmId: pv.poses.id, nestedPropId: pv.nestedPropId, script: script.name, scriptLanguage: script.language, made: script.made, bias, binds: made,
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
    return { ...manifest, note };
  }

  async function setEaseBias(m, bias) {
    if (m.drive === "script") {
      const rows = m.tracks.map(t => ({ values: E.poseValues(t, [0, 1, 2, 3, 4]) }));
      m.scriptLanguage = await fileLanguage();   // a rig bound in the wrong language heals here
      await setLanguage(m.script, m.scriptLanguage);
      await writeScript(m.script, scriptSource(m.scriptLanguage, m.rig, rows, m.order, bias));
      m.bias = bias;
      await saveManifest(m);
      return;
    }
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
    await claim(file, timelineId, rig);
    const scope = selectedOnly ? await selectedScope() : null;
    const tracks = await poseTracks(timelineId, scope);
    const frames = Array.from({ length: poses + 1 }, (_, i) => i);
    const rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, frames);
      const formula = E.sliderFormula("__VM__", rig, values, allowNegative);
      if (formula) rows.push({ t, formula });
    }
    if (!rows.length) throw noChanges(tracks, scope);
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
    if (!m) throw new Error("Bind a NumInput rig first.");
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
    if (!m) throw new Error("Bind a joystick first; the toggler reads its position.");
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
    if (m.drive === "script") {
      extra.push(m.nestedPropId, m.poseVmId);
      // the placement goes too when Poser made it; the user's script stays, emptied, so it stops
      // looking for the removed view model (rigs from before kept a script Poser made: it goes)
      if (m.made?.placement) extra.push(m.made.placement);
      if (m.made?.script) { try { extra.push((await scriptAsset(m.script)).id); } catch {} }
      else { try { await writeScript(m.script, E.placeholderScript(m.rig, m.scriptLanguage)); } catch {} }
    }
    else if (m.kind === "joystick") extra.push(...Object.values(m.nodes), m.groupId, m.timelines.X, m.timelines.Y);
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

  return { fileKey, artboards, timelines, joysticks, selection, ensureScript, saveManifest, takeWarning, bindJoystick, bindJoystickScript, setEaseBias, bindSliders,
           bindJoystickToSlider, bindSwitch, unbind, manifests, keyAll, unkeyFlat, pasteOrigin, pathFlip };
}
