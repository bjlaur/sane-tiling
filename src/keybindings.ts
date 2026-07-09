import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

export default class Keybindings {
  private builtinBindings: Set<string> = new Set();
  private extensionBindings: Set<string> = new Set();
  private settings: Gio.Settings;

  constructor(settings: Gio.Settings) {
    this.settings = settings;
  }

  addBuiltin(key: string, handler: () => void) {
    try {
      const added = Meta.keybindings_set_custom_handler(key, handler);

      if (!added) {
        console.error(`Smart Tiling: builtin keybinding ${key} was not found`);
        return;
      }

      this.builtinBindings.add(key);
    } catch (error) {
      console.error(`Smart Tiling: failed to override ${key}: ${error}`);
    }
  }

  addExtension(key: string, handler: () => void) {
    try {
      Main.wm.addKeybinding(
        key,
        this.settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL,
        handler
      );
      this.extensionBindings.add(key);
    } catch (error) {
      console.error(`Smart Tiling: failed to add ${key}: ${error}`);
    }
  }

  destroy() {
    for (const key of this.extensionBindings) {
      try {
        Main.wm.removeKeybinding(key);
      } catch (error) {
        console.error(`Smart Tiling: failed to remove ${key}: ${error}`);
      }
    }

    for (const key of this.builtinBindings) {
      try {
        Meta.keybindings_set_custom_handler(key, null);
      } catch (error) {
        console.error(`Smart Tiling: failed to restore ${key}: ${error}`);
      }
    }

    this.extensionBindings.clear();
    this.builtinBindings.clear();
  }
}
