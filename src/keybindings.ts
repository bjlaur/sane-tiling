import Meta from 'gi://Meta';

export default class Keybindings {
  private bindings: Set<string> = new Set();

  add(key: string, handler: () => void) {
    try {
      const added = Meta.keybindings_set_custom_handler(key, handler);

      if (!added) {
        console.error(`Smart Tiling: builtin keybinding ${key} was not found`);
        return;
      }

      this.bindings.add(key);
    } catch (error) {
      console.error(`Smart Tiling: failed to override ${key}: ${error}`);
    }
  }

  destroy() {
    for (const key of this.bindings) {
      try {
        Meta.keybindings_set_custom_handler(key, null);
      } catch (error) {
        console.error(`Smart Tiling: failed to restore ${key}: ${error}`);
      }
    }

    this.bindings.clear();
  }
}
