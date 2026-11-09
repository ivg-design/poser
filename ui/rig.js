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

  // no selection must not fall back to the whole timeline
  async function bindScope() {
    const scope = await selectedScope();
    if (!scope) throw new Error('"Only the selection" is on, but nothing is selected in the editor.');
    return scope;
  }

  // A joystick's handle is a control, never a pose. Moving one while a timeline is open keys it, and
  // a rig must not bind its own joystick as a posed property.
  const JOYSTICK_KEYS = new Set([299, 300, 301, 302]);

  async function poseTracks(timelineId, scope) {
    const r = await mcp("animation_editor", { command: "queryKeyFrames", data: { queryKeyFrames: { animationIds: [timelineId] } } });
    const tracks = E.tracksFrom(r.keyframes?.[timelineId] || []);
    for (const k of [...tracks.keys()]) if (JOYSTICK_KEYS.has(tracks.get(k).propertyKey)) tracks.delete(k);
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

  // A script rig's numbers on the artboard's view model, each instance starting at the value given
  // (its rest value), so nothing jumps before the script runs. Every name is the rig's own, so
  // Unbind deletes them all. Since 3.4 rigs make no nested view model: Rive 0.9.517 crashed deleting those.
  async function rigNumbers(vm, values) {
    const names = Object.keys(values);
    if (names.length > 100) log(`Adding ${names.length} numbers to "${vm.name}"… a big rig can take a minute.`);
    const r = await ensureNumbers(vm, names);
    const sets = {};
    for (const inst of await listInstances(r.vm.id))
      for (const p of inst.viewModelProperties || []) if (p.name in values) sets[p.id] = { 575: values[p.name] };
    for (const part of chunks(Object.keys(sets), 400))
      await mcp("set_property_values", { propertyValues: Object.fromEntries(part.map(id => [id, sets[id]])) });
    return { vm: r.vm, ids: r.ids, names };
  }

  // deletes what's there; one id that's already gone can fail a batch, so the rest go one by one
  async function deleteAll(ids) {
    let failed = 0;
    for (const part of chunks(ids.filter(Boolean), 400)) {
      try { await mcp("delete_objects", { objectIds: part }); }
      catch { for (const id of part) { try { await mcp("delete_objects", { objectIds: [id] }); } catch { failed++; } } }
    }
    return failed;
  }

  async function deleteNumbers(vmId, names) {
    log("Undoing: removing what this bind made…");
    const vm = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === vmId);
    return deleteAll((vm?.viewModelProperties || []).filter(p => names.includes(p.name)).map(p => p.id));
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
  // databind on a property that is already bound retargets that bind instead of adding one, and it
  // keeps its old converter and direction. listDataBinds gives no bind ids, so Poser can't remove a
  // bind it didn't record: a property that is still bound is refused before anything is made
  // An editor session can keep listing a bind deleted over MCP until the file is reloaded (seen
  // after a long session; a fresh one drops it at once), so what Unbind removed is remembered
  const allBinds = async () =>
    (await mcp("viewmodel_editor", { command: "listDataBinds", data: { listDataBinds: {} } })).dataBinds || [];
  const unbound = new Set();
  const pair = d => `${d.objectId}:${d.propertyKey}`;
  // a leftover's view model property is gone, so the editor lists it as unresolved
  const boundError = (taken, other) => {
    const more = n => (n > 1 ? ` and ${n - 1} more` : "");
    const live = taken.filter(t => !t.unresolved && t.viewModelPropertyName && !unbound.has(pair(t)));
    if (!live.length) {
      const d = taken[0];
      return new Error(`"${d.objectName}" ${d.property}${more(taken.length)} still ${taken.length > 1 ? "have binds" : "has a bind"} left from a removed rig: the editor keeps removed binds until the file is reloaded. Reload the file (Cmd+R), then bind again. If it is still listed after the reload, remove it in the editor.`);
    }
    const d = live[0];
    return new Error(`"${d.objectName}" ${d.property} is still bound to ${d.viewModelName ? `${d.viewModelName}/` : ""}${d.viewModelPropertyName}${more(live.length)}. Remove that bind in the editor, or ${other}.`);
  };
  // Properties another rig still binds are refused before anything is made: on the script drive a
  // refusal after the nested view model exists means deleting it again, which is what crashed Rive.
  async function refuseBound(pairs, other) {
    const want = new Set(pairs.map(pair));
    const taken = (await allBinds()).filter(d => want.has(pair(d)));
    if (taken.length) throw boundError(taken, other);
  }
  const OTHER_RIG = "unbind the rig that binds them first (rig names are case-sensitive)";
  const SETTLE_MS = 400;   // a pause for the editor to catch up after rewriting a script

  // Live binds on these properties from another rig. Leftovers of removed binds mean a reload, not a
  // choice. One is shareable when its owner is a One-script NumInput rig (its number p<n>).
  async function boundOf(pairs, rig) {
    if (!pairs.length) return [];
    const want = new Set(pairs.map(pair));
    const taken = (await allBinds()).filter(d => want.has(pair(d)));
    const live = taken.filter(d => !d.unresolved && d.viewModelPropertyName && !unbound.has(pair(d)));
    if (taken.length && !live.length) throw boundError(taken, OTHER_RIG);
    if (!live.length) return [];
    const owners = (await manifests()).filter(m => m.kind === "sliders" && m.drive === "script" && !m.cleanup && m.rig !== rig && m.script);
    return live.map(d => {
      for (const o of owners) {
        const n = o.flat
          ? (d.viewModelId === o.vmId ? new RegExp(`^${o.rig}_p(\\d+)$`).exec(d.viewModelPropertyName)?.[1] : undefined)
          : (d.viewModelId === o.poseVmId ? /^p(\d+)$/.exec(d.viewModelPropertyName)?.[1] : undefined);
        if (n !== undefined) return { d, owner: o, n: +n };
      }
      return { d, owner: null, n: null };
    });
  }

  // The panel turns this into a choice: share them with the rig that owns them (One-script NumInput
  // rigs on both sides), skip them and bind the rest, or cancel.
  function boundChoice(bound, canShare) {
    const e = boundError(bound.map(b => b.d), "choose what to do below");
    const owners = [...new Set(bound.filter(b => b.owner).map(b => b.owner.rig))];
    e.choice = { count: bound.length, shareable: canShare ? bound.filter(b => b.owner).length : 0, owners: canShare ? owners : [] };
    return e;
  }
  const NOTHING_LEFT = "Every posed property is already bound by another rig, so nothing is left to bind.";

  // a share is only right when both rigs rest at the same value
  function sameRest(owner, r) {
    const t = (owner.tracks || []).find(x => x.objectId === r.t.objectId && x.propertyKey === r.t.propertyKey);
    if (!t) return false;
    const a = E.sample(t.keys, 0), b = r.values[0];
    return Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a));
  }

  // What happens to posed properties another rig already binds: "ask" (the panel offers the choice),
  // "share" (with their owner, when it can) or "skip". Shared rows carry { owner, n }.
  async function settleBound(rows, rig, onBound, canShare) {
    const bound = await boundOf(rows.map(r => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey })), rig);
    if (!bound.length) return { rows, shared: 0, skipped: 0, restDiffers: 0 };
    if (onBound === "ask") throw boundChoice(bound, canShare);
    const byPair = new Map(bound.map(b => [pair(b.d), b]));
    const kept = [];
    let restDiffers = 0;
    for (const r of rows) {
      const b = byPair.get(pair({ objectId: r.t.objectId, propertyKey: r.t.propertyKey }));
      if (!b) { kept.push(r); continue; }
      if (onBound === "share" && canShare && b.owner) {
        if (sameRest(b.owner, r)) { kept.push({ ...r, share: { owner: b.owner.rig, n: b.n } }); continue; }
        restDiffers++;
      }
    }
    if (!kept.length) throw new Error(NOTHING_LEFT);
    return { rows: kept, shared: kept.filter(r => r.share).length, skipped: rows.length - kept.length, restDiffers };
  }

  // An owner adds its guests' shares. Its script is rewritten whenever its guests change.
  async function rewriteOwner(owner) {
    const names = owner.poseInputs || owner.sliders;
    const frames = Array.from({ length: names.length + 1 }, (_, i) => i);
    const rows = owner.tracks.map(t => ({ values: E.poseValues(t, frames), ...(t.share ? { share: t.share } : {}) }));
    await setLanguage(owner.script, "luau");
    await writeScript(owner.script, E.numInputScriptLuau(owner.rig, names, rows, owner.allowNegative, owner.guests || [], !owner.flat));
    await saveManifest(owner);
  }

  async function bind(vmId, bindings, artboardId) {
    const want = new Set(bindings.map(pair));
    const taken = (await allBinds()).filter(d => want.has(pair(d)));
    if (taken.length) throw boundError(taken, "use other objects");
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
  const warn = text => { warning = [warning, text].filter(Boolean).join(" "); };
  async function saveManifest(m) {
    m.savedAt = Date.now();
    await store.save(manifestName(m), JSON.stringify(m));
    try { await saveRecordScript(m); } catch (e) { warn(String(e.message || e)); }
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

  // the newer of the two copies wins (the in-file one when neither carries a save time),
  // so a failed in-file write never brings back an older record
  let unreadable = [];
  async function manifests() {
    const file = await fileKey();
    const byRig = new Map((await store.list()).map(j => JSON.parse(j)).filter(m => m.file === file).map(m => [m.rig, m]));
    unreadable = [];
    for (const a of await recordAssets()) {
      let m = null;
      try { m = parseRecord(await readScript(a.name)); } catch {}
      if (!m?.rig) { const name = a.name.match(RECORD)[1]; if (!byRig.has(name)) unreadable.push(name); continue; }
      if ((m.savedAt || 0) >= (byRig.get(m.rig)?.savedAt || 0)) byRig.set(m.rig, { ...m, file });
    }
    return [...byRig.values()];
  }
  // rigs whose record script is in the file but holds nothing Poser can read, with no copy in the app
  const unreadableRecords = () => unreadable;

  async function dropManifest(m) {
    await store.remove(manifestName(m));
    const asset = (await recordAssets()).find(a => a.name === recordName(m.rig));
    if (asset) await mcp("delete_objects", { objectIds: [asset.id] });
  }

  const KIND_NAME = { joystick: "Joystick", sliders: "NumInput", toggler: "Toggler" };

  // a rigged timeline's pose keys live in its manifest, so binding it again finds nothing:
  // the same rig name rebinds (unbind restores the keys first), another rig name is refused
  const nestedFirst = rig => new Error(`"${rig}" has a nested view model. Unbind it on its tab first (two clicks, with a reload between), then bind again.`);
  // the same refusal as claim(), before a script or view model is made
  async function claimable(file, rig) {
    const same = (await store.list()).map(j => JSON.parse(j)).find(m => m.file === file && m.rig === rig);
    if (same && (same.nestedPropId || same.cleanup) && !same.flat) throw nestedFirst(rig);
  }

  async function claim(file, timelineId, rig, kind) {
    const ms = (await store.list()).map(j => JSON.parse(j)).filter(m => m.file === file);
    const other = timelineId && ms.find(m => m.rig !== rig && m.timelineId === timelineId);
    if (other) throw new Error(`That timeline is already rigged as "${other.rig}". Use rig name "${other.rig}" to rebind it, or unbind it on its tab.`);
    const same = ms.find(m => m.rig === rig);
    if (same && same.kind !== kind) throw new Error(`The name "${rig}" is taken by a ${KIND_NAME[same.kind] || same.kind} rig. Use another rig name, or unbind that rig on its tab.`);
    if (same && (same.nestedPropId || same.cleanup) && !same.flat) throw nestedFirst(rig);
    if (same) {
      log(`Rig "${rig}" exists: unbinding it first.`);
      const r = await unbind(same);
      if (r.left) throw new Error(`Rig "${rig}" existed, so Poser unbound it and put its keys back, but the editor still lists ${r.left} of its binds until the file is reloaded. Reload the file (Cmd+R), then bind again.`);
    }
  }

  // one rig per joystick axis: a second bind on the same joystick property leaves the editor with
  // two binds there, and the direction change can land on the old one
  async function joystickFree(joystickId, axes, rig) {
    for (const m of await manifests()) {
      if (m.kind === "joystick" && m.rig !== rig && m.joystickId === joystickId)
        throw new Error(`That joystick already drives the rig "${m.rig}". Unbind it first, or add another joystick (J).`);
      if (m.kind === "toggler" && m.rig !== rig && !m.source && m.joystickId === joystickId)
        throw new Error(`That joystick already drives the toggler "${m.rig}". Unbind it first, or add another joystick (J).`);
      const c = (m.connections || []).find(c => c.joystickId === joystickId && axes.includes(c.axis));
      if (c) throw new Error(`That joystick's ${c.axis} already drives ${c.slider} of the NumInput rig "${m.rig}". Unbind that rig first, or add another joystick (J).`);
    }
    const keys = axes.map(a => (a === "x" ? 299 : 300));
    const live = (await allBinds()).filter(d => d.objectId === joystickId && keys.includes(d.propertyKey));
    if (live.length) throw boundError(live, "add another joystick (J)");
  }

  const AXIS = { x: { value: 299, timeline: 301 }, y: { value: 300, timeline: 302 } };

  // A timeline with nothing in it. On a joystick's axis it makes the handle move along that axis
  // only, which is what turns the joystick into a slider. Timelines belong to the active artboard.
  // The MCP refuses 0-0 on a joystick's axis, so an axis is cleared by deleting its timeline, and
  // every axis needs a timeline of its own.
  async function createTimeline(name, artboardId, duration, ifTaken) {
    if ((await artboards()).active !== artboardId)
      await mcp("open_file_editor", { command: "focusArtboard", data: { focusArtboard: { artboardId } } });
    const have = new Set((await timelines()).map(t => t.name));
    const final = have.has(name) ? ifTaken : name;
    const made = (await mcp("animation_editor", { command: "createLinearAnimations", data: { createLinearAnimations: {
      linearAnimations: [{ name: final, duration }] } } })).animations || [];
    const id = made.find(a => a.name === final)?.id;
    if (!id) throw new Error(`Timeline "${final}" was not created.`);
    return { id, name: final };
  }
  const emptyTimeline = async (name, artboardId) => (await createTimeline(name, artboardId, 1, `poser ${name}`)).id;

  // The timelines Poser puts on a joystick's axes start empty. One that has keys now holds someone's
  // work, so it stays. If the check fails, nothing is deleted.
  async function keyedTimelines(ids) {
    if (!ids.length) return new Set();
    try {
      const r = await mcp("animation_editor", { command: "queryKeyFrames", data: { queryKeyFrames: { animationIds: ids } } });
      return new Set(ids.filter(id => (r.keyframes?.[id] || []).length));
    } catch { return new Set(ids); }
  }

  // Binding with "Remove the pose keys" can leave the pose timeline empty, and you may delete it.
  // So a rig records what it takes to make that timeline again: its name, and its fps (56),
  // length in frames (57), speed (58) and loop (59).
  const TIMELINE_KEYS = [56, 57, 58, 59];
  async function timelineInfo(timelineId) {
    const timelineName = (await timelines()).find(t => t.id === timelineId)?.name;
    const timelineProps = (await mcp("query_property_values", { propertyKeys: { [timelineId]: TIMELINE_KEYS } })).values?.[timelineId] || {};
    return { timelineName, timelineProps };
  }

  // The timeline Unbind puts the pose keys back on: the original if it's still there, otherwise a
  // new one with its name and settings. A different timeline that took the name is left alone.
  async function poseTimeline(m) {
    const alive = (await mcp("query_objects", { objectIds: [m.timelineId], depth: 0 })).objects || [];
    if (alive.some(o => o.id === m.timelineId)) return { id: m.timelineId };
    const name = m.timelineName || `${m.rig} poses`;
    const props = m.timelineProps || {};
    const lastKey = Math.max(0, ...m.tracks.flatMap(t => t.keys.map(k => k.frame)));
    const frames = Math.max(props[57] || 0, lastKey + 1);
    const made = await createTimeline(name, m.artboardId, frames / (props[56] || 60), `${name} restored`);
    const settings = Object.fromEntries(TIMELINE_KEYS.filter(k => props[k] !== undefined).map(k => [k, k === 57 ? frames : props[k]]));
    if (Object.keys(settings).length) await mcp("set_property_values", { propertyValues: { [made.id]: settings } }).catch(() => {});
    log(`The timeline "${name}" was gone, so Poser made it again as "${made.name}".`);
    return { id: made.id, recreated: made.name };
  }

  // The artboard's view-model numbers a rig can read. Numbers Poser added go when their rig goes,
  // so they aren't offered.
  async function numbers(artboardId, ms) {
    const q = await mcp("query_property_values", { propertyKeys: { [artboardId]: [583] } });
    const vm = (await listVMs()).find(v => v.id === q.values?.[artboardId]?.["583"]);
    if (!vm) return [];
    const poser = new Set((ms || await manifests()).flatMap(m => m.addedProps || []));
    return (vm.viewModelProperties || []).filter(p => p.propertyType === "number" && !poser.has(p.name)).map(p => p.name);
  }

  // NumInput and Toggler write their rig script in Luau, the only language the editor can make a Node in
  async function luauScript(rig, artboardId) {
    const script = await ensureScript(rig, artboardId);
    if (script.language !== "luau") throw new Error("This file runs AnimaScript, and Poser writes NumInput and Toggler scripts in Luau. Use the formula drive.");
    return script;
  }

  // a curve the editor didn't report can't come back from Unbind, so say so while the keys are removed
  function warnCurves(rows) {
    const n = E.unreadCurves(rows.map(r => r.t));
    if (n) warn(`${n} pose key${n > 1 ? "s have curves" : " has a curve"} Poser couldn't read. Unbind will restore ${n > 1 ? "them" : "it"} without ${n > 1 ? "those curves" : "that curve"}.`);
  }

  // A refused bind should make nothing. A rig of this name gets its keys back when claim() unbinds
  // it, so an empty timeline can only be refused when there's no such rig.
  async function checkPoses(file, rig, timelineId, scope, isPosed, onBound = "ask", canShare = false) {
    if ((await store.list()).map(j => JSON.parse(j)).some(m => m.file === file && m.rig === rig)) return;
    const tracks = await poseTracks(timelineId, scope);
    const posed = [...tracks.values()].filter(isPosed);
    if (!posed.length) throw noChanges(tracks, scope);
    const bound = await boundOf(posed.map(t => ({ objectId: t.objectId, propertyKey: t.propertyKey })), rig);
    if (bound.length && onBound === "ask") throw boundChoice(bound, canShare);
    if (bound.length === posed.length && !(onBound === "share" && canShare && bound.some(b => b.owner))) throw new Error(NOTHING_LEFT);
  }

  function noChanges(tracks, scope) {
    const where = scope ? " for the selection" : "";
    return new Error(tracks.size
      ? `None of the ${tracks.size} keyed properties in that timeline change across the pose frames${where}.`
      : `That timeline has no number keys${where}.`);
  }

  // ------------------------------------------------------------ joystick

  async function bindJoystick({ artboardId, artboardName, timelineId, order, rig, joystickId, removeKeys, bias, selectedOnly, onBound = "ask" }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    const scope = selectedOnly ? await bindScope() : null;   // before anything can change the selection
    await claim(file, timelineId, rig, "joystick");
    await joystickFree(joystickId, ["x", "y"], rig);
    const tracks = await poseTracks(timelineId, scope);
    const frames = [0, 1, 2, 3, 4];
    let rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, frames);
      const formula = E.joystickFormula("__VM__", rig, values, order);
      if (formula) rows.push({ t, values, formula });
    }
    if (!rows.length) throw noChanges(tracks, scope);
    const settled = await settleBound(rows, rig, onBound, false);
    rows = settled.rows;
    log(`${rows.length} properties to bind.`);

    let vm = await artboardViewModel(artboardId, artboardName);
    const names = ["fL", "fR", "fU", "fD", "x", "y"].map(n => `${rig}_${n}`);
    const { vm: vm2, ids, added } = await ensureNumbers(vm, names);
    vm = vm2;
    // everything below is undone if a step fails, so a refused bind leaves no half-made rig
    let group = null;
    const nodes = {}, tl = {};
    let convIds = [], controlBinds = [], propBinds = [];
    try {
      // factor nodes under one group, keyed by two timelines the joystick scrubs
      group = (await mcp("group_editor", { name: `poser ${rig}`, parentId: artboardId })).group;
      for (const d of E.DIRECTIONS) {
        nodes[d] = (await mcp("group_editor", { name: `${rig} f${d}`, parentId: group.id })).group?.id;
        if (!nodes[d]) throw new Error(`Factor node f${d} was not created.`);
      }
      const tlNames = { X: `poser ${rig} X`, Y: `poser ${rig} Y` };
      const madeTl = (await mcp("animation_editor", { command: "createLinearAnimations", data: { createLinearAnimations: {
        linearAnimations: Object.values(tlNames).map(name => ({ name, duration: E.FACTOR_FRAMES / 60 })) } } })).animations || [];
      tl.X = madeTl.find(a => a.name === tlNames.X)?.id;
      tl.Y = madeTl.find(a => a.name === tlNames.Y)?.id;
      if (!tl.X || !tl.Y) throw new Error("Factor timelines were not created.");
      for (const axis of ["X", "Y"]) {
        await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: tl[axis], add: E.factorKeys(nodes, axis, bias) } } });
      }
      await mcp("set_property_values", { propertyValues: { [joystickId]: { 301: tl.X, 302: tl.Y } } });

      // factors and the raw joystick position flow into the view model
      const factorBinds = E.DIRECTIONS.map(d => ({ objectId: nodes[d], propertyKey: 13, viewModelPropertyId: ids[`${rig}_f${d}`] }));
      const joyBinds = [{ objectId: joystickId, propertyKey: 299, viewModelPropertyId: ids[`${rig}_x`] },
                        { objectId: joystickId, propertyKey: 300, viewModelPropertyId: ids[`${rig}_y`] }];
      controlBinds = await bind(vm.id, [...factorBinds, ...joyBinds], artboardId);
      await toSource([...factorBinds, ...joyBinds].map(({ objectId, propertyKey }) => ({ objectId, propertyKey })));

      // one formula converter per posed property
      const conv = rows.map(r => ({ name: E.converterName(rig, r.t.objectId, r.t.propertyName), formula: r.formula.replaceAll("__VM__", vm.name) }));
      log(`Creating ${conv.length} converters…`);
      convIds = await makeConverters(conv);
      log("Binding properties…");
      propBinds = await bind(vm.id, rows.map((r, i) => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, viewModelPropertyId: ids[`${rig}_fR`], converterId: convIds[i] })), artboardId);
    } catch (e) {
      log("Undoing: removing what this bind made…");
      await deleteAll([...controlBinds, ...propBinds, ...convIds]);
      await deleteAll([tl.X, tl.Y, ...Object.values(nodes), group?.id]);   // deleting the timelines clears the joystick's axes
      if (added.length) await deleteNumbers(vm.id, added).catch(() => {});
      e.rolledBack = true;
      throw e;
    }

    const manifest = {
      kind: "joystick", version: 1, file, rig, artboardId, timelineId, ...await timelineInfo(timelineId), order, joystickId, vmId: vm.id, addedProps: added,
      groupId: group.id, nodes, timelines: tl, converters: convIds, bias, binds: [...controlBinds, ...propBinds],
      tracks: rows.map(r => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, propertyName: r.t.propertyName,
        keys: E.savedKeys(r.t) })),
    };
    if (removeKeys) {
      warnCurves(rows);
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

  const scriptSource = (language, rig, rows, order, bias, nested = true) =>
    (language === "luau" ? E.poseScriptLuau : E.poseScript)(rig, rows, order, bias, nested);

  const listVMs = async () => (await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || [];
  const listInstances = async viewModelId => (await mcp("viewmodel_editor", { command: "listViewModelInstances",
    data: { listViewModelInstances: { viewModelId } } })).instances || [];

  // A leftover `poser <rig>` view model (or a <rig> property that nests one) with no record would be
  // deleted mid-bind, and deleting view-model data before a reload is what crashes Rive. So it's
  // refused before anything is made; the user deletes it in the Data panel, or picks another name.
  async function refuseStaleNested(rig, artboardId) {
    const name = E.scriptVmName(rig);
    const recorded = new Set((await manifests()).flatMap(m => [m.poseVmId, m.cleanup?.poseVmId].filter(Boolean)));
    const vms = await listVMs();
    const stale = vms.find(v => v.name === name && !recorded.has(v.id));
    const q = await mcp("query_property_values", { propertyKeys: { [artboardId]: [583] } });
    const board = vms.find(v => v.id === q.values?.[artboardId]?.["583"]);
    const prop = (board?.viewModelProperties || []).find(p => p.name === rig && p.propertyType === "viewModel");
    if (stale || prop) throw new Error(`"${name}" is left from an earlier bind of "${rig}", with no record. Delete it in the Data panel`
      + `${prop ? ` (the "${rig}" property on "${board.name}"${stale ? ` and the "${name}" view model` : ""})` : ""}, or use another rig name.`);
  }

  // `poser <rig>` view model (the control numbers, then p0…pN) with a Default instance, nested in the
  // artboard's view model as `<rig>`, and every instance of the artboard's view model pointed at it
  async function poseViewModel(vm, rig, origins, controls = ["x", "y"]) {
    const name = E.scriptVmName(rig);
    const props = [...controls, ...origins.map((_, i) => `p${i}`)];
    if (props.length > 100) log(`Creating the view model "${name}" with ${props.length} numbers…`);
    await mcp("viewmodel_editor", { command: "createViewModels", data: { createViewModels: { viewModels: [
      { name, viewModelProperties: props.map(n => ({ name: n, propertyType: "number" })) }] } } });
    const poses = (await listVMs()).find(v => v.name === name);
    if (!poses) throw new Error(`View model "${name}" was not created.`);
    const ids = Object.fromEntries((poses.viewModelProperties || []).map(p => [p.name, p.id]));
    for (const n of props) if (!ids[n]) throw new Error(`View model property ${n} was not created.`);
    const value = n => (/^p\d+$/.test(n) ? String(origins[+n.slice(1)]) : "0");
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

  // A failed bind undoes what it made except its nested view model, which waits for a reload: this
  // record lists it under "old view model left", and the next Unbind removes it.
  async function leaveNested(kind, rig, file, vmId, artboardId, pv) {
    await saveManifest({ kind, rig, file, version: 1, vmId, artboardId, drive: "script", tracks: [], items: [],
      cleanup: { nestedPropId: pv.nestedPropId, poseVmId: pv.poses.id } });
  }

  const leftNote = rig => ` Poser left the view model "poser ${rig}" for after a reload: reload the file (Cmd+R), click Reloaded, then Unbind "${rig}" to remove it.`;

  // the made script and its placement go with a failed bind (no view-model data in them)
  const dropMadeScript = async script => {
    const ids = [script.made?.placement];
    if (script.made?.script) { try { ids.push((await scriptAsset(script.name)).id); } catch {} }
    await deleteAll(ids);
  };

  async function bindJoystickScript({ artboardId, artboardName, timelineId, order, rig, joystickId, removeKeys, bias, selectedOnly, language, onBound = "ask" }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    // making the rig script opens it in the editor, which drops the selection, so read that first
    const scope = selectedOnly ? await bindScope() : null;
    await checkPoses(file, rig, timelineId, scope, t => E.joystickFormula("__VM__", rig, E.poseValues(t, [0, 1, 2, 3, 4]), order), onBound, false);
    await claimable(file, rig);
    await refuseStaleNested(rig, artboardId);
    const script = await ensureScript(rig, artboardId);   // before claim unbinds an earlier rig
    if (language && language !== script.language) log(`This file runs ${script.language === "luau" ? "Luau" : "AnimaScript"} scripts, so the rig script is ${script.language === "luau" ? "Luau" : "AnimaScript"}.`);
    await claim(file, timelineId, rig, "joystick");
    await joystickFree(joystickId, ["x", "y"], rig);
    const tracks = await poseTracks(timelineId, scope);
    let rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, [0, 1, 2, 3, 4]);
      if (E.joystickFormula("__VM__", rig, values, order)) rows.push({ t, values });
    }
    if (!rows.length) throw noChanges(tracks, scope);
    rows = (await settleBound(rows, rig, onBound, false)).rows;
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
      // undo what it made; the nested view model waits for a reload (see leaveNested)
      log("Undoing: removing what this bind made…");
      await deleteAll(made);
      await dropMadeScript(script);
      await leaveNested("joystick", rig, file, vm.id, artboardId, pv);
      e.message += leftNote(rig);
      e.rolledBack = true;
      throw e;
    }

    const manifest = {
      kind: "joystick", drive: "script", version: 1, file, rig, artboardId, timelineId, ...await timelineInfo(timelineId), order, joystickId, vmId: vm.id,
      poseVmId: pv.poses.id, nestedPropId: pv.nestedPropId, script: script.name, scriptLanguage: script.language, made: script.made, bias, binds: made,
      tracks: rows.map(r => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, propertyName: r.t.propertyName,
        keys: E.savedKeys(r.t) })),
    };
    if (removeKeys) {
      warnCurves(rows);
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
      await writeScript(m.script, scriptSource(m.scriptLanguage, m.rig, rows, m.order, bias, !m.flat));
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

  async function bindSliders({ artboardId, artboardName, timelineId, rig, poses, inputs = [], drive = "formula", allowNegative, removeKeys, selectedOnly, onBound = "ask" }) {
    rig = E.safeName(rig);
    const file = await fileKey();
    const frames = Array.from({ length: poses + 1 }, (_, i) => i);
    const names = E.sliderInputs(rig, poses, inputs);
    // making the rig script opens it in the editor, which drops the selection, so read that first
    const scope = selectedOnly ? await bindScope() : null;
    const canShare = drive === "script";
    await checkPoses(file, rig, timelineId, scope, t => E.sliderFormula("__VM__", rig, E.poseValues(t, frames), allowNegative, names), onBound, canShare);
    if (drive === "script") { await claimable(file, rig); await refuseStaleNested(rig, artboardId); }
    const script = drive === "script" ? await luauScript(rig, artboardId) : null;
    await claim(file, timelineId, rig, "sliders");
    const tracks = await poseTracks(timelineId, scope);
    let rows = [];
    for (const t of tracks.values()) {
      const values = E.poseValues(t, frames);
      const formula = E.sliderFormula("__VM__", rig, values, allowNegative, names);
      if (formula) rows.push({ t, values, formula });
    }
    if (!rows.length) throw noChanges(tracks, scope);
    const settled = await settleBound(rows, rig, onBound, canShare);
    rows = settled.rows;
    const outs = E.numInputOuts(rig, rows, true);
    let vm = await artboardViewModel(artboardId, artboardName);
    const { vm: vm2, ids, added } = await ensureNumbers(vm, names);
    vm = vm2;
    const manifest = {
      kind: "sliders", drive, version: 1, file, rig, artboardId, timelineId, ...await timelineInfo(timelineId), vmId: vm.id, addedProps: added, sliders: [...new Set(names)], poseInputs: names, allowNegative,
      tracks: rows.map((r, i) => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, propertyName: r.t.propertyName,
        keys: E.savedKeys(r.t), out: outs[i].name, ...(r.share ? { share: r.share } : {}) })),
    };
    const own = rows.filter(r => !r.share);
    const shares = rows.filter(r => r.share).map(r => ({ ...r.share, objectId: r.t.objectId, propertyKey: r.t.propertyKey }));
    if (shares.length) manifest.shares = shares;
    let note = "";
    if (script) {
      const shareOuts = outs.filter(o => o.root);
      const nums = shareOuts.length ? await rigNumbers(vm, Object.fromEntries(shareOuts.map(o => [o.name, 0]))) : { names: [], ids: {}, vm };
      vm = nums.vm;
      const pv = await poseViewModel(vm, rig, own.map(r => r.values[0]), []);
      const made = [];
      try {
        made.push(...await bind(pv.poses.id, rows.map((r, i) => (r.share ? null : { objectId: r.t.objectId, propertyKey: r.t.propertyKey,
          viewModelPropertyId: pv.ids[outs[i].name], path: pv.path })).filter(Boolean), artboardId));
        await setLanguage(script.name, script.language);
        await writeScript(script.name, E.numInputScriptLuau(rig, names, rows, allowNegative, [], true));
        note = await reloadHint(script.name, script.language);
      } catch (e) {
        log("Undoing: removing what this bind made…");
        await deleteAll(made);
        if (nums.names.length) await deleteNumbers(vm.id, nums.names).catch(() => {});
        if (added.length) await deleteNumbers(vm.id, added).catch(() => {});
        await dropMadeScript(script);
        await leaveNested("sliders", rig, file, vm.id, artboardId, pv);
        e.message += leftNote(rig);
        e.rolledBack = true;
        throw e;
      }
      Object.assign(manifest, { binds: made, poseVmId: pv.poses.id, nestedPropId: pv.nestedPropId, addedProps: [...new Set([...added, ...nums.names])], script: script.name, scriptLanguage: script.language, made: script.made });
    } else {
      const convIds = await makeConverters(rows.map(r => ({ name: E.converterName(rig, r.t.objectId, r.t.propertyName), formula: r.formula.replaceAll("__VM__", vm.name) })));
      manifest.converters = convIds;
      manifest.binds = await bind(vm.id, rows.map((r, i) => ({ objectId: r.t.objectId, propertyKey: r.t.propertyKey, viewModelPropertyId: ids[names[0]], converterId: convIds[i] })), artboardId);   // the formula drive has no shares
    }
    if (removeKeys) {
      warnCurves(rows);
      for (const part of chunks(rows.flatMap(r => r.t.keys.map(k => k.keyframeId)), 400)) {
        await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timelineId, delete: part } } });
      }
      manifest.keysRemoved = true;
    }
    await saveManifest(manifest);
    // the owners add the shares from now on
    for (const ownerRig of new Set(shares.map(x => x.owner))) {
      try {
        const owner = (await manifests()).find(m => m.rig === ownerRig);
        owner.guests = [...(owner.guests || []).filter(g => g.rig !== rig), { rig, props: shares.filter(x => x.owner === ownerRig).map(x => x.n) }];
        await rewriteOwner(owner);
      } catch (e) {
        warn(`Couldn't update "${ownerRig}" to add this rig's share (${String(e.message || e)}). Bind this rig again to retry.`);
      }
    }
    // poses are added one at a time, so say when the timeline holds more of them than were bound
    const lastKeyed = Math.max(0, ...[...tracks.values()].flatMap(t => t.keys.map(k => k.frame)));
    const past = lastKeyed > poses ? `The timeline has keys up to frame ${lastKeyed}, past pose ${poses}: add poses to bind those too.` : "";
    return { ...manifest, note: [note, past].filter(Boolean).join(" "), shared: settled.shared, skipped: settled.skipped, restDiffers: settled.restDiffers };
  }

  // One joystick axis drags one input. The axis gets an empty timeline of its own, which turns the
  // joystick into a slider, and its position flows into the input through a converter.
  async function bindJoystickToSlider({ sliderRig, slider, joystickId, axis, allowNegative }) {
    const m = (await manifests()).find(x => x.kind === "sliders" && x.rig === sliderRig);
    if (!m) throw new Error("Bind a NumInput rig first.");
    await joystickFree(joystickId, [axis]);
    if ((m.connections || []).some(c => c.slider === slider)) throw new Error(`${slider} already has a joystick. Disconnect it first.`);
    const negative = m.allowNegative ?? allowNegative;
    const vm = (await listVMs()).find(v => v.id === m.vmId);
    const sliderPropId = (vm?.viewModelProperties || []).find(p => p.name === slider)?.id;
    if (!sliderPropId) throw new Error(`The view model has no number "${slider}".`);
    const key = AXIS[axis];
    const [cid] = await makeConverters([{ name: `poser ${sliderRig} ${slider} from ${joystickId} ${axis}`, formula: E.axisFormula(negative) }]);
    const timeline = await emptyTimeline(E.connectionTimeline(m.rig, slider), m.artboardId);
    let ids;
    try {
      await mcp("set_property_values", { propertyValues: { [joystickId]: { [key.timeline]: timeline, [key.value]: E.axisRest(negative) } } });
      ids = await bind(m.vmId, [{ objectId: joystickId, propertyKey: key.value, viewModelPropertyId: sliderPropId, converterId: cid }], m.artboardId);
      await toSource([{ objectId: joystickId, propertyKey: key.value }]);
    } catch (e) {
      await mcp("delete_objects", { objectIds: [timeline, cid] }).catch(() => {});
      throw e;
    }
    m.binds = [...(m.binds || []), ...ids];
    m.converters = [...(m.converters || []), cid];
    m.connections = [...(m.connections || []), { joystickId, axis, slider, bind: ids[0], converter: cid, timeline }];
    await saveManifest(m);
  }

  // undoes one Connect and leaves the rig and its other connections alone
  async function disconnectSlider(m, slider) {
    const c = (m.connections || []).find(x => x.slider === slider);
    if (!c) throw new Error(`${slider} has no joystick.`);
    const key = AXIS[c.axis];
    unbound.add(pair({ objectId: c.joystickId, propertyKey: key.value }));
    const kept = c.timeline && (await keyedTimelines([c.timeline])).has(c.timeline);
    await mcp("delete_objects", { objectIds: [c.bind] });
    await mcp("delete_objects", { objectIds: [c.converter, ...(c.timeline && !kept ? [c.timeline] : [])] }).catch(() => {});
    if (!kept) await mcp("set_property_values", { propertyValues: { [c.joystickId]: { [key.value]: 0 } } }).catch(() => {});
    m.binds = (m.binds || []).filter(b => b !== c.bind);
    m.converters = (m.converters || []).filter(x => x !== c.converter);
    m.connections = m.connections.filter(x => x !== c);
    await saveManifest(m);
    const left = (await allBinds()).filter(d => d.objectId === c.joystickId && d.propertyKey === key.value).length;
    return { left, kept: kept ? E.connectionTimeline(m.rig, c.slider) : null };
  }

  // ------------------------------------------------------------ toggler

  // Only the item nearest the control stays visible. A free joystick becomes this rig's own control
  // (empty timelines on the axes it uses). A joystick that already drives a formula Joystick rig is
  // read through that rig's position numbers and stays as it is.
  async function bindToggler({ artboardId, artboardName, rig, drive = "formula", joystickId, axes = "xy", items }) {
    rig = E.safeName(rig);
    if (items.length < 2) throw new Error("Load at least two items.");
    const file = await fileKey();
    if (drive === "script") { await claimable(file, rig); await refuseStaleNested(rig, artboardId); }
    const script = drive === "script" ? await luauScript(rig, artboardId) : null;
    await claim(file, null, rig, "toggler");
    const host = (await manifests()).find(m => m.kind === "joystick" && m.joystickId === joystickId);
    if (host?.drive === "script") throw new Error(`That joystick drives the script rig "${host.rig}", and a toggler can't read its position. Add another joystick (J), or bind that rig with formula converters.`);
    if (host && axes !== "xy") throw new Error(`That joystick drives the rig "${host.rig}" on both axes, so it can't be a slider. Choose Joystick (both axes), or add another joystick (J).`);
    if (!host) await joystickFree(joystickId, [...axes], rig);

    const pos = host ? { x: `${host.rig}_x`, y: `${host.rig}_y` }
      : { x: axes.includes("x") ? `${rig}_x` : null, y: axes.includes("y") ? `${rig}_y` : null };
    await refuseBound(items.map(it => ({ objectId: it.id, propertyKey: 18 })), OTHER_RIG);
    const vmStart = await artboardViewModel(artboardId, artboardName);
    const { vm, ids, added } = await ensureNumbers(vmStart, host ? [] : [...axes].map(a => pos[a]));
    const shown = (await mcp("query_property_values", { propertyKeys: Object.fromEntries(items.map(it => [it.id, [18]])) })).values || {};

    const made = [];   // deleted again if a step fails, so no half-made rig stays
    let nestedPv = null; // the nested view model, which a failed bind leaves for a reload
    const manifest = { kind: "toggler", drive, version: 1, file, rig, artboardId, joystickId, axes, pos, vmId: vm.id, addedProps: added, tracks: [], timelines: {},
      ...(host ? { source: host.rig } : {}),
      items: items.map(it => ({ id: it.id, name: it.name, x: it.x, y: it.y, opacity: shown[it.id]?.["18"] ?? 1 })) };
    const binds = [];
    let note = "";
    try {
      if (!host) {
        const set = {};
        for (const a of axes) {
          const id = await emptyTimeline(`${rig} ${a.toUpperCase()}`, artboardId);
          made.push(id);
          manifest.timelines[a.toUpperCase()] = id;
          set[AXIS[a].timeline] = id;
          set[AXIS[a].value] = items[0][a];   // at rest the first item shows, not a tie between them
        }
        await mcp("set_property_values", { propertyValues: { [joystickId]: set } });
        const control = [...axes].map(a => ({ objectId: joystickId, propertyKey: AXIS[a].value, viewModelPropertyId: ids[pos[a]] }));
        binds.push(...await bind(vm.id, control, artboardId));
        made.push(...binds);
        await toSource(control.map(({ objectId, propertyKey }) => ({ objectId, propertyKey })));
      }
      if (script) {
        const pv = await poseViewModel(vm, rig, items.map((_, i) => (i ? 0 : 1)), []);
        nestedPv = pv;
        const itemBinds = await bind(pv.poses.id, items.map((it, i) => ({ objectId: it.id, propertyKey: 18, viewModelPropertyId: pv.ids[`p${i}`], path: pv.path })), artboardId);
        made.unshift(...itemBinds);
        binds.push(...itemBinds);
        await setLanguage(script.name, script.language);
        await writeScript(script.name, E.togglerScriptLuau(rig, items, pos, true));
        note = await reloadHint(script.name, script.language);
        Object.assign(manifest, { poseVmId: pv.poses.id, nestedPropId: pv.nestedPropId, script: script.name, scriptLanguage: script.language, made: script.made });
      } else {
        const convIds = await makeConverters(items.map((it, i) => ({ name: `poser ${rig} switch ${it.id}`, formula: E.switchFormula(vm.name, rig, items, i, pos) })));
        made.push(...convIds);
        manifest.converters = convIds;
        const itemBinds = await bind(vm.id, items.map((it, i) => ({ objectId: it.id, propertyKey: 18, viewModelPropertyId: ids[pos.x || pos.y], converterId: convIds[i] })), artboardId);
        made.unshift(...itemBinds);
        binds.push(...itemBinds);
      }
    } catch (e) {
      await deleteAll(made);
      if (script) await dropMadeScript(script);
      if (nestedPv) await leaveNested("toggler", rig, file, vm.id, artboardId, nestedPv);
      e.message += leftNote(rig);
      e.rolledBack = true;
      if (!host) await mcp("set_property_values", { propertyValues: { [joystickId]: Object.fromEntries([...axes].map(a => [AXIS[a].value, 0])) } }).catch(() => {});
      throw e;
    }
    manifest.binds = binds;
    await saveManifest(manifest);
    return { ...manifest, note };
  }

  // ------------------------------------------------------------ unbind

  async function unbind(m) {
    if (m.cleanup) return finishCleanup(m);
    if (m.kind === "joystick") {
      const reader = (await manifests()).find(t => t.kind === "toggler" && t.source === m.rig);
      if (reader) throw new Error(`The toggler "${reader.rig}" reads this rig's joystick. Unbind it first, on the Toggler tab.`);
    }
    const all = await manifests();
    const guests = (m.guests || []).filter(g => all.some(x => x.rig === g.rig));
    if (guests.length) throw new Error(`The NumInput rig "${guests[0].rig}" adds to properties this rig drives. Unbind it first.`);
    const timeline = m.keysRemoved ? await poseTimeline(m) : null;
    // a contributor's owners stop reading its shares before its view model goes
    for (const ownerRig of new Set((m.shares || []).map(x => x.owner))) {
      const owner = all.find(x => x.rig === ownerRig);
      if (!owner) continue;
      owner.guests = (owner.guests || []).filter(g => g.rig !== m.rig);
      try { await rewriteOwner(owner); } catch (e) { warn(`Couldn't update "${ownerRig}" (${String(e.message || e)}): bind it again to drop this rig's share.`); }
    }
    if (m.shares?.length) await new Promise(r => setTimeout(r, SETTLE_MS));
    const binds = m.binds || [];
    const vm0 = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === m.vmId);
    const rigProps = new Set((vm0?.viewModelProperties || []).filter(p => (m.addedProps || []).includes(p.name)).map(p => p.id));
    const rigConv = new Set([...(m.converters || []), ...(m.switches || []).map(s => s.converter)]);
    const mine = new Set();
    for (const d of await allBinds())
      if (rigProps.has(d.viewModelPropertyId) || rigConv.has(d.converterId) || (m.poseVmId && d.viewModelId === m.poseVmId)) mine.add(pair(d));
    for (const k of mine) unbound.add(k);
    await deleteAll(binds);   // after a crash some may be gone already
    if (m.keysRemoved) {
      const add = m.tracks.flatMap(t => t.keys.map(k => ({ objectId: t.objectId, propertyKey: t.propertyKey, ...k, interpolationType: k.interpolationType || "linear" })));
      for (const part of chunks(add, 400)) {
        await mcp("animation_editor", { command: "modifyKeyFrames", data: { modifyKeyFrames: { animationId: timeline.id, add: part } } });
      }
    }
    // converters go too; the editor's converter list can keep a stale entry until reload
    const extra = [...(m.converters || []), ...(m.switches || []).map(s => s.converter)];
    if (m.drive === "script") {
      // the placement goes too when Poser made it; the user's script stays, emptied, so it stops
      // looking for the removed view model (rigs from before kept a script Poser made: it goes)
      if (m.made?.placement) extra.push(m.made.placement);
      if (m.made?.script) { try { extra.push((await scriptAsset(m.script)).id); } catch {} }
      else { try { await writeScript(m.script, E.placeholderScript(m.rig, m.scriptLanguage)); } catch {} }
    }
    else if (m.kind === "joystick") extra.push(...Object.values(m.nodes), m.groupId, m.timelines.X, m.timelines.Y);
    // a connection's timeline and a toggler's own ones go too, which clears the joystick's axes.
    // A keyed one stays, and its joystick keeps its handle where it is, since that scrubs those keys.
    const axisTimelines = [...(m.connections || []).filter(c => c.timeline).map(c => ({ id: c.timeline, name: E.connectionTimeline(m.rig, c.slider) })),
      ...(m.kind === "toggler" ? Object.entries(m.timelines || {}).map(([axis, id]) => ({ id, name: `${m.rig} ${axis}` })) : [])];
    const keyed = await keyedTimelines(axisTimelines.map(t => t.id));
    extra.push(...axisTimelines.filter(t => !keyed.has(t.id)).map(t => t.id));
    // the handle goes back to the centre and the items to the opacity they had
    const rest = {};
    for (const c of m.connections || []) if (!keyed.has(c.timeline)) (rest[c.joystickId] ||= {})[AXIS[c.axis].value] = 0;
    if (m.kind === "toggler" && !m.source) for (const a of m.axes) if (!keyed.has(m.timelines?.[a.toUpperCase()])) (rest[m.joystickId] ||= {})[AXIS[a].value] = 0;
    for (const it of m.kind === "toggler" ? m.items : []) rest[it.id] = { 18: it.opacity };
    if (Object.keys(rest).length) await mcp("set_property_values", { propertyValues: rest }).catch(() => {});
    let leftovers = 0;
    for (const part of chunks(extra, 400)) {
      // one id that's already gone can fail a whole batch, so the rest are tried one by one
      try { await mcp("delete_objects", { objectIds: part }); }
      catch {
        for (const id of part) {
          try { await mcp("delete_objects", { objectIds: [id] }); } catch { leftovers++; }
        }
      }
    }
    // the view model numbers this rig added (deleting a property removes its instance values)
    const vm = ((await mcp("viewmodel_editor", { command: "listViewModels" })).viewModels || []).find(v => v.id === m.vmId);
    const propIds = (vm?.viewModelProperties || []).filter(p => (m.addedProps || []).includes(p.name)).map(p => p.id);
    if (propIds.length > 100) log(`Removing ${propIds.length} numbers from "${vm.name}"… a big rig can take a minute.`);
    if (propIds.length) await deleteAll(propIds);
    // A nested view model goes in a second Unbind, after a reload: deleting view-model data while
    // the editor still has stale copies from earlier deletes has crashed Rive 0.9.517. So everything
    // else is done and saved first, and a crash there costs nothing else.
    const legacy = !!(m.nestedPropId && !m.flat);
    if (legacy) await saveManifest({ kind: m.kind, rig: m.rig, file: m.file, version: 1, vmId: m.vmId, artboardId: m.artboardId, drive: m.drive,
      tracks: [], items: [], cleanup: { nestedPropId: m.nestedPropId, poseVmId: m.poseVmId } });
    else await dropManifest(m);
    // binds the editor still lists would be retargeted, not replaced, by the next bind there
    const left = (await allBinds()).filter(d => mine.has(pair(d))).length;
    return { binds: binds.length, restored: m.keysRemoved ? m.tracks.length : 0, leftovers, left, recreated: timeline?.recreated,
      keptTimelines: axisTimelines.filter(t => keyed.has(t.id)).map(t => t.name), cleanupPending: legacy };
  }

  // The second Unbind of a nested rig, after a reload: its nested view model alone. The selection is
  // cleared first, in case the inspector shows something bound through it, then the property and the
  // view model go in one delete.
  async function finishCleanup(m) {
    await mcp("select_objects", { objectIds: [] }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    const ids = [m.cleanup.nestedPropId, m.cleanup.poseVmId].filter(Boolean);
    const there = new Set(((await mcp("query_objects", { objectIds: ids, depth: 0 })).objects || []).map(o => o.id));
    const gone = ids.filter(id => there.has(id));
    if (gone.length) await mcp("delete_objects", { objectIds: gone });
    await dropManifest(m);
    return { binds: 0, restored: 0, leftovers: 0, left: 0, keptTimelines: [], cleaned: true };
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
    const path = (r.objects || []).find(o => o.id === sel[0].id);
    const kids = (path?.children || []).map(c => (typeof c === "string" ? c : c.id));
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

  return { fileKey, artboards, timelines, joysticks, selection, ensureScript, saveManifest, takeWarning, bindJoystick, bindJoystickScript, setEaseBias, bindSliders, numbers,
           bindJoystickToSlider, disconnectSlider, bindToggler, unbind, manifests, unreadableRecords, keyAll, unkeyFlat, pasteOrigin, pathFlip };
}
