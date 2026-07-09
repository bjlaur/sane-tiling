# Smart Tiling — experimental Windows-style snap fork

This is a first-pass rework of Samuel Novaes's Smart Tiling GNOME Shell extension.

The goal is Windows-style keyboard snapping without rewriting GNOME/Mutter keybinding settings:

- Left/right snap to halves.
- Left then Up/Down snaps to the left corners.
- Right then Up/Down snaps to the right corners.
- Up from a normal window maximizes.
- Down from maximized restores; Down from a normal window minimizes.
- Half/corner snaps use a FLIP-style `Meta.WindowActor.ease()` animation.
- Constrained windows get one resize request and at most one edge-anchor correction.

The extension overrides Mutter's built-in `toggle-tiled-left`, `toggle-tiled-right`, `maximize`, and `unmaximize` handlers. It does not change their configured accelerators or mutate GNOME/Mutter GSettings.

## Build

```bash
npm install
npm run build
```

The upstream build creates `smarttiling@samuelnovaes.zip`.

For the engineering rationale, known risks, and Codex review checklist, see `smart-tiling-codex-handoff.md`.
