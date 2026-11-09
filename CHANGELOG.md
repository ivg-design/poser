# Changelog

All notable changes to Poser, newest first.

## [3.5.1] — 2026-11-09

### Changed
- **One script is the default drive** on the Joystick, NumInput and Toggler tabs; formula converters
  are the fallback (for an AnimaScript file, or a file where a script can't be placed).

### Docs
- The README describes One script as the default drive and its nested `poser <rig>` view model, and
  covers a new rig script the editor leaves unloaded right after a reload (reload again, then bind).

## [3.5.0] — 2026-11-09

### Changed
- **Binds are fast again.** One-script rigs use a nested view model again: Rive created Look2's 1,074
  numbers in about 5–11 s that way, against 40–56 s on the artboard's view model (and about as long
  again to remove them). Poser 3.4 rigs (numbers on the artboard's view model) keep working.
- **Nested view models are only deleted after a reload.** Unbind of every nested rig takes two clicks
  with a reload between; a failed bind undoes everything but its nested view model and lists it as
  "view model left (Unbind after a reload)". A leftover `poser <rig>` view model with no record is
  refused before anything is made, instead of being deleted mid-bind.
- **Shares work with nested owners again**, including rigs bound before 3.4; a share is still a plain
  number on the artboard's view model.

## [3.4.1] — 2026-11-09

### Fixed
- **Reload before binding again.** The crashes come from the editor keeping stale copies of
  view-model data Poser deleted (Rive 0.9.517, `viewModelInstanceReferenceViewModel` touches a freed
  view model); the next change to view models can then crash Rive, even one that deletes nothing
  nested. After an Unbind, or a bind that had to undo itself, the panel asks for a reload (Cmd+R)
  and holds Bind, Connect, Disconnect and Unbind until you click **Reloaded**.
- **A joystick's handle is never posed.** Keys on a joystick (made by moving it while a timeline is
  open) were picked up as posed properties, so a rig tried to bind its own joystick and refused itself.
- **The Formula joystick drive undoes a failed bind.** It used to leave its numbers, factor nodes,
  timelines, converters (one per posed property) and binds behind.
- Slow steps (adding or removing hundreds of numbers) say so instead of looking frozen, and the
  panel's status lines go into `mcp.log` next to the requests.

## [3.4.0] — 2026-11-09

### Fixed
- **Unbind crashed Rive** (0.9.517, in `viewModelInstanceReferenceViewModel`) when it deleted a rig's
  nested view-model property, and the crash lost what the editor hadn't saved, including restored
  pose keys. It happened on some Unbinds and not others with the same requests; the editor's state at
  that moment, most likely the selection, decides it.
- **Rigs no longer make nested view models.** One-script Joystick, NumInput and Toggler rigs keep their
  numbers on the artboard's view model (`<rig>_x`, `<rig>_p0`, shares as `<rig>_to_<owner>_<n>`),
  starting at their rest values. Poser has always deleted plain numbers without trouble.
- **Rigs bound before 3.4 unbind in two steps.** The first Unbind does everything else and saves it;
  the second clears the selection and removes the nested view model alone, so a crash there costs
  nothing else. Such a rig can't be rebound under its name until both steps are done.
- **An owner finds a share's output by name.** An owner that is also a contributor elsewhere could add
  a share to the wrong property.
- **Unbind tolerates binds that are already gone** (after a crash).

## [3.3.0] — 2026-11-07

### Added
- **Double binds ask what to do.** When properties in the pose timeline are already bound by another
  rig, the Bind card offers **Share** (NumInput), **Skip them, bind the rest**, or **Cancel**.
- **Shared properties.** A One-script NumInput rig can share a property that another One-script
  NumInput rig already drives. That rig keeps the bind; the new rig publishes its share
  ((pose − origin) · input) as a number named after the owner and property (for example `Op2arm_17`),
  and the owner's script adds it. Shares need the same rest value on both rigs; a property whose rest
  value differs is skipped and counted. An owner can't be unbound while a rig shares into it; a
  sharing rig's Unbind rewrites the owner's script first.

### Changed
- **NumInput and Toggler scripts recalculate at most once a frame.** Listeners only mark the rig, the
  runtime calls `update` on the next frame, a share change recalculates the shared properties alone,
  and only changed values are written. The root view model is kept on the script, so its listeners
  can't be collected with it.

