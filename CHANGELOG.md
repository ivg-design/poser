# Changelog

All notable changes to Poser, newest first.

## [3.1.0] — 2026-11-03

### Added
- **Script drive** for joystick rigs (Drive → One script), in AnimaScript or Luau. One generated
  script eases the joystick position and writes every posed value into a nested view model
  (`poser <rig>`); each property is bound to its number, with no converters, factor nodes or
  factor timelines. Poser creates the Node script `poser <rig>` and places it by copying an
  existing placement; a file with no placed script yet needs it dragged onto the artboard once.
  The script's language is the file's: Luau, or AnimaScript in a file whose engine is wasm (where
  the editor can't make a Node script, so the script drive is refused there). A script that is
  already placed is kept. Ease bias rewrites the script and fixes its language; Unbind removes a
  script Poser made and empties one you added.
- **Records in the file:** a script named `poser <rig> dataBkp` holds the rig's record (what Poser
  made, and the pose keys it moved) in one long comment, in the file's script language, so it
  travels with the file. It compiles clean and runs no code. Poser creates it, updates it on every
  change, and deletes it on Unbind.
- The app icon and the header glyph.

### Changed
- The Sliders tab is now **NumInput** and the Switch tab is now **Toggler**. Existing rigs keep working.
- The window fits what it shows: its height follows the open tab, and nothing scrolls.
- Unbind moved to the Joystick tab, under the ease bias.
- The panel watches Rive the whole time. It waits for the editor at launch, notices when Rive quits
  or another file opens, and reconnects by itself. Its messages say what is wrong in plain words
  ("Rive isn't running…") instead of the raw connection error.

### Fixed
- PathFlipper finds the selected path when the editor lists its vertices before the path itself.
- Toggler spots with a negative position bind again: the formula adds the offset instead of
  writing a minus followed by a negative number, which Rive's formula parser rejects.
- A rig's record in the file no longer overrides a newer copy in Poser: each record carries its save
  time and the newer one wins, so an in-file write that failed can't bring back an older record.
- Reusing a joystick or a posed object after Unbind no longer fails with "Bound 6 properties but
  found 5 bind objects". An editor session can keep listing a bind deleted over MCP until the file
  is reloaded, and a new bind on that property retargets the leftover (keeping its converter and
  direction) instead of adding one. Poser now checks for binds before it creates anything, refuses
  a property that is still bound and says why (a leftover from a removed rig: reload the file; a
  live bind: remove it). Unbind checks for leftovers and asks for a reload only when there are
  some. A joystick axis drives one rig at a time: another rig or a NumInput connection on the
  same axis is refused.
- The panel connects again: the bridge keeps the MCP session id.
- Binding a timeline that is already rigged explains why instead of reporting no changes. The
  same rig name rebinds it (unbind first, then bind); another name is refused.

## [3.0.0] — 2026-11-02

Poser becomes a Tauri panel that builds script-free pose rigs through the Rive editor's MCP server,
with Joysticks 'n Sliders parity. It replaces the Luau Poser script (2.x).

### Added
- **Joystick rigs:** origin plus four extremes (frames 0–4), in J&S order (R, L, U, D) or L, R, U, D.
  Each changing property is bound through a formula converter. The joystick scrubs two factor
  timelines, and corners add both poses in full.
- **Ease bias** per direction, from −100 (ease in) to +100 (ease out), as factor keyframe curves.
- **Sliders:** N poses as 0–100 view-model numbers added together like blend shapes, with optional
  inverse poses. A slider can also be driven from a joystick axis.
- **Switch:** nearest-item visibility for swap sets (mouths, noses…), placed on the joystick.
- **Tools:** Key all, Paste origin, Unkey flat, PathFlipper.
- **Unbind:** removes the binds, converters, factor nodes, timelines and view-model numbers it
  created, then restores the pose keys from the manifest.
- **Records:** one manifest per rig in the app data folder, shared with `tools/poser-cli.mjs`.
- **Engine tests:** `npm test`.
