#!/usr/bin/env node
// Runs the panel's rig operations from a terminal against the open Rive editor
// (same rig.js, same MCP calls), sharing the app's rig manifests.
//   node tools/poser-cli.mjs list
//   node tools/poser-cli.mjs bind-joystick --timeline "Timeline 1" --order "L, R, U, D" --rig look --joystick look [--keep-keys] [--selected]
//   node tools/poser-cli.mjs ease --rig look --R 50 --L 50
//   node tools/poser-cli.mjs unbind --rig look
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRig } from "../ui/rig.js";
import { ORDERS } from "../ui/engine.js";

// the app keeps rig manifests in its data folder; the CLI shares it
const dataDir = process.platform === "win32"
  ? path.join(process.env.APPDATA || os.homedir(), "design.ivg.poser")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "design.ivg.poser")
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "design.ivg.poser");
const rigsDir = path.join(dataDir, "rigs");
fs.mkdirSync(rigsDir, { recursive: true });
const fileFor = name => path.join(rigsDir, `${name.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const store = {
  list: async () => fs.readdirSync(rigsDir).filter(f => f.endsWith(".json")).map(f => fs.readFileSync(path.join(rigsDir, f), "utf8")),
  save: async (name, json) => fs.writeFileSync(fileFor(name), json),
  remove: async name => fs.rmSync(fileFor(name), { force: true }),
};

const URL_ = "http://127.0.0.1:9791/mcp";
let sid = null, rpcId = 1;
async function post(body) {
  const r = await fetch(URL_, { method: "POST", body: JSON.stringify(body), headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) } });
  if (!sid) sid = r.headers.get("mcp-session-id");
  const text = await r.text();
  const data = text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).pop() ?? text;
  return data ? JSON.parse(data) : {};
}
async function mcp(tool, args) {
  if (!sid) {
    await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "poser-cli", version: "3.0.0" } } });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  }
  const rpc = await post({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: tool, arguments: args } });
  if (rpc.error) throw new Error(rpc.error.message || "MCP error");
  const inner = rpc.result?.structuredContent?.content ?? rpc.result?.content?.[0]?.text;
  let out = inner;
  if (typeof inner === "string") { try { out = JSON.parse(inner); } catch { out = inner; } }
  if (out && out.success === false) throw new Error(`${tool}: ${JSON.stringify(out.errors || out).slice(0, 300)}`);
  return out;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i < 0 ? dflt : argv[i + 1]; };
const flag = name => argv.includes(`--${name}`);
const rig = createRig(mcp, m => console.log("·", m), store);

const t0 = Date.now();
if (cmd === "list") {
  console.log(JSON.stringify((await rig.manifests()).map(m => ({ kind: m.kind, rig: m.rig, tracks: m.tracks.length, binds: (m.binds || []).length })), null, 1));
} else if (cmd === "bind-joystick") {
  const { list, active } = await rig.artboards();
  const ab = list.find(a => a.name === opt("artboard")) || list.find(a => a.id === active);
  const tl = (await rig.timelines()).find(a => a.name === opt("timeline", "Timeline 1"));
  const joy = (await rig.joysticks(ab.id)).find(j => j.name === opt("joystick", "look"));
  if (!tl || !joy) throw new Error("timeline or joystick not found");
  const m = await rig.bindJoystick({ artboardId: ab.id, artboardName: ab.name, timelineId: tl.id, order: ORDERS[opt("order", "L, R, U, D")],
    rig: opt("rig", "look"), joystickId: joy.id, removeKeys: !flag("keep-keys"), bias: {}, selectedOnly: flag("selected") });
  console.log(`bound ${m.tracks.length} properties, ${m.binds.length} binds, ${m.converters.length} converters`);
} else if (cmd === "ease") {
  const m = (await rig.manifests()).find(x => x.rig === opt("rig", "look"));
  await rig.setEaseBias(m, Object.fromEntries(["L", "R", "U", "D"].map(d => [d, +opt(d, 0)])));
  console.log("ease bias set");
} else if (cmd === "unbind") {
  const m = (await rig.manifests()).find(x => x.rig === opt("rig", "look"));
  console.log(await rig.unbind(m));
} else {
  console.log("commands: list | bind-joystick | ease | unbind");
}
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
