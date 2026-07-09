import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';

const ANIMATION_TIME = 250;

export default class SnapAnimator {
  private window: Meta.Window;
  private animationToken = 0;

  constructor(window: Meta.Window) {
    this.window = window;
  }

  captureVisualRect() {
    const rect = this.window.get_frame_rect();
    const actor = this.window.get_compositor_private<Meta.WindowActor>();

    if (!actor) {
      return this.copyRect(rect);
    }

    return new Mtk.Rectangle({
      x: Math.round(rect.x + actor.translation_x),
      y: Math.round(rect.y + actor.translation_y),
      width: Math.max(1, Math.round(rect.width * actor.scale_x)),
      height: Math.max(1, Math.round(rect.height * actor.scale_y))
    });
  }

  animate(sourceRect: Mtk.Rectangle, targetRect: Mtk.Rectangle) {
    const actor = this.window.get_compositor_private<Meta.WindowActor>();
    const token = ++this.animationToken;

    this.resetActor(actor);

    if (!actor || sourceRect.width <= 0 || sourceRect.height <= 0 ||
        targetRect.width <= 0 || targetRect.height <= 0) {
      return;
    }

    const duration = AnimationUtils.adjustAnimationTime(ANIMATION_TIME);

    if (duration <= 0) {
      return;
    }

    actor.set_pivot_point(0, 0);
    actor.translation_x = sourceRect.x - targetRect.x;
    actor.translation_y = sourceRect.y - targetRect.y;
    actor.scale_x = sourceRect.width / targetRect.width;
    actor.scale_y = sourceRect.height / targetRect.height;

    actor.ease({
      translationX: 0,
      translationY: 0,
      scaleX: 1,
      scaleY: 1,
      duration,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onStopped: () => {
        if (token === this.animationToken) {
          this.resetActor(actor);
        }
      }
    });
  }

  cancel() {
    this.animationToken++;
    this.resetActor(this.window.get_compositor_private<Meta.WindowActor>());
  }

  destroy() {
    this.cancel();
  }

  private resetActor(actor: Meta.WindowActor | null) {
    if (!actor) {
      return;
    }

    actor.remove_transition('translation-x');
    actor.remove_transition('translation-y');
    actor.remove_transition('scale-x');
    actor.remove_transition('scale-y');
    actor.translation_x = 0;
    actor.translation_y = 0;
    actor.scale_x = 1;
    actor.scale_y = 1;
    actor.set_pivot_point(0, 0);
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
