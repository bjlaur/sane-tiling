# FIRST-PASS IMPLEMENTATION UPDATE — READ THIS BEFORE THE ORIGINAL PLAN

A first-pass implementation now accompanies this handoff. The code has already made the main architectural changes described below.

Most importantly, the earlier clone-heavy `SnapAnimator` recommendation is superseded. The current first pass deliberately tries a direct FLIP transform on the real `Meta.WindowActor` first:

1. Capture the current visual rectangle.
2. Perform one real `move_resize_frame()` request.
3. Wait for `Meta.Window::size-changed` / `position-changed` to go quiet, with a hard timeout.
4. Treat the actual settled `get_frame_rect()` as authoritative.
5. Perform at most one `move_frame()` correction to anchor a constrained client to the requested edge/corner.
6. Invert the actor using `translation_x`, `translation_y`, `scale_x`, and `scale_y`.
7. Call `actor.ease()` back to identity over 250 ms with `EASE_OUT_QUAD`.

Only introduce a clone/freeze path if real testing proves direct actor scaling visibly bad for Discord/Electron or causes compositor artifacts. Do not add clone machinery merely because the original handoff suggested it.

The first pass also takes a better keybinding approach than the original plan: it overrides Mutter's built-in `toggle-tiled-left`, `toggle-tiled-right`, `maximize`, and `unmaximize` handlers using `Meta.keybindings_set_custom_handler()`. On disable it passes a null handler to restore Mutter's default handler. This avoids both duplicate `Super+Arrow` accelerators and any GSettings mutation.

Primary review targets for Codex are now:

- Runtime correctness on GNOME 49/50, especially GJS introspection signatures.
- Whether direct FLIP actor transforms compose safely with GNOME Shell's own compositor effects.
- Rapid chained keypress cancellation/retargeting.
- Discord/Electron minimum-size behavior and the one-pass edge anchoring.
- Whether manual drag/resize state reconciliation needs stronger signal-based invalidation.
- TypeScript/lint cleanup after verifying the GNOME API usage on a real shell.

Everything below remains useful for rationale and acceptance criteria, except where this implementation update explicitly supersedes the earlier animation/keybinding architecture.

---

# Smart Tiling GNOME Extension — Codex Engineering Handoff

## Goal

Fork and rework Samuel Novaes's `smart-tiling` GNOME Shell extension so keyboard snapping behaves like Windows while retaining GNOME-native-feeling animations and avoiding interference with unrelated keybindings.

Upstream repository:

https://github.com/samuelnovaes/smart-tiling

Source reviewed: current `main` as visible on July 8, 2026. The latest commit visible on `main` is `d8e6359` from March 14, 2026.

The repository is GPL-2.0-or-later, so preserve the GPL license/copyright notices and keep derivative distribution GPL-compatible.

## Executive recommendation: fork, do not start completely from scratch

Do **not** throw the repository away.

Fork it and perform a targeted core rewrite.

Useful pieces worth keeping:

- TypeScript/GNOME Shell extension scaffolding.
- Build/package setup.
- GSettings schema and gap-size preference.
- Per-monitor work-area calculation.
- The basic `Keybindings` helper concept.
- The idea of a transition table driven by the window's current snap state.

Core pieces that should be replaced or substantially rewritten:

- `src/extension.ts`
- `src/tileManager.ts`
- `src/tile.ts`

Add:

- `src/snapAnimator.ts` or equivalent.

The current codebase is small enough that a core rewrite is cleaner than trying to layer fixes over its present movement logic, but there is no benefit in recreating the extension packaging/build/settings infrastructure.

I would develop this as a fork first rather than trying to make the initial work an upstream PR. Some desired behavior is intentionally different from Smart Tiling's current behavior, especially removal of top-half/bottom-half snap states. Independent fixes can later be split into upstreamable PRs if desired.

---

# Current source findings

## 1. The extension mutates GNOME's global native keybindings

`src/extension.ts` currently does this in `enable()`:

