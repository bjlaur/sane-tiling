import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import Tile, { type WindowSnapshot } from './tile.js';

type MinimizedSequence = {
    tile: Tile;
    snapshot: WindowSnapshot;
};

export default class TileManager {
    private tiles: Map<number, Tile> = new Map();
    private undoStack: WindowSnapshot[] = [];
    private minimizedSequence: MinimizedSequence | null = null;
    private arrowSequenceTile: Tile | null = null;
    private stageCapturedEventId = 0;

    private settings: Gio.Settings;

    constructor(settings: Gio.Settings) {
        this.settings = settings;
        this.stageCapturedEventId = global.stage.connect(
            'captured-event',
            (_actor, event) => {
                if (event.type() !== Clutter.EventType.KEY_RELEASE) {
                    return Clutter.EVENT_PROPAGATE;
                }

                const keySymbol = event.get_key_symbol();
                if (keySymbol === Clutter.KEY_Super_L || keySymbol === Clutter.KEY_Super_R) {
                    this.clearArrowSequence();
                }

                return Clutter.EVENT_PROPAGATE;
            }
        );
    }

    private createTileForWindow(window: Meta.Window) {
        const tile = new Tile(window, this.settings);
        const windowId = window.get_id();
        this.tiles.set(windowId, tile);

        tile.connect('unmanaged', () => {
            if (this.minimizedSequence?.tile === tile || this.arrowSequenceTile === tile) {
                this.clearArrowSequence();
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
        this.abandonPendingMinimize();

        const tile = this.getArrowTargetTile();
        const position = tile?.getPosition();
        if (!tile || position === undefined) {
            return;
        }

        if (position === Position.LEFT) {
            this.restoreNormalTile(tile);
            return;
        }

        if (position === Position.RIGHT) {
            return;
        }

        this.moveTile(tile, Position.RIGHT);
    }

    moveLeft() {
        this.abandonPendingMinimize();

        const tile = this.getArrowTargetTile();
        const position = tile?.getPosition();
        if (!tile || position === undefined) {
            return;
        }

        if (position === Position.RIGHT) {
            this.restoreNormalTile(tile);
            return;
        }

        if (position === Position.LEFT) {
            return;
        }

        this.moveTile(tile, Position.LEFT);
    }

    undo() {
        this.clearArrowSequence();

        const snapshot = this.undoStack.pop();
        if (!snapshot) {
            return;
        }

        this.getTileForWindow(snapshot.window).applySnapshot(snapshot);
    }

    restoreNormal() {
        this.clearArrowSequence();

        const tile = this.getCurrentTile();
        if (tile) {
            this.restoreNormalTile(tile);
        }
    }

    moveUp() {
        if (this.restoreMinimizedSequence()) {
            return;
        }

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
        this.abandonPendingMinimize();

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
        this.clearArrowSequence();

        if (this.stageCapturedEventId) {
            global.stage.disconnect(this.stageCapturedEventId);
            this.stageCapturedEventId = 0;
        }

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
            this.minimizedSequence = { tile, snapshot };
            this.pushUndo(snapshot);
        }
    }

    private restoreMinimizedSequence() {
        const sequence = this.minimizedSequence;
        this.minimizedSequence = null;

        if (!sequence || !sequence.snapshot.window.minimized) {
            return false;
        }

        this.arrowSequenceTile = sequence.tile;
        const minimizedSnapshot = sequence.tile.captureSnapshot();
        sequence.tile.reloadScreen();
        sequence.tile.applySnapshot(sequence.snapshot);
        this.pushUndo(minimizedSnapshot);
        return true;
    }

    private restoreNormalTile(tile: Tile) {
        const snapshot = tile.captureSnapshot();
        if (tile.restoreNormal()) {
            this.pushUndo(snapshot);
        }
    }

    private getArrowTargetTile() {
        if (this.arrowSequenceTile) {
            this.arrowSequenceTile.reloadScreen();
            return this.arrowSequenceTile;
        }

        return this.getCurrentTile();
    }

    private abandonPendingMinimize() {
        if (!this.minimizedSequence) {
            return;
        }

        this.clearArrowSequence();
    }

    private clearArrowSequence() {
        this.minimizedSequence = null;
        this.arrowSequenceTile = null;
    }


    private pushUndo(snapshot: WindowSnapshot) {
        this.undoStack.push(snapshot);
        if (this.undoStack.length > 50) {
            this.undoStack.shift();
        }
    }
}
