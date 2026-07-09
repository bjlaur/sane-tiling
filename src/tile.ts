import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import SnapAnimator from './snapAnimator.js';

const GEOMETRY_QUIET_TIME = 24;
const GEOMETRY_HARD_TIMEOUT = 220;
const RECT_TOLERANCE = 8;

type WaitState = {
  token: number;
  signalIds: number[];
  quietTimeoutId: number;
  hardTimeoutId: number;
};

export type WindowSnapshot = {
  window: Meta.Window;
  position: Position;
  rect: Mtk.Rectangle;
  maximized: boolean;
  minimized: boolean;
};

export default class Tile {
  private window: Meta.Window;
  private screen: Mtk.Rectangle = new Mtk.Rectangle();
  private gapSize = 0;
  private position = Position.CENTER;
  private lastSettledRect: Mtk.Rectangle | null = null;
  private restoreRect: Mtk.Rectangle | null = null;
  private signals: Set<number> = new Set();
  private waitState: WaitState | null = null;
  private operationToken = 0;
  private animator: SnapAnimator;

  constructor(window: Meta.Window) {
    this.window = window;
    this.animator = new SnapAnimator(window);
    this.lastSettledRect = this.copyRect(window.get_frame_rect());
  }

  getPosition() {
    if (this.waitState) {
      return this.position;
    }

    if (this.window.get_maximize_flags() > 0) {
      this.position = Position.MAXIMIZED;
      return this.position;
    }

    const currentRect = this.window.get_frame_rect();

    if (this.position === Position.MAXIMIZED) {
      this.position = Position.CENTER;
      this.lastSettledRect = this.copyRect(currentRect);
    } else if (this.lastSettledRect &&
        !this.rectNear(currentRect, this.lastSettledRect, RECT_TOLERANCE)) {
      this.animator.cancel();
      this.position = this.detectPosition(currentRect);
      this.lastSettledRect = this.copyRect(currentRect);

      if (this.position === Position.CENTER) {
        this.restoreRect = this.copyRect(currentRect);
      }
    }

    return this.position;
  }