```ts
this.gnomeKeybindingsSettings.set_strv('maximize', ['<Ctrl><Super>Up']);
this.gnomeKeybindingsSettings.set_strv('unmaximize', ['<Ctrl><Super>Down']);

this.mutterKeybindingsSettings.set_strv('toggle-tiled-left', ['<Ctrl><Super>Left']);
this.mutterKeybindingsSettings.set_strv('toggle-tiled-right', ['<Ctrl><Super>Right']);
```

Then `disable()` does this:

```ts
this.gnomeKeybindingsSettings?.reset('maximize');
this.gnomeKeybindingsSettings?.reset('unmaximize');

this.mutterKeybindingsSettings?.reset('toggle-tiled-left');
this.mutterKeybindingsSettings?.reset('toggle-tiled-right');
```

This is architecturally wrong for this extension.

Problems:

1. Enabling the extension modifies global GNOME/Mutter settings outside the extension's own schema.
2. Disabling the extension does **not** restore the user's previous values.
3. `reset()` restores the schema default, potentially destroying custom user configuration.
4. The extension can cause surprising interactions with other window-management and workspace keybindings.

Important correction from the initial investigation:

Current `main` does **not** directly bind `Ctrl+Shift+Left` or `Ctrl+Shift+Right`. It moves native GNOME tile actions to `Ctrl+Super+Arrow`, while the extension uses `Super+Arrow`.

Therefore, the exact reason `Ctrl+Shift+Left/Right` is currently failing is **not proven yet**.

Do not invent a direct accelerator collision that is not present in the code.

However, the extension's global keybinding mutation is proven and should be removed before further shortcut debugging.

### Required fix

Delete all reads/writes to:

```text
org.gnome.desktop.wm.keybindings
org.gnome.mutter.keybindings
```

from the extension.

The extension must register and unregister only its own extension-owned keybindings.

On disable, remove only its own keybindings.

Never call `reset()` on GNOME/Mutter keybinding settings.

### Regression diagnostic

Before and after extension enable/disable, capture:

```bash
gsettings get org.gnome.desktop.wm.keybindings move-to-workspace-left
gsettings get org.gnome.desktop.wm.keybindings move-to-workspace-right
gsettings get org.gnome.desktop.wm.keybindings maximize
gsettings get org.gnome.desktop.wm.keybindings unmaximize
gsettings get org.gnome.mutter.keybindings toggle-tiled-left
gsettings get org.gnome.mutter.keybindings toggle-tiled-right
```

The values must be unchanged by this extension.

Also log the exact extension accelerators registered at enable time.

Reproduce `Ctrl+Shift+Left` and `Ctrl+Shift+Right` after removing the global-setting mutation. If the problem remains, diagnose the actual GSettings binding and GNOME keybinding dispatch rather than guessing.

---

## 2. The current movement state machine is not the desired Windows behavior

`src/tileManager.ts` currently supports these positions:

- CENTER
- TOP
- BOTTOM
- LEFT
- RIGHT
- TOP_LEFT
- TOP_RIGHT
- BOTTOM_LEFT
- BOTTOM_RIGHT
- MAXIMIZED

The `TOP` and `BOTTOM` half-screen states are not desired.

Current behavior includes:

```text
CENTER + Up   -> TOP
TOP + Up      -> MAXIMIZED

CENTER + Down -> BOTTOM
MAXIMIZED + Down -> TOP
```

This is why the extension does not feel like Windows.

## Required user-facing states

Use:

```text
RESTORED
MAXIMIZED
LEFT
RIGHT
TOP_LEFT
TOP_RIGHT
BOTTOM_LEFT
BOTTOM_RIGHT
```

There should be no user-facing `TOP` or `BOTTOM` half-screen snap state.

A separate `UNKNOWN`/`EXTERNAL` internal state is fine when a manually positioned window does not match a known snap state.

## Required keyboard behavior

The desired interpretation is Windows-style behavior:

### Super+Left

```text
RESTORED      -> LEFT
MAXIMIZED     -> LEFT
LEFT          -> LEFT
RIGHT         -> LEFT
TOP_LEFT      -> LEFT
BOTTOM_LEFT   -> LEFT
TOP_RIGHT     -> LEFT
BOTTOM_RIGHT  -> LEFT
```

