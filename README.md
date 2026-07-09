# Sane Tiling

Sane Tiling brings Windows-style keyboard snapping to GNOME while keeping GNOME's existing shortcuts in charge.

Use the normal GNOME snap and maximize bindings and Sane Tiling fills in the behavior many keyboard-heavy users expect:

- Snap left and right with GNOME's existing tile shortcuts.
- Chain from a half snap into corners with Up and Down.
- Maximize from a normal window with Up.
- Restore from maximized with Down.
- Minimize a normal window with Down.
- Restore the previous normal size with `<Super><Shift>Down`.
- Undo the last Sane Tiling window action with `<Super>z`.

The extension overrides GNOME Shell's built-in `toggle-tiled-left`, `toggle-tiled-right`, `maximize`, and `unmaximize` handlers at runtime. It does not rewrite GNOME's configured accelerators or mutate Mutter's keybinding settings.

## Behavior

Sane Tiling tracks each window's logical snap state so repeated keyboard actions can move naturally between halves, corners, maximized, restored, and minimized states. Half and corner transitions use compositor-side actor animation, while maximize, unmaximize, and minimize continue to use GNOME's native window operations.

Constrained windows, such as apps with minimum sizes, get one resize request and at most one edge-anchor correction. That keeps snapping predictable without a resize loop.

## Install From Source

```bash
npm install
make install
make enable
```

`make install` builds `sane-tiling@nullstring.io.zip` and installs it with `gnome-extensions install --force`.

## Development

```bash
npm run build
```

The build compiles TypeScript into `dist/`, copies extension resources, and packages the zip.

Useful Makefile targets:

- `make package` builds the zip.
- `make install` builds and installs the extension.
- `make enable` enables the installed extension.
- `make disable` disables it.
- `make clean` removes `dist/` and the packaged zip.
