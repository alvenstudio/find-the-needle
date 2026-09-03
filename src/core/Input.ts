import { Signal } from './Signals';
import { clamp } from './MathX';

/**
 * Input is expressed as named *actions*, never as raw key codes, so the rest of
 * the game never mentions `KeyW` and rebinding is a one-line change.
 *
 * Look delta accumulates between frames and is drained by the player controller
 * each simulation step, which keeps mouse motion frame-rate independent without
 * the sub-pixel jitter of sampling `movementX` directly in the render loop.
 */
export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'dig'
  | 'interact'
  | 'inspect'
  | 'toolNext'
  | 'toolPrev'
  | 'shop'
  | 'quests'
  | 'map'
  | 'pause';

const DEFAULT_BINDINGS: Record<string, Action> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyE: 'interact',
  KeyF: 'inspect',
  KeyQ: 'toolPrev',
  KeyR: 'toolNext',
  KeyB: 'shop',
  KeyJ: 'quests',
  KeyM: 'map',
  Escape: 'pause',
  Tab: 'map',
};

/** Actions that are also driven by mouse buttons. */
const MOUSE_BINDINGS: Record<number, Action> = {
  0: 'dig',
  2: 'inspect',
};

export interface LookDelta {
  yaw: number;
  pitch: number;
}

export class Input {
  readonly pointerLockChanged = new Signal<boolean>();
  readonly actionPressed = new Signal<Action>();
  readonly actionReleased = new Signal<Action>();
  readonly wheel = new Signal<number>();
  /** 1-9 selects a tool slot directly. */
  readonly slotSelected = new Signal<number>();

  /** Radians of look accumulated since the last drain. */
  private readonly look: LookDelta = { yaw: 0, pitch: 0 };
  private readonly held = new Set<Action>();
  private readonly pressedThisStep = new Set<Action>();
  private readonly releasedThisStep = new Set<Action>();
  private bindings = { ...DEFAULT_BINDINGS };

  /** Radians of yaw per pixel of mouse travel at sensitivity 1. */
  sensitivity = 1;
  invertY = false;
  enabled = true;

  private touchLookId = -1;
  private touchMoveId = -1;
  private readonly touchMoveOrigin = { x: 0, y: 0 };
  private readonly touchMoveVector = { x: 0, y: 0 };
  private touchLookLast = { x: 0, y: 0 };
  hasTouch = false;

  constructor(private readonly element: HTMLElement) {
    this.attach();
  }

  // ---------------------------------------------------------------- queries
  isDown(action: Action): boolean {
    return this.enabled && this.held.has(action);
  }

  /** True only on the simulation step in which the action went down. */
  wasPressed(action: Action): boolean {
    return this.pressedThisStep.has(action);
  }

  wasReleased(action: Action): boolean {
    return this.releasedThisStep.has(action);
  }

  /** Movement intent as a normalised 2-D vector: x = strafe, y = forward. */
  moveVector(out: { x: number; y: number }): { x: number; y: number } {
    if (this.hasTouch && (this.touchMoveVector.x !== 0 || this.touchMoveVector.y !== 0)) {
      out.x = this.touchMoveVector.x;
      out.y = this.touchMoveVector.y;
      return out;
    }
    let x = 0;
    let y = 0;
    if (this.isDown('forward')) y += 1;
    if (this.isDown('back')) y -= 1;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    out.x = x;
    out.y = y;
    return out;
  }

  /** Consume the accumulated look delta. Call once per simulation step. */
  drainLook(out: LookDelta): LookDelta {
    out.yaw = this.look.yaw;
    out.pitch = this.look.pitch;
    this.look.yaw = 0;
    this.look.pitch = 0;
    return out;
  }

  /** Clear per-step edge state. Call at the *end* of a simulation step. */
  endStep(): void {
    this.pressedThisStep.clear();
    this.releasedThisStep.clear();
  }