For the initial implementation, simple deterministic snapping is preferred over reproducing every obscure Windows multi-monitor/cycling rule.

### Super+Right

Symmetric with `Super+Left`:

```text
anything -> RIGHT
```

except where a later Windows-exact multi-monitor cycling implementation intentionally changes this.

### Super+Up

```text
LEFT         -> TOP_LEFT
RIGHT        -> TOP_RIGHT
BOTTOM_LEFT  -> LEFT
BOTTOM_RIGHT -> RIGHT

RESTORED     -> MAXIMIZED
MAXIMIZED    -> MAXIMIZED
TOP_LEFT     -> TOP_LEFT
TOP_RIGHT    -> TOP_RIGHT
```

The important sequence is:

```text
hold Super
press Left
press Up
release Super
```

Result:

```text
TOP_LEFT
```

Likewise:

```text
Super+Right, then Up -> TOP_RIGHT
```

This does **not** require a simultaneous `Super+Up+Left` three-key accelerator.

The existing four discrete `Super+Arrow` bindings are sufficient. Each keypress can inspect the current explicit snap state and transition accordingly.

### Super+Down

```text
LEFT        -> BOTTOM_LEFT
RIGHT       -> BOTTOM_RIGHT
TOP_LEFT    -> LEFT
TOP_RIGHT   -> RIGHT

MAXIMIZED   -> RESTORED
RESTORED    -> MINIMIZED
BOTTOM_LEFT -> BOTTOM_LEFT
BOTTOM_RIGHT-> BOTTOM_RIGHT
```

This gives the expected Windows-like sequence:

```text
Super+Down from maximized -> restore
Super+Down again          -> minimize
```

### Assumption being made

The user's earlier explicit requirement was:

```text
Super+Up should maximize.
Super+Down should restore without accidentally snapping left/right.
```

The later phrase "Win+Up and Win+Down to minimize" appears inconsistent with that earlier requirement.

Implement the Windows-like interpretation above:

```text
Up = maximize unless a side snap makes Up a corner transition.
Down = restore/minimize unless a side snap makes Down a corner transition.
```

---

# 3. The instant snap is caused by the movement path

`src/tile.ts` directly calls:

```ts
this.window.move_resize_frame(...)
```

for every half and corner position.

That performs the actual window geometry request directly.

The extension does not use GNOME Shell's native size-change animation pipeline for these arbitrary snap rectangles, which strongly explains the observed instant jump.

GNOME Shell's current `js/ui/windowManager.js` has compositor-side window size-change animation machinery. It uses a 250 ms window animation duration and `Clutter.AnimationMode.EASE_OUT_QUAD` in related window/tile visual transitions.

The important distinction is:

**Do not animate window geometry by repeatedly resizing the real client window every frame.**

The user specifically does not want a hand-stepped transition.

Use a compositor visual animation.

## Recommended architecture: `SnapAnimator`

Add an isolated module such as:

```text
src/snapAnimator.ts
```

Its job is to visually animate the window from the old frame rectangle to the actual settled new frame rectangle.

### Recommended visual strategy

Mirror the broad strategy GNOME Shell uses for size-change effects:

1. Record the old frame rectangle.
2. Get the window actor / compositor actor.
3. Capture or clone the old visual content.
4. Freeze or visually isolate the real actor as necessary.
5. Perform the real `move_resize_frame()` once.
6. Wait for Mutter/client geometry to settle.
7. Read the **actual** new `get_frame_rect()`.
8. Animate compositor actors from the old visual geometry to the new visual geometry using Clutter `ease()`.
9. Use approximately GNOME Shell's native timing:
   - 250 ms
   - `Clutter.AnimationMode.EASE_OUT_QUAD`
10. Clean up the clone and restore the real actor.
11. Handle cancellation safely.

This is one compositor animation.

It is **not**:

```text
resize
sleep 20 ms
resize again
sleep 20 ms
resize again
...
```

### Native maximize/minimize should stay native

For:

```text
Super+Up -> maximize
Super+Down from restored -> minimize
```

prefer:

```ts
window.maximize(Meta.MaximizeFlags.BOTH)
window.minimize()
```

