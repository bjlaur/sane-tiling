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

    if (!this.canAnimate(actor, sourceRect, targetRect)) {
      return;
    }

    const duration = AnimationUtils.adjustAnimationTime(ANIMATION_TIME);

    if (duration <= 0) {
      this.resetActor(actor);
      return;
    }

    if (this.isIdentity(actor)) {
      this.setInvertedTransform(actor, sourceRect, targetRect);
    }

    const animationParams = {
      duration,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD
    };

    actor.ease_property('translation-x', 0, animationParams);
    actor.ease_property('translation-y', 0, animationParams);
    actor.ease_property('scale-x', 1, animationParams);
    actor.ease_property('scale-y', 1, {
      ...animationParams,
      onStopped: () => {
        if (token === this.animationToken) {
          this.resetActor(actor);
        }
      }
    });
  }

  prepare(sourceRect: Mtk.Rectangle, targetRect: Mtk.Rectangle) {
    const actor = this.window.get_compositor_private<Meta.WindowActor>();

    this.resetActor(actor);

    if (!this.canAnimate(actor, sourceRect, targetRect) ||
        AnimationUtils.adjustAnimationTime(ANIMATION_TIME) <= 0) {
      return;
    }

    this.setInvertedTransform(actor, sourceRect, targetRect);
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

  private canAnimate(
    actor: Meta.WindowActor | null,
    sourceRect: Mtk.Rectangle,
    targetRect: Mtk.Rectangle
  ) {
    return !!actor &&
      sourceRect.width > 0 &&
      sourceRect.height > 0 &&
      targetRect.width > 0 &&
      targetRect.height > 0;
  }

  private isIdentity(actor: Meta.WindowActor) {
    return actor.translation_x === 0 &&
      actor.translation_y === 0 &&
      actor.scale_x === 1 &&
      actor.scale_y === 1;
  }

  private setInvertedTransform(
    actor: Meta.WindowActor,
    sourceRect: Mtk.Rectangle,
    targetRect: Mtk.Rectangle
  ) {
    actor.set_pivot_point(0, 0);
    actor.translation_x = sourceRect.x - targetRect.x;
    actor.translation_y = sourceRect.y - targetRect.y;
    actor.scale_x = sourceRect.width / targetRect.width;
    actor.scale_y = sourceRect.height / targetRect.height;
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