  // ----------------------------------------------------------- pointer lock
  get isLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  async requestLock(): Promise<void> {
    if (this.isLocked || this.hasTouch) return;
    try {
      await this.element.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions);
    } catch {
      // `unadjustedMovement` is unsupported on some platforms; the plain call
      // still gives us relative motion, just with OS acceleration applied.
      try {
        await this.element.requestPointerLock();
      } catch {
        /* the user gesture was rejected; the caller will retry on next click */
      }
    }
  }

  releaseLock(): void {
    if (this.isLocked) document.exitPointerLock();
  }

  rebind(code: string, action: Action): void {
    this.bindings[code] = action;
  }

  dispose(): void {
    for (const [target, type, handler] of this.listeners) {
      target.removeEventListener(type, handler as EventListener);
    }
    this.listeners.length = 0;
  }

  // -------------------------------------------------------------- internals
  private readonly listeners: [EventTarget, string, (event: never) => void][] = [];

  private listen<K extends keyof WindowEventMap>(
    target: EventTarget,
    type: K | string,
    handler: (event: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler as EventListener, options);
    this.listeners.push([target, type, handler]);
  }

  private press(action: Action): void {
    if (this.held.has(action)) return;
    this.held.add(action);
    this.pressedThisStep.add(action);
    this.actionPressed.emit(action);
  }

  private release(action: Action): void {
    if (!this.held.delete(action)) return;
    this.releasedThisStep.add(action);
    this.actionReleased.emit(action);
  }

  private attach(): void {
    this.listen(window, 'keydown', (event: KeyboardEvent) => {
      if (event.repeat) return;
      const action = this.bindings[event.code];
      if (event.code === 'Tab' || (action && action !== 'pause')) event.preventDefault();
      if (action) this.press(action);
      if (event.code.startsWith('Digit')) {
        const slot = Number(event.code.slice(5));
        if (slot >= 1 && slot <= 9) this.slotSelected.emit(slot - 1);
      }
    });

    this.listen(window, 'keyup', (event: KeyboardEvent) => {
      const action = this.bindings[event.code];
      if (action) this.release(action);
    });

    // A lost focus that leaves keys "stuck down" is the classic browser-game
    // bug; drop everything when the tab or window goes away.
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });

    this.listen(this.element, 'mousedown', (event: MouseEvent) => {
      const action = MOUSE_BINDINGS[event.button];
      if (action) this.press(action);
    });
    this.listen(window, 'mouseup', (event: MouseEvent) => {
      const action = MOUSE_BINDINGS[event.button];
      if (action) this.release(action);
    });
    this.listen(this.element, 'contextmenu', (event: Event) => event.preventDefault());

    this.listen(document, 'mousemove', (event: MouseEvent) => {
      if (!this.isLocked || !this.enabled) return;
      // 0.0022 rad/px at sensitivity 1 matches the de-facto FPS standard of
      // ~0.022 deg per count at 400 DPI.
      const scale = 0.0022 * this.sensitivity;
      this.look.yaw -= event.movementX * scale;
      this.look.pitch += event.movementY * scale * (this.invertY ? 1 : -1);
    });

    this.listen(document, 'pointerlockchange', () => {
      const locked = this.isLocked;
      if (!locked) this.releaseAll();
      this.pointerLockChanged.emit(locked);
    });

    this.listen(
      this.element,
      'wheel',
      (event: WheelEvent) => {
        if (!this.enabled) return;
        event.preventDefault();
        this.wheel.emit(Math.sign(event.deltaY));
      },
      { passive: false },
    );

    this.attachTouch();
  }

  /**
   * Touch: the left half of the screen is a virtual stick, the right half is a
   * look pad, and a tap on the right half also counts as a dig.
   */
  private attachTouch(): void {
    const options: AddEventListenerOptions = { passive: false };

    this.listen(
      this.element,
      'touchstart',
      (event: TouchEvent) => {
        this.hasTouch = true;
        event.preventDefault();
        for (const touch of Array.from(event.changedTouches)) {
          const left = touch.clientX < window.innerWidth * 0.45;
          if (left && this.touchMoveId < 0) {
            this.touchMoveId = touch.identifier;
            this.touchMoveOrigin.x = touch.clientX;
            this.touchMoveOrigin.y = touch.clientY;
          } else if (!left && this.touchLookId < 0) {
            this.touchLookId = touch.identifier;
            this.touchLookLast = { x: touch.clientX, y: touch.clientY };
            this.press('dig');
          }
        }
      },
      options,
    );

    this.listen(
      this.element,
      'touchmove',
      (event: TouchEvent) => {
        event.preventDefault();
        const radius = Math.min(window.innerWidth, window.innerHeight) * 0.13;
        for (const touch of Array.from(event.changedTouches)) {
          if (touch.identifier === this.touchMoveId) {
            this.touchMoveVector.x = clamp((touch.clientX - this.touchMoveOrigin.x) / radius, -1, 1);
            this.touchMoveVector.y = clamp(-(touch.clientY - this.touchMoveOrigin.y) / radius, -1, 1);
          } else if (touch.identifier === this.touchLookId) {
            const scale = 0.0042 * this.sensitivity;
            this.look.yaw -= (touch.clientX - this.touchLookLast.x) * scale;
            this.look.pitch += (touch.clientY - this.touchLookLast.y) * scale * (this.invertY ? 1 : -1);
            this.touchLookLast = { x: touch.clientX, y: touch.clientY };
          }
        }
      },
      options,
    );

    const endTouch = (event: TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) {
        if (touch.identifier === this.touchMoveId) {
          this.touchMoveId = -1;
          this.touchMoveVector.x = this.touchMoveVector.y = 0;
        } else if (touch.identifier === this.touchLookId) {
          this.touchLookId = -1;
          this.release('dig');
        }
      }
    };
    this.listen(this.element, 'touchend', endTouch, options);
    this.listen(this.element, 'touchcancel', endTouch, options);
  }

  private releaseAll(): void {
    for (const action of [...this.held]) this.release(action);
    this.touchMoveVector.x = this.touchMoveVector.y = 0;
    this.touchMoveId = this.touchLookId = -1;
  }
}