and the corresponding native unmaximize path.

Let GNOME Shell/Mutter handle native maximize/minimize animations.

Use `SnapAnimator` only for arbitrary half and quarter rectangles that do not have an appropriate public `Meta.Window` tiling API.

The current public `Meta.Window` GI API exposes operations such as:

```text
maximize
unmaximize
minimize
move_frame
move_resize_frame
get_tile_match
```

but it does not expose a general public `tile(rect)` API for extensions.

Do not depend on Mutter-private internal tiling functions unless there is a very strong reason and a GNOME-version compatibility plan.

### Rapid keypress behavior

This matters for:

```text
Super+Left
then Up immediately
```

A second arrow press may arrive while the first visual animation is still running.

Required behavior:

- Never queue multiple stale 250 ms animations.
- Cancel or supersede the old visual animation.
- Retarget to the newest requested snap state.
- Do not leave a clone, frozen actor, transform, opacity change, or signal handler behind.
- The final geometry/state must match the most recent arrow input.

It is acceptable for the first version to cancel the current visual effect and start a fresh effect from the current visual/actual position.

Correct cleanup is more important than mathematically perfect mid-animation interpolation.

### Reduced motion

Respect GNOME's current animation/reduced-motion settings using the normal Shell/Clutter facilities available for GNOME 49/50.

When animations are disabled/reduced, perform the geometry operation without the custom transition.

Do not hard-force animation for users who disabled system animations.

---

# 4. The current 20 ms retry loop is a likely source of Discord/Electron jank

Current `Tile.move()` behavior:

```ts
if (this.window.get_maximize_flags() > 0) {
    this.window.unmaximize();

    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        this.doMove(position);

        if (this.getPosition() === position) {
            ...
            return GLib.SOURCE_REMOVE;
        }

        return GLib.SOURCE_CONTINUE;
    });
}
```

This repeatedly calls `move_resize_frame()` every 20 ms until geometry classification says the requested position has been reached.

Delete this logic.

It is fragile for asynchronous Wayland window configuration and for applications with client-imposed minimum sizes.

Mutter exposes `Meta.Window.get_min_size()` specifically because a client can impose a minimum window size.

`move_resize_frame()` is a requested geometry operation. The actual settled frame may be constrained.

That creates a likely failure mode:

1. Extension asks for an exact half/quarter rectangle.
2. Discord/Electron cannot or does not settle at exactly that geometry.
3. `getPosition()` does not classify the actual rectangle as the requested state.
4. The timeout requests the same resize again 20 ms later.
5. Repeated configure/resize activity creates visible jank.

This is a source-based hypothesis, not a proven Discord-specific diagnosis yet.

Instrument Discord to confirm it.

## Required movement model

### One requested resize

For a snap:

```text
calculate target rectangle
request geometry once
wait for actual geometry
read actual frame rectangle
perform at most one bounded correction for anchoring
finish
```

No indefinite timeout.

No "retry until `getPosition() === requestedPosition`".

### Query constraints first

Before snapping, inspect:

```ts
window.allows_move()
window.allows_resize()
window.get_min_size()
window.get_window_type()
```

Do not attempt arbitrary geometry on windows that cannot be moved/resized or are not appropriate normal application windows.

### Treat actual geometry as authoritative

After a resize request, the window's actual geometry may differ from the requested geometry.

Read:

```ts
window.get_frame_rect()
```

after the size change settles.

The actual rectangle is authoritative for rendering/animation.

The **requested snap state** is authoritative for keyboard transition logic unless an external/manual action invalidates it.

---

# 5. Stop inferring all state only from screen-edge geometry

Current `Tile.getPosition()` classifies a state by checking whether the window touches work-area edges.

Example:

```ts
const top = bounds.y <= this.screen.y;
const bottom = (bounds.y + bounds.height) >= (this.screen.y + this.screen.height);
const left = bounds.x <= this.screen.x;
const right = (bounds.x + bounds.width) >= (this.screen.x + this.screen.width);
```

Then combinations of those booleans determine LEFT, RIGHT, TOP_LEFT, etc.

