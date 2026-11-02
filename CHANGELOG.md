# Changelog

All notable changes to Poser, newest first.

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
