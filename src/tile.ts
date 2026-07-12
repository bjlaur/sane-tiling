import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import SnapAnimator from './snapAnimator.js';

const GEOMETRY_QUIET_TIME = 24;
const GEOMETRY_HARD_TIMEOUT = 220;
const MAXIMIZE_STATE_HARD_TIMEOUT = 500;
const RECT_TOLERANCE = 8;

type WaitState = {
  token: number;
  signalIds: number[];
  quietTimeoutId: number;
  hardTimeoutId: number;
};

type MaximizeWaitState = {
  token: number;
  signalIds: number[];
  hardTimeoutId: number;
};

type DebugTrace = {
  label: string;
  startTime: number;
  lastTime: number;
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
  private position = Position.CENTER;
  private lastSettledRect: Mtk.Rectangle | null = null;
  private restoreRect: Mtk.Rectangle | null = null;
  private signals: Set<number> = new Set();
  private waitState: WaitState | null = null;
  private maximizeWaitState: MaximizeWaitState | null = null;
  private operationToken = 0;
  private animator: SnapAnimator;
  private settings: Gio.Settings;
  private debugTrace: DebugTrace | null = null;

  constructor(window: Meta.Window, settings: Gio.Settings) {
    this.window = window;
    this.settings = settings;
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
    this.startDebugTrace(`move:${previousPosition}->${position}`);
    this.debugLog(`source=${this.formatRect(sourceRect)} target=${this.formatRect(targetRect)}`);

    if (previousPosition === Position.CENTER) {
      this.restoreRect = this.copyRect(this.window.get_frame_rect());
    }

    this.position = position;
    this.animator.cancel();

    if (this.window.get_maximize_flags() > 0) {
      this.debugLog('route=maximized');
      this.moveFromMaximized(token, position, sourceRect, targetRect);
      return true;
    }

    this.debugLog('route=normal');
    this.moveNormal(token, position, sourceRect, targetRect);
    return true;
  }

  maximize() {
    if (!this.window.can_maximize()) {
      return false;
    }

    const token = this.beginOperation();
    this.startDebugTrace(`maximize:${this.position}`);
    this.animator.cancel();

    if (this.position === Position.CENTER) {
      this.restoreRect = this.copyRect(this.window.get_frame_rect());
    }

    this.position = Position.MAXIMIZED;
    this.lastSettledRect = null;
    this.waitForGeometry(token, () => {
      this.debugLog(`native maximize geometry settled rect=${this.formatRect(this.window.get_frame_rect())}`);
      this.finishDebugTrace();
    });
    this.debugLog('native maximize request');
    this.window.maximize();
    return true;
  }

  restore() {
    const token = this.beginOperation();
    this.startDebugTrace('restore:maximized->center');
    this.animator.cancel();
    this.position = Position.CENTER;

    this.waitForGeometry(token, () => {
      const rect = this.window.get_frame_rect();
      this.lastSettledRect = this.copyRect(rect);
      this.restoreRect = this.copyRect(rect);
      this.debugLog(`native restore geometry settled rect=${this.formatRect(rect)}`);
      this.finishDebugTrace();
    });

    this.debugLog('native restore request');
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

    const maximized = this.window.get_maximize_flags() > 0;
    if (!this.window.allows_move() || (!maximized && !this.window.allows_resize())) {
      return false;
    }

    const targetRect = this.copyRect(this.restoreRect);
    const sourceRect = this.animator.captureVisualRect();
    const token = this.beginOperation();
    this.startDebugTrace('restore-normal');
    this.debugLog(`source=${this.formatRect(sourceRect)} target=${this.formatRect(targetRect)}`);

    this.animator.cancel();
    this.position = Position.CENTER;

    const restoreGeometry = () => {
      if (token !== this.operationToken) {
        return;
      }

      this.waitForGeometry(token, () => {
        const settledRect = this.window.get_frame_rect();
        this.position = Position.CENTER;
        this.lastSettledRect = this.copyRect(settledRect);
        this.restoreRect = this.copyRect(settledRect);
        this.debugLog(`animate start final=${this.formatRect(settledRect)}`);
        this.animator.animate(sourceRect, settledRect, () => {
          this.debugLog('animation complete');
          this.finishDebugTrace();
        });
      });
      this.animator.freeze();
      this.debugLog(`restore-normal resize request target=${this.formatRect(targetRect)}`);
      this.window.move_resize_frame(
        true,
        targetRect.x,
        targetRect.y,
        targetRect.width,
        targetRect.height
      );
    };

    if (maximized) {
      this.waitForFullyUnmaximized(
        token,
        restoreGeometry,
        () => {
          if (token !== this.operationToken) {
            return;
          }

          const rect = this.window.get_frame_rect();
          this.position = this.detectPosition(rect);
          this.lastSettledRect = this.copyRect(rect);
          this.animator.cancel();
        }
      );
      this.animator.freeze();
      this.debugLog('restore-normal unmaximize request');
      this.window.unmaximize();
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
    this.startDebugTrace(`minimize:${this.position}`);
    this.animator.cancel();
    this.debugLog('native minimize request');
    this.window.minimize();
    this.finishDebugTrace();
    return true;
  }

  reloadScreen() {
    const monitorIndex = this.window.get_monitor();
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

    this.screen = new Mtk.Rectangle({
      x: workArea.x,
      y: workArea.y,
      width: Math.max(1, workArea.width),
      height: Math.max(1, workArea.height)
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
    this.clearMaximizeWaitState();
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
    this.startDebugTrace(`undo:${this.position}->${snapshot.position}`);
    this.animator.cancel();
    this.position = snapshot.position;

    if (this.window.minimized) {
      this.debugLog('undo unminimize current window');
      this.window.unminimize();
    }

    if (snapshot.minimized) {
      this.debugLog('undo minimize request');
      this.window.minimize();
      this.lastSettledRect = null;
      this.finishDebugTrace();
      return;
    }

    this.debugLog('undo activate window');
    this.window.activate(global.get_current_time());

    if (snapshot.maximized) {
      this.debugLog('undo maximize request');
      this.window.maximize();
      this.position = Position.MAXIMIZED;
      this.lastSettledRect = null;
      this.finishDebugTrace();
      return;
    }

    const restoreGeometry = () => {
      if (token !== this.operationToken) {
        return;
      }

      const sourceRect = this.animator.captureVisualRect();
      this.waitForGeometry(token, () => {
        this.clearWaitState();
        this.lastSettledRect = this.copyRect(this.window.get_frame_rect());
        const settledRect = this.window.get_frame_rect();
        this.debugLog(`undo geometry settled final=${this.formatRect(settledRect)}`);
        this.debugLog('animate start');
        this.animator.animate(sourceRect, settledRect, () => {
          this.debugLog('animation complete');
          this.finishDebugTrace();
        });
      });
      this.animator.freeze();
      this.debugLog(`undo resize request target=${this.formatRect(snapshot.rect)}`);
      this.window.move_resize_frame(
        true,
        snapshot.rect.x,
        snapshot.rect.y,
        snapshot.rect.width,
        snapshot.rect.height
      );
    };

    if (this.window.get_maximize_flags() > 0) {
      this.waitForFullyUnmaximized(
        token,
        restoreGeometry,
        () => {
          if (token !== this.operationToken) {
            return;
          }

          const rect = this.window.get_frame_rect();
          this.position = this.detectPosition(rect);
          this.lastSettledRect = this.copyRect(rect);
          this.animator.cancel();
        }
      );
      this.animator.freeze();
      this.debugLog('undo unmaximize request');
      this.window.unmaximize();
      return;
    }

    restoreGeometry();
  }

  private beginOperation() {
    this.operationToken++;
    this.clearWaitState();
    this.clearMaximizeWaitState();
    return this.operationToken;
  }

  private canSnap() {
    const maximized = this.window.get_maximize_flags() > 0;

    return this.window.get_window_type() === Meta.WindowType.NORMAL &&
      !this.window.is_fullscreen() &&
      this.window.allows_move() &&
      (this.window.allows_resize() || maximized);
  }

  private moveFromMaximized(
    token: number,
    position: Position,
    sourceRect: Mtk.Rectangle,
    targetRect: Mtk.Rectangle
  ) {
    if (position === Position.LEFT || position === Position.RIGHT) {
      const flags = this.window.get_maximize_flags();
      const horizontallyMaximized = (flags & Meta.MaximizeFlags.HORIZONTAL) !== 0;

      if (horizontallyMaximized) {
        this.debugLog(
          `horizontal unmaximize before flags=${flags} ` +
          `h=${this.window.maximized_horizontally} v=${this.window.maximized_vertically}`
        );
        this.window.set_unmaximize_flags(Meta.MaximizeFlags.HORIZONTAL);
        this.debugLog(
          `horizontal unmaximize after flags=${this.window.get_maximize_flags()} ` +
          `h=${this.window.maximized_horizontally} v=${this.window.maximized_vertically}`
        );
        this.moveNormal(token, position, sourceRect, targetRect);
        return;
      }
    }

    this.waitForFullyUnmaximized(
      token,
      () => {
        if (token !== this.operationToken) {
          return;
        }

        this.normalizeToRect(token, sourceRect, () => {
          if (token !== this.operationToken) {
            return;
          }

          this.debugLog('normalize settled');
          this.moveNormal(token, position, sourceRect, targetRect);
        });
      },
      () => {
        if (token !== this.operationToken) {
          return;
        }

        const rect = this.window.get_frame_rect();
        this.position = this.detectPosition(rect);
        this.lastSettledRect = this.copyRect(rect);
        this.animator.cancel();
      }
    );

    this.animator.freeze();
    this.debugLog('unmaximize request');
    this.window.unmaximize();
  }

  private moveNormal(
    token: number,
    position: Position,
    sourceRect: Mtk.Rectangle,
    targetRect: Mtk.Rectangle,
    skipAnimation = false
  ) {
    if (token !== this.operationToken) {
      return;
    }

    this.waitForGeometry(token, () => {
      this.debugLog('snap geometry settled');
      this.finishResize(token, position, sourceRect, false, skipAnimation);
    });

    this.animator.freeze();
    this.debugLog(`snap resize request target=${this.formatRect(targetRect)}`);
    this.window.move_resize_frame(
      true,
      targetRect.x,
      targetRect.y,
      targetRect.width,
      targetRect.height
    );
  }

  private normalizeToRect(token: number, rect: Mtk.Rectangle, callback: () => void) {
    if (token !== this.operationToken) {
      return;
    }

    this.waitForGeometry(token, callback);
    this.debugLog(`normalize request rect=${this.formatRect(rect)}`);
    this.window.move_resize_frame(
      true,
      rect.x,
      rect.y,
      rect.width,
      rect.height
    );
  }

  private finishResize(
    token: number,
    position: Position,
    sourceRect: Mtk.Rectangle,
    corrected: boolean,
    skipAnimation = false
  ) {
    if (token !== this.operationToken) {
      return;
    }

    const actualRect = this.window.get_frame_rect();
    this.debugLog(
      `actual rect=${this.formatRect(actualRect)} flags=${this.window.get_maximize_flags()} ` +
      `h=${this.window.maximized_horizontally} v=${this.window.maximized_vertically}`
    );
    const correctedPosition = this.getAnchoredPosition(position, actualRect);

    if (!corrected &&
        (correctedPosition.x !== actualRect.x || correctedPosition.y !== actualRect.y)) {
      this.waitForGeometry(token, () => {
        this.debugLog('anchor correction settled');
        this.finishResize(token, position, sourceRect, true, skipAnimation);
      });
      this.debugLog(
        `anchor correction request x=${correctedPosition.x} y=${correctedPosition.y}`
      );
      this.window.move_frame(true, correctedPosition.x, correctedPosition.y);
      return;
    }

    this.clearWaitState();
    const settledRect = this.window.get_frame_rect();
    this.position = position;
    this.lastSettledRect = this.copyRect(settledRect);
    if (skipAnimation) {
      this.debugLog(`skip custom animation final=${this.formatRect(settledRect)}`);
      this.animator.cancel();
      this.finishDebugTrace();
      return;
    }

    this.debugLog(`animate start final=${this.formatRect(settledRect)}`);
    this.animator.animate(sourceRect, settledRect, () => {
      this.debugLog('animation complete');
      this.finishDebugTrace();
    });
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
      this.debugLog('waitForGeometry finish');
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
    this.debugLog('waitForGeometry start');
    state.hardTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      GEOMETRY_HARD_TIMEOUT,
      () => {
        state.hardTimeoutId = 0;
        this.debugLog('waitForGeometry hard timeout');
        return finish();
      }
    );

    this.waitState = state;
  }

  private waitForFullyUnmaximized(
    token: number,
    onReady: () => void,
    onAbort: () => void
  ) {
    this.clearMaximizeWaitState();

    const state: MaximizeWaitState = {
      token,
      signalIds: [],
      hardTimeoutId: 0
    };

    const finishIfReady = () => {
      if (this.maximizeWaitState !== state || token !== this.operationToken) {
        return;
      }

      if (this.window.get_maximize_flags() !== 0) {
        return;
      }

      this.debugLog('unmaximize flags clear');
      this.clearMaximizeWaitState();
      onReady();
    };

    state.signalIds.push(
      this.window.connect('notify::maximized-horizontally', finishIfReady)
    );
    state.signalIds.push(
      this.window.connect('notify::maximized-vertically', finishIfReady)
    );

    state.hardTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      MAXIMIZE_STATE_HARD_TIMEOUT,
      () => {
        state.hardTimeoutId = 0;

        if (this.maximizeWaitState !== state || token !== this.operationToken) {
          return GLib.SOURCE_REMOVE;
        }

        if (this.window.get_maximize_flags() === 0) {
          this.clearMaximizeWaitState();
          onReady();
          return GLib.SOURCE_REMOVE;
        }

        this.debugLog('waitForUnmaximized hard timeout');
        console.warn('Sane Tiling: timed out waiting for maximization state to clear');
        this.clearMaximizeWaitState();
        onAbort();
        return GLib.SOURCE_REMOVE;
      }
    );

    this.maximizeWaitState = state;
    this.debugLog(`waitForUnmaximized start flags=${this.window.get_maximize_flags()}`);
    finishIfReady();
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

  private clearMaximizeWaitState() {
    const state = this.maximizeWaitState;
    if (!state) {
      return;
    }

    this.maximizeWaitState = null;

    for (const signalId of state.signalIds) {
      this.window.disconnect(signalId);
    }

    if (state.hardTimeoutId) {
      GLib.source_remove(state.hardTimeoutId);
    }
  }

  private getTargetRect(position: Position) {
    const leftWidth = Math.max(1, Math.floor(this.screen.width / 2));
    const rightWidth = Math.max(1, this.screen.width - leftWidth);
    const topHeight = Math.max(1, Math.floor(this.screen.height / 2));
    const bottomHeight = Math.max(1, this.screen.height - topHeight);
    const rightX = this.screen.x + leftWidth;
    const bottomY = this.screen.y + topHeight;

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

  private startDebugTrace(label: string) {
    if (!this.settings.get_boolean('debug-logging')) {
      this.debugTrace = null;
      return;
    }

    const now = GLib.get_monotonic_time();
    this.debugTrace = {
      label,
      startTime: now,
      lastTime: now
    };

    this.debugLog('start');
  }

  private finishDebugTrace() {
    if (!this.debugTrace) {
      return;
    }

    this.debugLog('finish');
    this.debugTrace = null;
  }

  private debugLog(message: string) {
    if (!this.debugTrace || !this.settings.get_boolean('debug-logging')) {
      return;
    }

    const now = GLib.get_monotonic_time();
    const totalMs = Math.round((now - this.debugTrace.startTime) / 1000);
    const deltaMs = Math.round((now - this.debugTrace.lastTime) / 1000);
    this.debugTrace.lastTime = now;

    console.log(
      `Sane Tiling debug [${this.debugTrace.label}] +${totalMs}ms ` +
      `(${deltaMs}ms): ${message}`
    );
  }

  private formatRect(rect: Mtk.Rectangle) {
    return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
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