This is convenient but too fragile as the sole source of truth.

## Required design

Maintain explicit per-window snap state.

For example:

```ts
enum SnapState {
    RESTORED,
    MAXIMIZED,
    LEFT,
    RIGHT,
    TOP_LEFT,
    TOP_RIGHT,
    BOTTOM_LEFT,
    BOTTOM_RIGHT,
    UNKNOWN,
}
```

Each tracked window should have:

```ts
requestedSnapState
restoreRect
lastKnownFrameRect
possibly pendingSnapOperation
```

A `Map` keyed by `window.get_id()` is acceptable if cleanup on `unmanaged` remains correct.

### Transition logic uses explicit state

When the extension itself snaps:

```text
LEFT
```

store `LEFT` immediately as the requested logical state.

Then:

```text
Super+Up
```

transitions:

```text
LEFT -> TOP_LEFT
```

even if an application minimum width means its actual frame extends a few pixels farther than the ideal left-half rectangle.

### Reconcile external changes

Explicit state must be invalidated or reconciled when:

- the user manually drags the window,
- the user manually resizes the window,
- another extension changes geometry,
- the monitor changes,
- the work area changes significantly,
- the window is maximized/unmaximized outside this extension.

Do not necessarily mark state unknown for the geometry change caused by the extension's own pending snap operation.

A simple operation-generation/token mechanism can distinguish internal expected changes from external changes.

---

# 6. Discord / minimum-size anchoring policy

A constrained window may be wider or taller than the desired slot.

Example:

```text
desired RIGHT slot width = 800
client minimum width = 940
```

Do not fight the client.

Use a deterministic anchoring policy.

## Recommended policy

Request the desired target.

After the first actual geometry settlement:

- LEFT states: anchor actual window to work-area left.
- RIGHT states: anchor actual window to work-area right.
- TOP states: anchor actual window to work-area top.
- BOTTOM states: anchor actual window to work-area bottom.

For example, if a right-snapped client settles wider than requested:

```ts
correctedX = workArea.x + workArea.width - actualRect.width;
```

For bottom anchoring:

```ts
correctedY = workArea.y + workArea.height - actualRect.height;
```

Perform **at most one** corrective move after observing actual settled dimensions.

Do not repeatedly request a smaller size that the client will never accept.

This should produce the user's desired "try your best" behavior for Discord:

```text
put it on the requested side/corner
respect its minimum size
allow it to be larger than the ideal tile
do not do nothing
do not resize-loop forever
```

## Discord instrumentation

Temporarily log:

```text
window.get_title()
window.get_wm_class()
window.get_client_type()
window.get_window_type()
window.get_maximize_flags()
window.allows_move()
window.allows_resize()
window.get_min_size()
requested target rect
actual frame rect after size change
corrected anchor rect, if any
number of correction passes
```

Compare Discord with:

- GNOME Terminal / Ptyxis or another GTK app.
- Chrome/Chromium.
- A normal resizable GNOME application.

The key question is whether Discord's actual settled geometry differs from the requested snap geometry and whether the current 20 ms loop repeatedly reissues the resize.

Remove debug logging or gate it behind a debug setting before release.

---

# 7. Suggested file-by-file changes

## `src/extension.ts` — rewrite

Remove:

```ts
private gnomeKeybindingsSettings
private mutterKeybindingsSettings
```

Remove all calls to:

```ts
getSettings('org.gnome.desktop.wm.keybindings')
getSettings('org.gnome.mutter.keybindings')
set_strv(...)
reset(...)
```

The extension should:

1. Load its own settings.
2. Create the snap manager.
3. Register its own four `Super+Arrow` bindings.
4. On disable, remove its own bindings.
5. Destroy manager/animator resources.

Nothing else.

## `src/keybindings.ts` — keep concept, review implementation

The current helper's concept is fine:

```text
add extension binding
remember binding name
remove extension binding on destroy
```

Review it for GNOME 49/50 best practices, but do not broaden it into native GSettings mutation.

The four extension bindings remain:

```text
move-window-left
move-window-right
move-window-up
move-window-down
```

Default accelerators remain:

