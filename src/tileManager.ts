import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import Tile, { type WindowSnapshot } from './tile.js';

export default class TileManager {
  private tiles: Map<number, Tile> = new Map();
  private undoStack: WindowSnapshot[] = [];
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
    this.move(Position.RIGHT);
  }

  moveLeft() {
    this.move(Position.LEFT);
  }

  undo() {
    const snapshot = this.undoStack.pop();

    if (!snapshot) {
      return;
    }

    this.getTileForWindow(snapshot.window).applySnapshot(snapshot);
  }

  moveUp() {
    const tile = this.getCurrentTile();
    const position = tile?.getPosition();

    if (!tile || position === undefined) {
      return;
    }

    if (position === Position.BOTTOM_LEFT) {
      this.moveTile(tile, Position.LEFT);
      return;
    }

    if (position === Position.LEFT) {
      this.moveTile(tile, Position.TOP_LEFT);
      return;
    }

    if (position === Position.BOTTOM_RIGHT) {
      this.moveTile(tile, Position.RIGHT);
      return;
    }

    if (position === Position.RIGHT) {
      this.moveTile(tile, Position.TOP_RIGHT);
      return;
    }

    if (position === Position.MAXIMIZED) {
      return;
    }

    this.maximizeTile(tile);
  }

  moveDown() {
    const tile = this.getCurrentTile();
    const position = tile?.getPosition();

    if (!tile || position === undefined) {
      return;
    }

    if (position === Position.TOP_LEFT) {
      this.moveTile(tile, Position.LEFT);
      return;
    }

    if (position === Position.LEFT) {
      this.moveTile(tile, Position.BOTTOM_LEFT);
      return;
    }

    if (position === Position.TOP_RIGHT) {
      this.moveTile(tile, Position.RIGHT);
      return;
    }

    if (position === Position.RIGHT) {
      this.moveTile(tile, Position.BOTTOM_RIGHT);
      return;
    }

    if (position === Position.MAXIMIZED) {
      this.restoreTile(tile);
      return;
    }

    this.minimizeTile(tile);
  }

  destroy() {
    for (const tile of this.tiles.values()) {
      tile.destroy();
    }

    this.tiles.clear();
    this.undoStack = [];
  }

  private getTileForWindow(window: Meta.Window) {
    return this.tiles.get(window.get_id()) ?? this.createTileForWindow(window);
  }

  private move(position: Position) {
    const tile = this.getCurrentTile();

    if (tile) {
      this.moveTile(tile, position);
    }
  }

  private moveTile(tile: Tile, position: Position) {
    const snapshot = tile.captureSnapshot();

    if (tile.move(position)) {
      this.pushUndo(snapshot);
    }
  }

  private maximizeTile(tile: Tile) {
    const snapshot = tile.captureSnapshot();

    if (tile.maximize()) {
      this.pushUndo(snapshot);
    }
  }

  private restoreTile(tile: Tile) {
    const snapshot = tile.captureSnapshot();

    if (tile.restore()) {
      this.pushUndo(snapshot);
    }
  }

  private minimizeTile(tile: Tile) {
    const snapshot = tile.captureSnapshot();

    if (tile.minimize()) {
      this.pushUndo(snapshot);
    }
  }

  private pushUndo(snapshot: WindowSnapshot) {
    this.undoStack.push(snapshot);

    if (this.undoStack.length > 50) {
      this.undoStack.shift();
    }
  }
}
