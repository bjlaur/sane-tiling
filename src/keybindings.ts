import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

export default class Keybindings {
  private builtinBindings: Set<string> = new Set();
  private extensionBindings: Set<string> = new Set();
  private stageCapturedEventId = 0;
  private settings: Gio.Settings;

  constructor(settings: Gio.Settings) {
    this.settings = settings;
    this.stageCapturedEventId = global.stage.connect(
      'captured-event',
      (_actor, event) => {
        const eventType = event.type();
        if (eventType !== Clutter.EventType.KEY_PRESS && eventType !== Clutter.EventType.KEY_RELEASE) {
          return Clutter.EVENT_PROPAGATE;
        }

        const keySymbol = event.get_key_symbol();
        if (keySymbol !== Clutter.KEY_Up && keySymbol !== Clutter.KEY_Down) {
          return Clutter.EVENT_PROPAGATE;
        }

        const modifierState = event.get_state();
        if (!(modifierState & Clutter.ModifierType.SUPER_MASK)) {
          return Clutter.EVENT_PROPAGATE;
        }

        this.debugLog(
          `raw=${eventType === Clutter.EventType.KEY_PRESS ? 'press' : 'release'} ` +
          `key=${keySymbol === Clutter.KEY_Up ? 'Up' : 'Down'} modifiers=${modifierState}`
        );

        return Clutter.EVENT_PROPAGATE;
      }
    );
  }

  addBuiltin(key: string, handler: () => void) {
    try {
      const added = Meta.keybindings_set_custom_handler(key, () => {
        this.debugLog(`builtin=${key}`);
        handler();
      });

      if (!added) {
        console.error(`Sane Tiling: builtin keybinding ${key} was not found`);
        return;
      }

      this.builtinBindings.add(key);
    }
    catch (error) {
      console.error(`Sane Tiling: failed to override ${key}: ${error}`);
    }
  }

  addExtension(key: string, handler: () => void) {
    try {
      Main.wm.addKeybinding(
        key,
        this.settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL,
        () => {
          this.debugLog(`extension=${key}`);
          handler();
        }
      );
      this.extensionBindings.add(key);
    }
    catch (error) {
      console.error(`Sane Tiling: failed to add ${key}: ${error}`);
    }
  }

  destroy() {
    if (this.stageCapturedEventId) {
      global.stage.disconnect(this.stageCapturedEventId);
      this.stageCapturedEventId = 0;
    }

    for (const key of this.extensionBindings) {
      try {
        Main.wm.removeKeybinding(key);
      }
      catch (error) {
        console.error(`Sane Tiling: failed to remove ${key}: ${error}`);
      }
    }

    for (const key of this.builtinBindings) {
      try {
        Meta.keybindings_set_custom_handler(key, null);
      }
      catch (error) {
        console.error(`Sane Tiling: failed to restore ${key}: ${error}`);
      }
    }

    this.extensionBindings.clear();
    this.builtinBindings.clear();
  }

  private debugLog(message: string) {
    if (!this.settings.get_boolean('debug-logging')) {
      return;
    }

    console.log(`Sane Tiling keybinding debug: ${message}`);
  }
}