```text
<Super>Left
<Super>Right
<Super>Up
<Super>Down
```

It is desirable to expose configurable accelerators in preferences later, but this is not required for the first functional fix.

## `src/tileManager.ts` — rewrite state machine

Replace the current `TOP`/`BOTTOM` transition table with the required state machine in this document.

Responsibilities:

- Get focused window.
- Get/create per-window snap controller/state.
- Dispatch Left/Right/Up/Down.
- Use native maximize/minimize/unmaximize operations where appropriate.
- Dispatch arbitrary snap targets to the geometry/animation layer.

Do not put animation implementation in this class.

## `src/tile.ts` — substantial rewrite

The current class combines:

- position detection,
- geometry calculation,
- resize execution,
- retry scheduling,
- signal management.

Replace the retry-based design.

Possible responsibilities after rewrite:

- Hold per-window state.
- Track restore rectangle.
- Calculate target rectangles.
- Request a snap operation.
- Observe one geometry settlement.
- Perform zero or one anchor correction.
- Notify animator of old/actual-new geometry.
- Reconcile external geometry changes.
- Clean up signals on `unmanaged`.

Delete:

```text
GLib timeout every 20 ms
retry until getPosition() matches
```

Rename this class if `Tile` is no longer a good description. `SnapWindow` or `WindowSnapState` would be clearer.

## `src/snapAnimator.ts` — new

Responsibilities:

- Begin visual transition.
- Capture old actor visual/geometry.
- Perform/coordinate real geometry mutation.
- Animate old visual to actual target geometry.
- Cancel/retarget.
- Clean up clones/transforms/signals.
- Respect system animation settings.

Keep all compositor-animation hacks isolated here because Shell actor internals are more likely to need GNOME-version-specific maintenance than the state machine.

---

# 8. Restore behavior

Before the extension moves a normal restored window into a snap state, store its frame rectangle:

```ts
restoreRect = window.get_frame_rect()
```

Do not overwrite the restore rectangle every time the window moves between snap states.

Example:

```text
RESTORED -> LEFT
store restoreRect

LEFT -> TOP_LEFT
keep same restoreRect

TOP_LEFT -> RIGHT
keep same restoreRect
```

When restoring from an extension-controlled snap state, use that rectangle when appropriate.

For native maximize:

- Prefer Mutter's native maximize/unmaximize semantics.
- Do not manually fake maximization using a work-area-sized `move_resize_frame()`.

The current extension treats MAXIMIZED as a manually resized work-area rectangle. Stop doing that.

Use:

```ts
window.maximize(Meta.MaximizeFlags.BOTH)
window.unmaximize(...)
```

with the correct GNOME 49/50 API signature.

---

# 9. Multi-monitor behavior

Preserve the current use of the monitor work area:

```ts
Main.layoutManager.getWorkAreaForMonitor(window.get_monitor())
```

Preserve gap support.

Do not include panels/docks in the target rectangle when GNOME's work area already excludes them.

For this iteration, focus on correct snap behavior on the current monitor.

Windows-exact cross-monitor cycling after repeated `Super+Left/Right` can be implemented separately.

The architecture should not make that future feature impossible.

---

# 10. Acceptance criteria

## Keybindings

- Enabling the extension does not change any native GNOME/Mutter GSettings keybinding.
- Disabling the extension does not reset any native GNOME/Mutter keybinding.
- `Ctrl+Shift+Left` continues to move the current window to the workspace on the left in the user's configuration.
- `Ctrl+Shift+Right` continues to move the current window to the workspace on the right.
- Disabling/re-enabling the extension does not alter those shortcuts.

## Basic snaps

- `Super+Left` snaps to the left half.
- `Super+Right` snaps to the right half.
- There are no top-half or bottom-half snap states.

## Corner chains

With Super held:

```text
Left, Up    -> TOP_LEFT
Left, Down  -> BOTTOM_LEFT
Right, Up   -> TOP_RIGHT
Right, Down -> BOTTOM_RIGHT
```

The user must not need a simultaneous three-arrow/modifier chord.

## Up/down behavior