  move(position: Position) {
    if (!this.canSnap()) {
      return false;
    }

    const targetRect = this.getTargetRect(position);
    if (!targetRect) {
      return false;
    }

    const sourceRect = this.animator.captureVisualRect();
    const previousPosition = this.getPosition();
    const token = this.beginOperation();

    if (previousPosition === Position.CENTER) {
      this.restoreRect = this.copyRect(this.window.get_frame_rect());
    }

    this.position = position;
    this.animator.cancel();

    const resize = () => {
      if (token !== this.operationToken) {
        return;
      }

      this.waitForGeometry(token, () => {
        this.finishResize(token, position, sourceRect, false);
      });

      this.animator.prepare(sourceRect, targetRect);
      this.window.move_resize_frame(
        true,
        targetRect.x,
        targetRect.y,
        targetRect.width,
        targetRect.height
      );
    };

    if (this.window.get_maximize_flags() > 0) {
      this.window.unmaximize();
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resize();
        return GLib.SOURCE_REMOVE;
      });
      return true;
    }

    resize();
    return true;
  }

  maximize() {
    if (!this.window.can_maximize()) {
      return false;
    }

    this.beginOperation();
    this.animator.cancel();

    if (this.position === Position.CENTER) {
      this.restoreRect = this.copyRect(this.window.get_frame_rect());
    }

    this.position = Position.MAXIMIZED;
    this.lastSettledRect = null;
    this.window.maximize();
    return true;
  }

  restore() {
    this.beginOperation();
    this.animator.cancel();
    this.position = Position.CENTER;
    const token = this.operationToken;

    this.waitForGeometry(token, () => {
      const rect = this.window.get_frame_rect();
      this.lastSettledRect = this.copyRect(rect);
      this.restoreRect = this.copyRect(rect);
    });

    this.window.unmaximize();
    return true;
  }

  restoreNormal() {
    if (!this.restoreRect) {
      if (this.window.get_maximize_flags() > 0) {
        return this.restore();
      }

      return false;
    }

    if (!this.window.allows_move() || !this.window.allows_resize()) {
      return false;
    }

    const targetRect = this.copyRect(this.restoreRect);
    const sourceRect = this.animator.captureVisualRect();
    const token = this.beginOperation();

    this.animator.cancel();
    this.position = Position.CENTER;

    const restoreGeometry = () => {
      if (token !== this.operationToken) {
        return;
      }

      this.animator.prepare(sourceRect, targetRect);
      this.waitForGeometry(token, () => {
        const settledRect = this.window.get_frame_rect();
        this.position = Position.CENTER;
        this.lastSettledRect = this.copyRect(settledRect);
        this.restoreRect = this.copyRect(settledRect);
        this.animator.animate(sourceRect, settledRect);
      });
      this.window.move_resize_frame(
        true,
        targetRect.x,
        targetRect.y,
        targetRect.width,
        targetRect.height
      );
    };

    if (this.window.get_maximize_flags() > 0) {
      this.window.unmaximize();
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        restoreGeometry();
        return GLib.SOURCE_REMOVE;
      });
      return true;
    }

    restoreGeometry();
    return true;
  }

  minimize() {
    if (!this.window.can_minimize()) {
      return false;
    }

    this.beginOperation();
    this.animator.cancel();
    this.position = Position.CENTER;
    this.lastSettledRect = null;
    this.window.minimize();
    return true;
  }

  reloadScreen(gapSize: number) {
    const monitorIndex = this.window.get_monitor();
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

    this.gapSize = Math.max(0, gapSize);
    this.screen = new Mtk.Rectangle({
      x: workArea.x + this.gapSize,
      y: workArea.y + this.gapSize,
      width: Math.max(1, workArea.width - this.gapSize * 2),
      height: Math.max(1, workArea.height - this.gapSize * 2)
    });

    if (this.position === Position.CENTER && !this.waitState) {
      this.position = this.detectPosition(this.window.get_frame_rect());
    }
  }

  connect(signal: string, callback: (source: Meta.Window) => void) {
    const signalId = this.window.connect(signal, callback);
    this.signals.add(signalId);
    return signalId;
  }

  destroy() {
    this.operationToken++;
    this.clearWaitState();
    this.animator.destroy();

    for (const signalId of this.signals) {
      this.window.disconnect(signalId);
    }

    this.signals.clear();
  }

  captureSnapshot(): WindowSnapshot {
    return {
      window: this.window,
      position: this.getPosition(),
      rect: this.copyRect(this.window.get_frame_rect()),
      maximized: this.window.get_maximize_flags() > 0,
      minimized: this.window.minimized
    };
  }

  applySnapshot(snapshot: WindowSnapshot) {
    const token = this.beginOperation();
    this.animator.cancel();
    this.position = snapshot.position;

    if (this.window.minimized) {
      this.window.unminimize();
    }

    if (snapshot.minimized) {
      this.window.minimize();
      this.lastSettledRect = null;
      return;
    }

    this.window.activate(global.get_current_time());

    if (snapshot.maximized) {
      this.window.maximize();
      this.position = Position.MAXIMIZED;
      this.lastSettledRect = null;
      return;
    }

    const restoreGeometry = () => {
      if (token !== this.operationToken) {
        return;
      }

      const sourceRect = this.animator.captureVisualRect();
      this.animator.prepare(sourceRect, snapshot.rect);
      this.waitForGeometry(token, () => {
        this.clearWaitState();
        this.lastSettledRect = this.copyRect(this.window.get_frame_rect());
        this.animator.animate(sourceRect, this.window.get_frame_rect());
      });
      this.window.move_resize_frame(
        true,
        snapshot.rect.x,
        snapshot.rect.y,
        snapshot.rect.width,
        snapshot.rect.height
      );
    };

    if (this.window.get_maximize_flags() > 0) {
      this.waitForGeometry(token, restoreGeometry);
      this.window.unmaximize();
      return;
    }

    restoreGeometry();
  }

  private beginOperation() {
    this.operationToken++;
    this.clearWaitState();
    return this.operationToken;
  }

  private canSnap() {
    const maximized = this.window.get_maximize_flags() > 0;

    return this.window.get_window_type() === Meta.WindowType.NORMAL &&
      !this.window.is_fullscreen() &&
      this.window.allows_move() &&
      (this.window.allows_resize() || maximized);
  }

  private finishResize(
    token: number,
    position: Position,
    sourceRect: Mtk.Rectangle,
    corrected: boolean
  ) {
    if (token !== this.operationToken) {
      return;
    }

    const actualRect = this.window.get_frame_rect();
    const correctedPosition = this.getAnchoredPosition(position, actualRect);

    if (!corrected &&
        (correctedPosition.x !== actualRect.x || correctedPosition.y !== actualRect.y)) {
      this.waitForGeometry(token, () => {
        this.finishResize(token, position, sourceRect, true);
      });
      this.window.move_frame(true, correctedPosition.x, correctedPosition.y);
      return;
    }

    this.clearWaitState();
    const settledRect = this.window.get_frame_rect();
    this.position = position;
    this.lastSettledRect = this.copyRect(settledRect);
    this.animator.animate(sourceRect, settledRect);
  }

  private waitForGeometry(token: number, callback: () => void) {
    this.clearWaitState();

    const state: WaitState = {
      token,
      signalIds: [],
      quietTimeoutId: 0,
      hardTimeoutId: 0
    };

    const finish = () => {
      if (this.waitState !== state || token !== this.operationToken) {
        return GLib.SOURCE_REMOVE;
      }

      this.clearWaitState();
      callback();
      return GLib.SOURCE_REMOVE;
    };

    const queueQuietFinish = () => {
      if (this.waitState !== state || token !== this.operationToken) {
        return;
      }

      if (state.quietTimeoutId) {
        GLib.source_remove(state.quietTimeoutId);
      }

      state.quietTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        GEOMETRY_QUIET_TIME,
        () => {
          state.quietTimeoutId = 0;
          return finish();
        }
      );
    };

    state.signalIds.push(this.window.connect('size-changed', queueQuietFinish));
    state.signalIds.push(this.window.connect('position-changed', queueQuietFinish));
    state.hardTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      GEOMETRY_HARD_TIMEOUT,
      () => {
        state.hardTimeoutId = 0;
        return finish();
      }
    );

    this.waitState = state;
  }

  private clearWaitState() {
    const state = this.waitState;
    if (!state) {
      return;
    }

    this.waitState = null;

    for (const signalId of state.signalIds) {
      this.window.disconnect(signalId);
    }

    if (state.quietTimeoutId) {
      GLib.source_remove(state.quietTimeoutId);
    }

    if (state.hardTimeoutId) {
      GLib.source_remove(state.hardTimeoutId);
    }
  }

  private getTargetRect(position: Position) {
    const innerGap = this.gapSize;
    const leftWidth = Math.max(1, Math.floor((this.screen.width - innerGap) / 2));
    const rightWidth = Math.max(1, this.screen.width - innerGap - leftWidth);
    const topHeight = Math.max(1, Math.floor((this.screen.height - innerGap) / 2));
    const bottomHeight = Math.max(1, this.screen.height - innerGap - topHeight);
    const rightX = this.screen.x + leftWidth + innerGap;
    const bottomY = this.screen.y + topHeight + innerGap;

    switch (position) {
      case Position.LEFT:
        return new Mtk.Rectangle({
          x: this.screen.x,
          y: this.screen.y,
          width: leftWidth,
          height: this.screen.height
        });
      case Position.RIGHT:
        return new Mtk.Rectangle({
          x: rightX,
          y: this.screen.y,
          width: rightWidth,
          height: this.screen.height
        });
      case Position.TOP_LEFT:
        return new Mtk.Rectangle({
          x: this.screen.x,
          y: this.screen.y,
          width: leftWidth,
          height: topHeight
        });
      case Position.TOP_RIGHT:
        return new Mtk.Rectangle({
          x: rightX,
          y: this.screen.y,
          width: rightWidth,
          height: topHeight
        });
      case Position.BOTTOM_LEFT:
        return new Mtk.Rectangle({
          x: this.screen.x,
          y: bottomY,
          width: leftWidth,
          height: bottomHeight
        });
      case Position.BOTTOM_RIGHT:
        return new Mtk.Rectangle({
          x: rightX,
          y: bottomY,
          width: rightWidth,
          height: bottomHeight
        });
      default:
        return null;
    }
  }

  private getAnchoredPosition(position: Position, rect: Mtk.Rectangle) {
    let x = rect.x;
    let y = rect.y;

    if (position === Position.LEFT || position === Position.TOP_LEFT ||
        position === Position.BOTTOM_LEFT) {
      x = this.screen.x;
    } else if (position === Position.RIGHT || position === Position.TOP_RIGHT ||
        position === Position.BOTTOM_RIGHT) {
      x = this.screen.x + this.screen.width - rect.width;
    }

    if (position === Position.TOP_LEFT || position === Position.TOP_RIGHT ||
        position === Position.LEFT || position === Position.RIGHT) {
      y = this.screen.y;
    } else if (position === Position.BOTTOM_LEFT || position === Position.BOTTOM_RIGHT) {
      y = this.screen.y + this.screen.height - rect.height;
    }

    return { x, y };
  }

  private detectPosition(rect: Mtk.Rectangle) {
    if (this.window.get_maximize_flags() > 0) {
      return Position.MAXIMIZED;
    }

    const top = Math.abs(rect.y - this.screen.y) <= RECT_TOLERANCE;
    const bottom = Math.abs((rect.y + rect.height) -
      (this.screen.y + this.screen.height)) <= RECT_TOLERANCE;
    const left = Math.abs(rect.x - this.screen.x) <= RECT_TOLERANCE;
    const right = Math.abs((rect.x + rect.width) -
      (this.screen.x + this.screen.width)) <= RECT_TOLERANCE;

    if (top && bottom && left && !right) {
      return Position.LEFT;
    }

    if (top && bottom && !left && right) {
      return Position.RIGHT;
    }

    if (top && !bottom && left && !right) {
      return Position.TOP_LEFT;
    }

    if (top && !bottom && !left && right) {
      return Position.TOP_RIGHT;
    }

    if (!top && bottom && left && !right) {
      return Position.BOTTOM_LEFT;
    }

    if (!top && bottom && !left && right) {
      return Position.BOTTOM_RIGHT;
    }

    return Position.CENTER;
  }

  private rectNear(a: Mtk.Rectangle, b: Mtk.Rectangle, tolerance: number) {
    return Math.abs(a.x - b.x) <= tolerance &&
      Math.abs(a.y - b.y) <= tolerance &&
      Math.abs(a.width - b.width) <= tolerance &&
      Math.abs(a.height - b.height) <= tolerance;
  }

  private copyRect(rect: Mtk.Rectangle) {
    return new Mtk.Rectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    });
  }
}
