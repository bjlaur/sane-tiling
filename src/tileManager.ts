import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import Tile from './tile.js';

export default class TileManager {
  private tiles: Map<number, Tile> = new Map();
  private lastMinimizedTile: Tile | null = null;
  private settings: Gio.Settings;

  constructor(settings: Gio.Settings) {
    this.settings = settings;
  }

  private createTileForWindow(window: Meta.Window) {
    const tile = new Tile(window);
    const windowId = window.get_id();

    this.tiles.set(windowId, tile);
    tile.connect('unmanaged', () => {
      tile.destroy();
      this.tiles.delete(windowId);
    });

    return tile;
  }

  private getCurrentTile() {
    const window = global.display.get_focus_window();
    if (!window) {
      return null;
    }

    const existingTile = this.tiles.get(window.get_id());
    const tile = existingTile ?? this.createTileForWindow(window);
    tile.reloadScreen(this.settings.get_int('gap-size'));

    return tile;
  }

  moveRight() {
    this.getCurrentTile()?.move(Position.RIGHT);
  }

  moveLeft() {
    this.getCurrentTile()?.move(Position.LEFT);
  }

  moveUp() {
    const tile = this.getCurrentTile();
    const position = tile?.getPosition();

    if (!tile || position === undefined) {
      if (this.lastMinimizedTile?.restoreMinimized()) {
        this.lastMinimizedTile = null;
      }

      return;
    }

    if (position === Position.BOTTOM_LEFT) {
      tile.move(Position.LEFT);
      return;
    }

    if (position === Position.LEFT) {
      tile.move(Position.TOP_LEFT);
      return;
    }

    if (position === Position.BOTTOM_RIGHT) {
      tile.move(Position.RIGHT);
      return;
    }

    if (position === Position.RIGHT) {
      tile.move(Position.TOP_RIGHT);
      return;
    }

    if (position === Position.MAXIMIZED) {
      return;
    }

    tile.maximize();
  }

  moveDown() {
    const tile = this.getCurrentTile();
    const position = tile?.getPosition();

    if (!tile || position === undefined) {
      return;
    }

    if (position === Position.TOP_LEFT) {
      tile.move(Position.LEFT);
      return;
    }

    if (position === Position.LEFT) {
      tile.move(Position.BOTTOM_LEFT);
      return;
    }

    if (position === Position.TOP_RIGHT) {
      tile.move(Position.RIGHT);
      return;
    }

    if (position === Position.RIGHT) {
      tile.move(Position.BOTTOM_RIGHT);
      return;
    }

    if (position === Position.MAXIMIZED) {
      tile.restore();
      return;
    }

    if (tile.minimize()) {
      this.lastMinimizedTile = tile;
    }
  }

  destroy() {
    for (const tile of this.tiles.values()) {
      tile.destroy();
    }

    this.tiles.clear();
    this.lastMinimizedTile = null;
  }
}
