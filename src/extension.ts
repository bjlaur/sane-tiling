import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';

import Keybindings from './keybindings.js';
import TileManager from './tileManager.js';

export default class SmartTilingExtension extends Extension {
  private keybindings: Keybindings | null = null;
  private settings: Gio.Settings | null = null;
  private tileManager: TileManager | null = null;

  override enable() {
    this.settings = this.getSettings();
    this.tileManager = new TileManager(this.settings);
    this.keybindings = new Keybindings(this.settings);

    this.keybindings.addBuiltin('toggle-tiled-left', this.tileManager.moveLeft.bind(this.tileManager));
    this.keybindings.addBuiltin('toggle-tiled-right', this.tileManager.moveRight.bind(this.tileManager));
    this.keybindings.addBuiltin('maximize', this.tileManager.moveUp.bind(this.tileManager));
    this.keybindings.addBuiltin('unmaximize', this.tileManager.moveDown.bind(this.tileManager));
    this.keybindings.addExtension('undo-window', this.tileManager.undo.bind(this.tileManager));
  }

  override disable() {
    this.keybindings?.destroy();
    this.tileManager?.destroy();

    this.keybindings = null;
    this.tileManager = null;
    this.settings = null;
  }
}
