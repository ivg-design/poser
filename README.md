# Poser

**Pose rigs for Rive.** A small always-on-top panel that sets up Joysticks 'n Sliders-style pose
controls in any open Rive file by talking to the editor's MCP server. It's deterministic: no agent, no
AI, and no script left running in your file.

Poser 3 replaces the Luau Poser script (2.x). The rig it builds is plain Rive: a joystick, two short
timelines, view-model numbers and one formula converter per posed property. It runs on every Rive
runtime, needs no script signing, and costs nothing while the joystick is still.

## How a rig works

You key poses on one timeline: the origin on frame 0, then one pose per frame. For each property
that changes, Poser bakes the poses into a formula converter and binds the property through it:

```
value = origin + (left − origin)·fL + (right − origin)·fR + (up − origin)·fU + (down − origin)·fD
```

- **Joystick.** The joystick scrubs two timelines, `poser <rig> X` and `poser <rig> Y`. They key four
  factor nodes, which push `<rig>_fL/_fR/_fU/_fD` (0 to 1) into the artboard's view model. X and Y
  add together, so a corner gets both poses in full, the way J&S does it. The joystick's raw
  position also lands in `<rig>_x/_y`.
- **Ease bias.** Each direction's curve is the keyframe curve on its factor timeline: −100 eases in,
  +100 eases out, 0 is linear. You can also shape the curves yourself in the graph editor.
- **NumInput.** One view-model number per pose (`<rig>_s1…sN`, 0 to 100), added together like blend
  shapes. Optionally a negative value gives the inverse pose.
- **Toggler.** Swap items get a spot on the joystick (−1 to 1). Only the item nearest the joystick
  stays visible (its opacity is bound to a formula).

Key the joystick on any timeline to animate a rig, or bind its x/y to drive it from data.

## Panel

| Tab | Does |
|---|---|
| Joystick | Bind the poses in a timeline (frames 0–4) to a joystick you added (J). Pick the drive (formula converters, or one AnimaScript) and the frame order: J&S's R, L, U, D or L, R, U, D. Optionally bind only the selection. Set the ease bias per direction. Unbind any rig in the file here: it removes what Poser created and puts the pose keys back. |
| NumInput | Bind N poses to number inputs (0–100), with optional inverse poses. Connect an input to a joystick axis so you can drag and key it on the canvas. |
| Toggler | Load the selected items, place each one on the joystick, and bind. |
| Tools | Key all, Paste origin, Unkey flat, and PathFlipper (mirror a path around its first vertex). |

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
- **Script drive:** Poser creates the `poser <rig>` Node script in the file's language: the file's
  script engine (the backboard's `scriptingVm`, key 472) decides, since a script in the other
  language never becomes a Node. In a file whose engine is wasm (AnimaScript) the editor can't make
  a Node script at all, so use the formula drive there. Don't push a project with `scripting: wasm`
  to a file that has Luau scripts: the editor can't switch the engine back (only another CLI push
  can). The MCP cannot place a script on an artboard, so
  Poser copies a placement that already exists in the file and points it at the script; a file
  with none needs the script dropped on the artboard once. A script can't set mesh vertices or
  opacity itself, so it writes a nested view model (`poser <rig>`: x, y, p0…pN) and each property
  is bound to its number.
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
- **Stale converter entries.** After Unbind, the editor's converter list can keep stale entries
  until the file is reloaded.
- **Cloud lag.** Edits made over MCP reach the cloud copy of the file a few minutes later, so
  `rive pull` sees them late.
