# First-pass implementation notes

This archive is an edited source snapshot of `samuelnovaes/smart-tiling` based on current upstream `main` as inspected on July 8, 2026.

The environment used to prepare this archive could read the upstream source through GitHub's raw/web interface, but its local container could not resolve `github.com` for `git clone`. As a result, this is not a `.git` checkout and does not include upstream Git metadata or `package-lock.json`.

## Changes already attempted

- Removed all writes/resets of `org.gnome.desktop.wm.keybindings` and `org.gnome.mutter.keybindings`.
- Replaced duplicate extension accelerators with `Meta.keybindings_set_custom_handler()` overrides for Mutter's built-in:
  - `toggle-tiled-left`
  - `toggle-tiled-right`
  - `maximize`
  - `unmaximize`
- Restores Mutter's default handlers by setting the custom handler to `null` on disable.
- Removed TOP and BOTTOM half-screen states.
- Added Windows-style chained corner transitions.
- Uses native `maximize()`, `unmaximize()`, and `minimize()` for the non-side-snapped Up/Down behavior.
- Removed the 20 ms resize-until-classified loop.
- Added bounded geometry settlement based on `size-changed` / `position-changed` signals plus a hard timeout.
- Added one-pass edge/corner anchoring for clients that settle at constrained sizes.
- Added direct FLIP animation using `Meta.WindowActor` translation/scale properties and `actor.ease()`.
- Added explicit logical snap state plus last-settled geometry reconciliation.

## Validation performed here

- TypeScript transpilation with global TypeScript 5.8.3 using `--noCheck`.
- `node --check` on every generated JavaScript module.
- XML parse validation for the GSettings schema.
- Static checks that the old native GSettings mutation and 20 ms resize retry loop are absent.

## Not validated here

- Runtime loading in GNOME Shell 49 or 50.
- GJS introspection/runtime signatures in a real GNOME session.
- Real compositor behavior of direct FLIP actor transforms.
- Discord/Electron behavior under client minimum-size constraints.
- Interaction with other GNOME Shell extensions.

See `smart-tiling-codex-handoff.md` for the full rationale and acceptance criteria.
