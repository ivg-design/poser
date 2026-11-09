# Poser

**Pose rigs for Rive.** A small always-on-top panel that sets up Joysticks 'n Sliders-style pose
controls in any open Rive file by talking to the editor's MCP server. It's deterministic: no agent, no
AI, and no script left running in your file.

Poser 3 replaces the Luau Poser script (2.x). By default a rig is one small Node script per rig that
writes view-model numbers, with every posed property bound to its number; it only does work when the
control moves. The fallback drive is plain Rive with no script at all: a joystick, two short
timelines, view-model numbers and one formula converter per posed property, for files where a script
can't run or be placed.

## How a rig works

You key poses on one timeline: the origin on frame 0, then one pose per frame. For each property
that changes, Poser bakes the poses into the rig script (One script) or into a formula converter
(fallback), and binds the property to the result:

```
value = origin + (left − origin)·fL + (right − origin)·fR + (up − origin)·fU + (down − origin)·fD
```

- **Joystick.** With One script, the joystick's x and y land in the rig's view model and the script
  writes every property's value. With formula converters, the joystick scrubs two timelines, `poser <rig> X` and `poser <rig> Y`. They key four
  factor nodes, which push `<rig>_fL/_fR/_fU/_fD` (0 to 1) into the artboard's view model. X and Y
  add together, so a corner gets both poses in full, the way J&S does it. The joystick's raw
  position also lands in `<rig>_x/_y`.
- **Ease bias.** Each direction's curve is the keyframe curve on its factor timeline: −100 eases in,
  +100 eases out, 0 is linear. You can also shape the curves yourself in the graph editor.
- **NumInput.** One view-model number per pose, 0 to 100, added together like blend shapes. Each
  pose makes a new number (`<rig>_s1…sN`) or reads one the view model already has. Optionally a
  negative value gives the inverse pose.
- **Toggler.** Swap items get a spot on a control (−1 to 1), which is a joystick or a one-axis
  slider. Only the item nearest the control stays visible.

**Rig numbers and Unbind.** A One-script rig keeps its numbers in a nested view model,
`poser <rig>`, which Rive creates quickly. Deleting view-model data while the editor still holds
stale copies from earlier deletes has crashed Rive 0.9.517, so Poser never deletes one in the
session that changed it: Unbind takes two clicks, with a reload (Cmd+R) between, and after any
Unbind the panel holds binding until you reload and click **Reloaded**. A bind that fails undoes
everything except its nested view model, which waits for the same second Unbind. Rigs bound with
Poser 3.4 keep their numbers on the artboard's view model (`<rig>_p0`…) and still work. Shares are
plain numbers on the artboard's view model, `<rig>_to_<owner>_<n>`.

**Shared properties.** A property can only have one bind, so two rigs can't both bind it. When a
bind meets properties another rig already binds, Poser asks: skip them and bind the rest, or, when
both are One-script NumInput rigs that rest at the same value, share them. The first rig keeps the
bind and its script adds the new rig's share, so the property follows both inputs.

A **rig name** is your label for one bind. It prefixes what Poser creates and names the rig under
Unbind. It isn't a view model, artboard or timeline. Names are unique across the three kinds of rig.

Key the joystick on any timeline to animate a rig, or bind its x/y to drive it from data.

## Panel

| Tab | Does |
|---|---|
| Joystick | Bind the poses in a timeline (frames 0–4) to a joystick you added (J). Pick the drive (one script, the default, or formula converters as a fallback) and the frame order: J&S's R, L, U, D or L, R, U, D. Optionally bind only the selection. Set the ease bias per direction. Unbind any rig in the file here: it removes what Poser created and puts the pose keys back. |
| NumInput | Add as many poses as the timeline holds and bind them to number inputs (0–100), new or existing, with formula converters or one script and optional inverse poses. Connect a pose to a joystick axis so you can drag and key it on the canvas: Poser puts an empty timeline (`<rig> <input>`) on that axis, which turns the joystick into a slider. Disconnect or Unbind on the same tab. |
| Toggler | Pick the drive and a joystick, choose both axes or a one-axis slider, load the selected items, place them and bind. A free joystick becomes the rig's own control. A joystick that already drives a formula Joystick rig is read as it is. Unbind on the same tab puts the items back at the opacity they had. |
| Tools | Key all, Paste origin, Unkey flat, and PathFlipper (mirror a path around its first vertex). |