## [3.2.8] — 2026-11-07

### Fixed
- **Rive crashed on a refused One-script bind.** Binding properties another rig still binds (for
  example `op2breathe` over `Op2breathe`: rig names are case-sensitive) made the nested view model,
  pointed the artboard's view model at it, then found the binds, refused, and deleted the property
  and view model in one call. Rive 0.9.517 died right after that delete, in
  `viewModelInstanceReferenceViewModel`. Bound properties are now refused before anything is made,
  and the refusal names the view model they're bound to.
- **Nested view models are deleted in two steps** (rollback, Unbind and stale leftovers): the
  property that references them first, the view model a moment later.

## [3.2.7] — 2026-11-07

### Added
- **Request log:** every MCP request and its answer go to `mcp.log` in the app's log folder
  (`~/Library/Logs/design.ivg.poser` on macOS), so an editor crash can be traced to the last request.

## [3.2.6] — 2026-11-05

### Fixed
- **"Only the selection" with the script drive failed on the first click:** Poser made the rig script
  first, which opens it in the editor and drops the selection, then read the empty selection and
  refused with "no number keys for the selection". The selection is now read first.
- **A refused bind makes nothing:** a selection or timeline with no usable keys is refused before the
  script is created, so no blank script is left open.

## [3.2.5] — 2026-11-05

### Fixed
- **Unbind and Disconnect keep keyed joystick timelines:** a timeline Poser put on a joystick's axis
  used to be deleted even if it had keys on it. Now it stays, its joystick keeps its handle where it
  is, and the status line says so. If the check fails, the timeline stays too.

## [3.2.4] — 2026-11-05

### Fixed
- **Unbind restores custom curves:** a rig now records each pose key's cubic or elastic settings and
  puts them back. If the editor reports a curved key without its curve, Poser warns at bind. Rigs
  bound before this version have no record of their curves.
- **Empty rig records are reported:** a `poser <rig> dataBkp` script Poser can't read now shows a
  warning in the panel instead of being skipped silently.
- **Unbind cleanup:** one object that's already gone no longer stops the others in its batch from
  being removed.
- **Warnings no longer overwrite each other.**

## [3.2.3] — 2026-11-05

### Fixed
- **Unbind after deleting the pose timeline:** Unbind checks whether the original timeline exists.
  If it does, the keys go back there. If not, Poser makes it again with its name, fps, length, speed
  and loop, then restores the keys. Rigs bound before this version have no record of those settings,
  so theirs is called `<rig> poses`, at 60 fps and long enough for its keys.

## [3.2.2] — 2026-11-05

### Changed
- **Explanations fold behind a `?` button** at the end of the element they describe, one open at a
  time, so the panel stays short.

## [3.2.1] — 2026-11-05

### Changed
- **Connect picks a pose:** one dropdown of the poses that have no joystick yet, grouped by rig,
  replaces the rig and input fields.
- **Add pose:** poses start at one and grow with a button, with no four-pose default or upper limit.
  Poser says when the timeline has keys past the last pose you bound.
- **"Only the selection"** explains that it includes what's nested inside the selected objects.

### Fixed
- **"Only the selection" with nothing selected** is refused. It used to bind the whole timeline.

## [3.2.0] — 2026-11-05

### Added
- **NumInput drive:** choose formula converters or one script, as on the Joystick tab (Luau files).
- **NumInput inputs:** each pose makes a new number or reads one the artboard's view model already
  has. Unbind leaves the numbers you picked.
- **Disconnect:** undoes one joystick connection and leaves the rest of the NumInput rig.
- **Toggler is self-contained:** its own rig name, drive, joystick, control (both axes or a
  one-axis slider) and Unbind, with no Joystick rig needed first. It can still read a joystick that
  drives a formula Joystick rig. Unbind puts the items back at the opacity they had.

### Changed
- **Connect turns the joystick into a slider:** Poser puts an empty timeline (`<rig> <input>`) on
  the axis. Without negatives the whole travel now runs 0 to 100 and the handle rests at that end
  (the left half used to do nothing). The input's range comes from the rig, not the checkbox.
- **Input under Connect is a dropdown** of the rig's inputs instead of a pose index.
- **Each tab lists and unbinds only its own rigs**, and a rig name used on another tab is refused
  instead of unbinding that rig.
- The pose timeline list leaves out the timelines Poser made.

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
