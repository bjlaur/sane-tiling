import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import Tile, { type WindowSnapshot } from './tile.js';

export default class TileManager {
    private tiles: Map<number, Tile> = new Map();
    private undoStack: WindowSnapshot[] = [];
    private arrowSequenceTile: Tile | null = null;

    private settings: Gio.Settings;

    constructor(settings: Gio.Settings) {
        this.settings = settings;
    }

    private createTileForWindow(window: Meta.Window) {
        const tile = new Tile(window, this.settings);
        const windowId = window.get_id();
        this.tiles.set(windowId, tile);

        tile.connect('unmanaged', () => {
            if (this.arrowSequenceTile === tile) {
                this.clearArrowSequence('window-unmanaged');
            }

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
        tile.reloadScreen();
        return tile;
    }

    moveRight() {
        this.logCommandEntry('right');

        const tile = this.getArrowTargetTile();
        const position = tile?.getPosition();
        if (!tile || position === undefined) {
            return;
        }

        if (position === Position.LEFT) {
            if (!this.restoreNormalTile(tile)) {
                this.moveTile(tile, Position.RIGHT);
            }
            return;
        }

        if (position === Position.RIGHT) {
            this.moveTileToAdjacentMonitor(tile, 'right', Position.LEFT);
            return;
        }

        this.moveTile(tile, Position.RIGHT);
    }

    moveLeft() {
        this.logCommandEntry('left');

        const tile = this.getArrowTargetTile();
        const position = tile?.getPosition();
        if (!tile || position === undefined) {
            return;
        }

        if (position === Position.RIGHT) {
            if (!this.restoreNormalTile(tile)) {
                this.moveTile(tile, Position.LEFT);
            }
            return;
        }

        if (position === Position.LEFT) {
            this.moveTileToAdjacentMonitor(tile, 'left', Position.RIGHT);
            return;
        }

        this.moveTile(tile, Position.LEFT);
    }

    undo() {
        this.clearArrowSequence('undo');

        const snapshot = this.undoStack.pop();
        if (!snapshot) {
            return;
        }

        this.getTileForWindow(snapshot.window).applySnapshot(snapshot);
    }

    restoreNormal() {
        this.clearArrowSequence('restore-normal-command');

        const tile = this.getCurrentTile();
        if (tile) {
            this.restoreNormalTile(tile);
        }
    }

    moveUp() {
        this.logCommandEntry('up');
        const tile = this.getArrowTargetTile();
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
        this.logCommandEntry('down');

        const tile = this.getArrowTargetTile();
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
            this.restoreNormalTile(tile);
            return;
        }

        this.minimizeTile(tile);
    }

    destroy() {
        this.clearArrowSequence('destroy');

        for (const tile of this.tiles.values()) {
            tile.destroy();
        }

        this.tiles.clear();
        this.undoStack = [];
    }

    private getTileForWindow(window: Meta.Window) {
        return this.tiles.get(window.get_id()) ?? this.createTileForWindow(window);
    }

    private moveTile(tile: Tile, position: Position) {
        const snapshot = tile.captureSnapshot();
        if (tile.move(position)) {
            this.pushUndo(snapshot);
        }
    }

    private moveTileToAdjacentMonitor(tile: Tile, direction: 'left' | 'right', position: Position) {
        const snapshot = tile.captureSnapshot();
        if (tile.moveToAdjacentMonitor(direction, position)) {
            this.pushUndo(snapshot);
        }
    }

    private maximizeTile(tile: Tile) {
        const snapshot = tile.captureSnapshot();
        if (tile.maximize()) {
            this.pushUndo(snapshot);
        }
    }

    private minimizeTile(tile: Tile) {
        const snapshot = tile.captureSnapshot();
        if (tile.minimize()) {
            this.arrowSequenceTile = tile;
            this.pushUndo(snapshot);
        }
    }

    private restoreNormalTile(tile: Tile) {
        const snapshot = tile.captureSnapshot();
        if (tile.restoreNormal()) {
            this.pushUndo(snapshot);
            return true;
        }

        return false;
    }

    private getArrowTargetTile() {
        if (this.arrowSequenceTile) {
            this.arrowSequenceTile.reloadScreen();
            return this.arrowSequenceTile;
        }

        return this.getCurrentTile();
    }

    private clearArrowSequence(reason: string) {
        this.debugLog(`clearArrowSequence reason=${reason}`);
        this.arrowSequenceTile = null;
    }

    private logCommandEntry(command: string) {
        this.debugLog(
            `command=${command} focus=${this.focusWindowId()} ` +
            `arrowTarget=${this.arrowSequenceTile ? 'set' : 'none'}`
        );
    }

    private debugLog(message: string) {
        if (!this.settings.get_boolean('debug-logging')) {
            return;
        }

        console.log(`Sane Tiling manager debug: ${message}`);
    }

    private focusWindowId() {
        return global.display.get_focus_window()?.get_id() ?? 'none';
    }

    private pushUndo(snapshot: WindowSnapshot) {
        this.undoStack.push(snapshot);
        if (this.undoStack.length > 50) {
            this.undoStack.shift();
        }
    }
}