Every request Poser sends to the editor, and the answer, is logged to `mcp.log` in the app's log
folder (`~/Library/Logs/design.ivg.poser` on macOS), which moves to `mcp.old.log` past 5 MB. If the
editor crashes, the end of that log shows what Poser asked for last.

Each bind writes a manifest of what it created, as JSON in the app data folder
(`~/Library/Application Support/design.ivg.poser/rigs` on macOS). Unbind uses that manifest.

## Install / build

```sh
cd src-tauri
cargo run              # dev
cargo build --release  # local binary
```

`npm test` runs the engine tests (`node --test`).

## Command line

`tools/poser-cli.mjs` runs the same operations against the open editor and shares the app's
manifests:

```sh
node tools/poser-cli.mjs bind-joystick --timeline "Timeline 1" --order "L, R, U, D" --rig look --joystick look
node tools/poser-cli.mjs ease --rig look --R 40 --L 40
node tools/poser-cli.mjs unbind --rig look
node tools/poser-cli.mjs list
```

## Requirements and limits

- **The Rive editor**, running with the file open. Its MCP server is at `127.0.0.1:9791`.
- **Joysticks:** the MCP cannot create one, so add it yourself (J) and pick it in the panel.
- **Keyed joystick timelines:** the timeline Poser puts on a joystick's axis starts empty. If it has
  keys by Unbind or Disconnect, it stays and the joystick stays a slider until you delete it.
- **Empty pose timelines:** "Remove the pose keys" can leave the pose timeline empty, and you can
  delete it. Unbind makes it again with its name and settings and puts the keys back. If another
  timeline has taken the name, the new one is called `<name> restored`.
- **Script drive:** Poser creates the `poser <rig>` Node script in the file's language: the file's
  script engine (the backboard's `scriptingVm`, key 472) decides, since a script in the other
  language never becomes a Node. In a file whose engine is wasm (AnimaScript) the editor can't make
  a Node script at all, so use the formula drive there. NumInput and Toggler scripts are Luau only. Don't push a project with `scripting: wasm`
  to a file that has Luau scripts: the editor can't switch the engine back (only another CLI push
  can). The MCP cannot place a script on an artboard, so
  Poser copies a placement that already exists in the file and points it at the script; a file
  with none needs the script dropped on the artboard once. A script can't set mesh vertices or
  opacity itself, so it writes numbers in its nested view model `poser <rig>` (`x`, `y`, `p0…`) and
  each property is bound to its number.
- **A new script the editor hasn't loaded.** Right after a reload, the editor can leave a script
  Poser just created unloaded, so it never compiles as a Node and the bind stops with "The editor
  didn't make "poser <rig>" a Node script." Nothing else has been made by then. Reload (Cmd+R) and
  bind again: Poser reuses the script, which is a Node after that reload.
- **Records in the file:** each rig's record (what Poser made, and the pose keys it moved) also
  lives in the Rive file, as one long comment in a script named `poser <rig> dataBkp`, written in
  the file's script language (AnimaScript or Luau), so it compiles clean and runs no code. Poser
  creates it and writes it through the script's code file, so it works before the editor has
  loaded the new script.
- **Bound properties can't take keys.** A bind overrides keyframes, so animate the joystick or a
  parent group instead. Anything else that keys a bound property each frame (an old blend state, a
  playing pose timeline) wins over the bind, so remove it.
- **Numbers only.** Transforms, opacity, vertices, bones and path points are covered. Colours are
  not, because formula converters work on numbers.
- **Leftover binds after Unbind.** An editor session can keep listing binds that Unbind deleted
  until the file is reloaded (seen after a long session; a freshly loaded file drops them at once),
  and a new bind on one of those properties would only retarget the leftover. Unbind checks for
  them and asks for a reload (Cmd+R) when there are any; Poser refuses a still-bound property and
  says why. The editor's converter list can also keep stale entries until a reload.
- **Cloud lag.** Edits made over MCP reach the cloud copy of the file a few minutes later, so
  `rive pull` sees them late.

## License

MIT. See [LICENSE](LICENSE).