- `Super+Up` from a normal unsnapped window maximizes.
- `Super+Down` from maximized restores.
- `Super+Down` from restored minimizes.
- `Super+Up` from LEFT goes TOP_LEFT.
- `Super+Up` from RIGHT goes TOP_RIGHT.
- `Super+Down` from LEFT goes BOTTOM_LEFT.
- `Super+Down` from RIGHT goes BOTTOM_RIGHT.

## Animation

- Half and corner snaps visually animate rather than teleport.
- Animation is compositor-side, not frame-by-frame client resizing.
- Target native-feeling timing is approximately 250 ms / `EASE_OUT_QUAD`.
- System animation/reduced-motion preferences are respected.
- Rapid `Super+Left`, `Up` does not leave a frozen/hidden/transformed window actor.
- Rapid repeated arrow presses end in the most recently requested state.

## Discord / constrained windows

- Discord receives one main resize request per snap.
- At most one bounded anchor correction is performed after actual geometry settles.
- There is no indefinite 20 ms retry loop.
- If Discord cannot fit an ideal quarter/half because of minimum size, it is still anchored to the requested edge/corner.
- A constrained window may overlap the ideal slot rather than causing the snap command to fail or loop.
- Keyboard state remains the requested logical snap state even when actual client constraints slightly alter geometry.

## Cleanup

- Closing a window during animation leaves no clone or pending signal.
- Disabling the extension during animation leaves no clone or transformed/frozen actor.
- Window `unmanaged` cleanup disconnects all signals.
- No GLib source continues after the tracked window or extension is destroyed.

---

# 11. Recommended implementation order

1. **Fork the upstream repository.**
2. **Remove all native GNOME/Mutter keybinding mutation from `extension.ts`.**
3. **Verify `Ctrl+Shift+Left/Right` again and capture binding diagnostics.**
4. **Replace the state machine and remove TOP/BOTTOM half states.**
5. **Use native maximize/unmaximize/minimize operations for Up/Down behavior.**
6. **Delete the 20 ms resize retry loop.**
7. **Introduce explicit per-window logical snap state and restore rectangles.**
8. **Add one-shot geometry settlement plus maximum-one-pass edge anchoring.**
9. **Instrument and reproduce Discord behavior.**
10. **Add `SnapAnimator` and compositor-side half/corner animations.**
11. **Stress-test rapid chained arrow presses and extension disable/enable cleanup.**
12. **Remove/gate temporary debug logging.**

Do not start with animation.

First make geometry and state transitions deterministic. Animation should sit on top of a correct one-shot movement model.

---

# 12. Source references reviewed

Smart Tiling:

- `src/extension.ts`
- `src/keybindings.ts`
- `src/tile.ts`
- `src/tileManager.ts`
- `resources/schemas/org.gnome.shell.extensions.smarttiling.gschema.xml`
- `resources/LICENSE`
- `resources/metadata.json`
- repository commit history

GNOME/Mutter:

- GNOME Shell `js/ui/windowManager.js`
- Mutter `Meta.Window` API documentation
- `Meta.Window.get_min_size()`
- `Meta.Window.move_resize_frame()`

Primary source locations:

https://github.com/samuelnovaes/smart-tiling

https://github.com/GNOME/gnome-shell/blob/main/js/ui/windowManager.js

https://mutter.gnome.org/meta/class.Window.html

https://mutter.gnome.org/meta/method.Window.get_min_size.html

https://mutter.gnome.org/meta/method.Window.move_resize_frame.html

---

# Bottom line

Fork Smart Tiling.

Do **not** preserve its current movement architecture.

Keep the repository skeleton and useful geometry/settings pieces, then replace:

```text
global native-keybinding mutation
+
geometry-only state inference
+
20 ms resize retry loop
+
TOP/BOTTOM half-screen state machine
```

with:

```text
extension-owned keybindings only
+
explicit per-window snap state
+
Windows-style transition table
+
native maximize/minimize
+
one-shot constrained-window geometry
+
bounded edge anchoring
+
isolated compositor SnapAnimator
```

This is smaller and safer than a total rewrite, while still addressing the parts of the code that are actually responsible for the current bad behavior.
