/**
 * Find the Needle - DOM widget kit.
 *
 * A dependency-free toolkit for building the overlay UI. It knows nothing
 * about haystacks, upgrades or three.js: it makes buttons, meters, chips,
 * toasts and dialogs, and the game wires them together. Keeping the split
 * here means the HUD can be restyled or rebuilt without touching gameplay,
 * and gameplay can be unit-tested without a DOM.
 *
 * WHY DOM AND NOT CANVAS
 * ----------------------
 * The renderer already owns a WebGL context running at 60fps. Drawing the UI
 * into the same context means every HUD tweak becomes a texture upload and a
 * draw call; drawing it in DOM hands text shaping, layout, accessibility and
 * input handling to the browser for free. The cost is that careless DOM work
 * lands on the same main thread as the render loop, so every helper in this
 * file follows three rules:
 *
 *   1. **Never read layout.** Nothing here touches `offsetWidth`,
 *      `getBoundingClientRect`, `getComputedStyle` or `scrollTop` outside of
 *      a user-input handler. A single such read forces a synchronous layout
 *      and can cost more than the frame it interrupts.
 *   2. **Animate in CSS, not in JS.** Motion lives in the `ftn-*` keyframes
 *      in `styles.css` and is triggered by adding a class. The compositor
 *      runs transform/opacity keyframes off the main thread entirely. The one
 *      exception is the chip's rolling number, which is a text change and
 *      therefore cannot be done in CSS - so it uses a single rAF tween that
 *      *stops when it arrives* rather than an always-on loop.
 *   3. **Pool, don't churn.** `PopupLayer` and `ToastStack` recycle their
 *      nodes. A crit-heavy dig can spawn a dozen "+N" popups a second; at
 *      that rate create/destroy is a steady drip of GC pressure landing in
 *      the middle of frames.
 *
 * ACCESSIBILITY
 * -------------
 * Everything clickable is a real `<button>`, every slider is a real
 * `<input type="range">` with an associated `<label>`, and every toggle is a
 * real checkbox that is visually replaced but never removed from the tab
 * order. Modals are `role="dialog"` + `aria-modal`, trap focus while open and
 * restore it on close. This is cheaper to do up front than to retrofit, and
 * it is also what makes the UI keyboard-playable, which matters for a game
 * that otherwise swallows the mouse into pointer lock.
 */

/* ------------------------------------------------------------------ types */

/** Anything that can be handed to `el` as a child. */
export type ElChild = Node | string | null | false | undefined;

/** One child, a list of children, or a bare string. */
export type ElChildren = ElChild[] | Node | string;

/**
 * Props accepted by {@link el}.
 *
 * The bulk is `Partial<>` of the real element interface, so `textContent`,
 * `disabled`, `htmlFor`, `value` and friends are all set as properties with
 * full type checking. Four keys are handled specially because the property
 * assignment would be wrong or impossible:
 *
 * - `onClick` - attaches a listener instead of overwriting `onclick`, so
 *   several sources can subscribe to the same element.
 * - `dataset` / `attrs` - merged rather than replaced.
 * - `style` - merged into the existing `CSSStyleDeclaration`; assigning to
 *   `.style` directly is not possible in every engine.
 */
export type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<
    HTMLElementTagNameMap[K],
    'style' | 'dataset' | 'classList' | 'children' | 'childNodes' | 'attributes'
  >
> & {
  onClick?: (event: MouseEvent) => void;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
};

interface ParsedSpec {
  tag: string;
  id: string | undefined;
  classes: string;
}

/* -------------------------------------------------------------- internals */

/**
 * Parsed element specs are cached. Panels rebuild their contents on every
 * open, and the same three dozen strings get parsed over and over; the map
 * turns that into a hash lookup. Specs are compile-time literals, so the map
 * is bounded by the size of the source, not by runtime input.
 */
const SPEC_CACHE = new Map<string, ParsedSpec>();

let uidCounter = 0;

/** Unique, stable-ish ids for label/control association. */
function uid(prefix: string): string {
  uidCounter += 1;
  return `ftn-${prefix}-${uidCounter}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * `Animation` does not expose the source keyframe name in the standard type,
 * but every engine that implements CSS animations exposes it on the
 * `CSSAnimation` subclass. Declaring it as optional lets us identify our own
 * animation without a lib-version-dependent `instanceof CSSAnimation`.
 */
interface NamedAnimation extends Animation {
  readonly animationName?: string;
}

/**
 * Play a one-shot CSS animation by class, and clean the class up afterwards.
 *
 * The usual way to replay a CSS animation - remove the class, read
 * `offsetWidth` to force a reflow, add it back - costs a synchronous layout
 * every time. Here, if the animation is already running we simply rewind it
 * through the Web Animations API, which is both cheaper and better defined.
 * That matters because `chip.flash()` fires on every coin pickup.
 */
function playAnimation(node: HTMLElement, className: string, keyframeName: string): void {
  if (node.classList.contains(className)) {
    for (const animation of node.getAnimations()) {
      const named = animation as NamedAnimation;
      if (named.animationName === keyframeName) {
        named.currentTime = 0;
        return;
      }
    }
  }

  // `animationend` bubbles, so a child's animation would otherwise strip the
  // class off the parent mid-flight. Both the target and the name are checked.
  const onEnd = (event: AnimationEvent): void => {
    if (event.target !== node || event.animationName !== keyframeName) return;
    node.removeEventListener('animationend', onEnd);
    node.removeEventListener('animationcancel', onEnd);
    node.classList.remove(className);
  };
  node.addEventListener('animationend', onEnd);
  node.addEventListener('animationcancel', onEnd);
  node.classList.add(className);
}

function parseSpec(spec: string): ParsedSpec {
  const cached = SPEC_CACHE.get(spec);
  if (cached !== undefined) return cached;

  let tag = '';
  let id: string | undefined;
  const classes: string[] = [];
  let buffer = '';
  // 0 = reading the tag, 1 = reading an id, 2 = reading a class.
  let mode = 0;

  const flush = (): void => {
    if (buffer === '') return;
    if (mode === 0) tag = buffer;
    else if (mode === 1) id = buffer;
    else classes.push(buffer);
    buffer = '';
  };

  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec.charAt(i);
    if (ch === '.') {
      flush();
      mode = 2;
    } else if (ch === '#') {
      flush();
      mode = 1;
    } else {
      buffer += ch;
    }
  }
  flush();

  const parsed: ParsedSpec = {
    tag: tag === '' ? 'div' : tag,
    id,
    classes: classes.join(' '),
  };
  SPEC_CACHE.set(spec, parsed);
  return parsed;
}

function applyProps(node: HTMLElement, props: object): void {
  const bag = props as unknown as Record<string, unknown>;
  const target = node as unknown as Record<string, unknown>;

  for (const key in bag) {
    const value = bag[key];
    // `undefined` means "not supplied". Writing it would clobber a default
    // (`textContent = undefined` stringifies to "undefined" in some paths).
    if (value === undefined) continue;

    if (key === 'onClick') {
      node.addEventListener('click', value as (event: MouseEvent) => void);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value as Record<string, string>);
    } else if (key === 'attrs') {
      const attrs = value as Record<string, string>;
      for (const name in attrs) node.setAttribute(name, attrs[name] as string);
    } else if (key === 'style') {
      Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
    } else if (key === 'className') {
      // Additive, so `el('div.panel', { className: extra })` keeps `.panel`.
      const extra = String(value);
      node.className = node.className === '' ? extra : `${node.className} ${extra}`;
    } else {
      target[key] = value;
    }
  }
}

function appendChildren(node: HTMLElement, children: ElChildren): void {
  if (typeof children === 'string') {
    node.appendChild(document.createTextNode(children));
    return;
  }
  if (children instanceof Node) {
    node.appendChild(children);
    return;
  }

  // A fragment turns N insertions into one, which matters for a shop list
  // that rebuilds forty rows at a time.
  const fragment = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    fragment.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  node.appendChild(fragment);
}

/* ------------------------------------------------------------ hyperscript */

/**
 * Terse element construction.
 *
 * ```ts
 * el('div.panel.panel--wide', { onClick }, [child, 'text'])
 * el<'button'>('button.btn.btn--primary', { type: 'button', disabled: true })
 * el('span#hud-money.chip__value')
 * ```
 *
 * The tag defaults to `div`, so `el('.panel')` and `el('div.panel')` are the
 * same thing. Pass the tag as a type argument when you need the specific
 * element type back (`el<'input'>(...)` returns `HTMLInputElement`); the
 * runtime string is what actually creates the node, the type argument only
 * tells the compiler what to expect.
 *
 * There is no template parsing, no diffing and no reactivity here on purpose.
 * The HUD updates a handful of text nodes per frame through the handles
 * returned by `meter`/`chip`; the panels rebuild wholesale when they open,
 * which happens at most a few times a minute. Neither case is improved by a
 * virtual DOM, and both are made slower by one.
 */
export function el<K extends keyof HTMLElementTagNameMap = 'div'>(
  spec: string,
  props?: ElProps<K>,
  children?: ElChildren,
): HTMLElementTagNameMap[K] {
  const parsed = parseSpec(spec);
  const node = document.createElement(parsed.tag) as HTMLElementTagNameMap[K];
  if (parsed.id !== undefined) node.id = parsed.id;
  if (parsed.classes !== '') node.className = parsed.classes;
  if (props !== undefined) applyProps(node, props);
  if (children !== undefined) appendChildren(node, children);
  return node;
}

/**
 * Detach every child in one operation.
 *
 * `replaceChildren()` beats both `innerHTML = ''` (which re-enters the HTML
 * parser) and a `removeChild` loop (which touches the tree once per node).
 */
export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/**
 * Set text, skipping the write when it would not change anything.
 *
 * Reading `textContent` does not force layout, but writing it always dirties
 * the node and invalidates style for its subtree. HUD code calls this from
 * the frame loop with a value that is usually identical to last frame's, so
 * the comparison pays for itself many times over.
 */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** `classList.toggle` with an explicit state, for symmetry with `setText`. */
export function toggleClass(node: HTMLElement, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}

/* -------------------------------------------------------------- numbers -- */

/**
 * Short-scale suffixes. The game's late tiers deal in quadrillions of straws,
 * and "1.24Qa" fits in a HUD chip where "1,240,000,000,000,000" does not.
 * Beyond decillion the number is simply left long - if the balance ever gets
 * there, the balance is the bug.
 */
const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'] as const;

function trimTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === '0') end -= 1;
  if (end > 0 && text.charAt(end - 1) === '.') end -= 1;
  return text.slice(0, end);
}

/**
 * Compact number formatting shared by the whole HUD. `1234` -> `"1.23K"`.
 *
 * Two deliberate choices:
 *
 * - **Values below 1000 are floored to an integer.** Currency is conceptually
 *   whole coins; showing "12.4" coins invites the question of what a tenth of
 *   a coin is.
 * - **The mantissa is truncated, not rounded.** Rounding 999,999 to two
 *   decimals yields "1000.00K": wrong-looking, one character wider than the
 *   layout budgeted, and it briefly shows a number the player does not have.
 *   Truncation always errs downwards, so a displayed cost is never one the
 *   player cannot actually afford.
 */
export function formatShort(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '0';

  const negative = value < 0;
  let scaled = Math.abs(value);
  const sign = negative ? '-' : '';

  if (scaled < 1000) return `${sign}${Math.floor(scaled)}`;

  let tier = 0;
  while (scaled >= 1000 && tier < SUFFIXES.length - 1) {
    scaled /= 1000;
    tier += 1;
  }

  const factor = 10 ** precision;
  const truncated = Math.floor(scaled * factor) / factor;
  return `${sign}${trimTrailingZeros(truncated.toFixed(precision))}${SUFFIXES[tier] ?? ''}`;
}

/* --------------------------------------------------------------- meters -- */

export interface MeterOptions {
  label?: string;
  className?: string;
}

export interface MeterHandle {
  /** The `.meter` element, ready to be placed. */
  root: HTMLElement;
  /**
   * @param fraction 0..1, clamped. Values outside the range are safe.
   * @param text Optional readout ("12 / 40"). Left alone when omitted.
   */
  set(fraction: number, text?: string): void;
}

/**
 * A labelled progress meter - the backpack bar, the stack bar, quest
 * progress.
 *
 * The fill is driven by `transform: scaleX()`, never by `width`. Width is a
 * layout property: animating it on a bar that updates every frame would
 * relayout the surrounding HUD sixty times a second, right next to a renderer
 * that needs those milliseconds. Transform is composited and costs nothing on
 * the main thread.
 *
 * Values are quantised to 0.1% before anything is written, because callers
 * feed this from the frame loop and a change smaller than that is invisible
 * on any bar narrower than a thousand pixels.
 */
export function meter(options: MeterOptions): MeterHandle {
  const fill = el('div.meter__fill');
  const track = el('div.meter__track', undefined, fill);
  const labelNode = el('span.meter__label', { textContent: options.label ?? '' });
  const textNode = el('span.meter__text');

  const root = el(
    'div.meter',
    {
      className: options.className,
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '0',
      },
    },
    [el('div.meter__head', undefined, [labelNode, textNode]), track],
  );
  if (options.label !== undefined) root.setAttribute('aria-label', options.label);

  let lastPermille = -1;

  return {
    root,
    set(fraction: number, text?: string): void {
      const clamped = clamp01(fraction);
      const permille = Math.round(clamped * 1000);
      if (permille !== lastPermille) {
        lastPermille = permille;
        const exact = permille / 1000;
        fill.style.transform = `scaleX(${exact})`;
        root.setAttribute('aria-valuenow', String(Math.round(exact * 100)));
        // Two states rather than one: "nearly full" is a warning, "full" is a
        // failure the player is actively losing value to.
        toggleClass(root, 'meter--warn', exact >= 0.85 && exact < 1);
        toggleClass(root, 'meter--full', exact >= 1);
      }
      if (text !== undefined) setText(textNode, text);
    },
  };
}

/* ---------------------------------------------------------------- chips -- */

export interface ChipOptions {
  /** A glyph or emoji. Marked `aria-hidden`; the value carries the meaning. */
  icon: string;
  className?: string;
}

export interface ChipHandle {
  root: HTMLElement;
  /** Tween to `value`. The first call snaps, so the HUD does not roll up from zero on load. */
  set(value: number): void;
  /** Replay the pop. Called automatically by `set` when the value increases. */
  flash(): void;
}

/** Rolling-counter duration. Long enough to read as motion, short enough that
 *  a rapid sequence of pickups still lands on the right number promptly. */
const CHIP_TWEEN_MS = 280;

/**
 * A currency readout: icon plus an animated rolling number.
 *
 * The number is the one thing in this kit that genuinely cannot be a CSS
 * animation - it is a text change, not a style change - so it gets a rAF
 * tween. The important property is that the tween **stops**: `raf` is reset
 * to 0 on arrival and only re-requested when the target actually moves. A
 * chip that is not changing costs exactly nothing per frame, which is the
 * difference between four idle chips and four permanent rAF callbacks
 * fighting the renderer for the frame budget.
 *
 * No `aria-live` region: a counter that ticks on every coin would make the
 * game unusable with a screen reader. The current value is always present in
 * the DOM for on-demand reading.
 */
export function chip(options: ChipOptions): ChipHandle {
  const iconNode = el('span.chip__icon', {
    textContent: options.icon,
    attrs: { 'aria-hidden': 'true' },
  });
  const valueNode = el('span.chip__value', { textContent: '0' });
  const root = el('div.chip', { className: options.className }, [iconNode, valueNode]);

  let displayed = 0;
  let from = 0;
  let target = 0;
  let startTime = -1;
  let raf = 0;
  let primed = false;

  const step = (now: number): void => {
    // The start time is captured inside the callback so it shares rAF's clock
    // exactly, rather than being read from a possibly different time origin.
    if (startTime < 0) startTime = now;
    const t = Math.min(1, (now - startTime) / CHIP_TWEEN_MS);
    // easeOutCubic: most of the distance is covered immediately, so the
    // number reads as "it went up" rather than "it is still going up".
    const eased = 1 - (1 - t) ** 3;
    displayed = from + (target - from) * eased;

    if (t >= 1) {
      displayed = target;
      raf = 0;
      setText(valueNode, formatShort(displayed));
      return;
    }
    setText(valueNode, formatShort(displayed));
    raf = requestAnimationFrame(step);
  };

  const flash = (): void => {
    playAnimation(root, 'chip--flash', 'ftn-pop');
  };

  return {
    root,
    flash,
    set(value: number): void {
      if (!Number.isFinite(value)) return;

      if (!primed) {
        // First paint is the loaded save, not an achievement. Snap.
        primed = true;
        displayed = value;
        from = value;
        target = value;
        setText(valueNode, formatShort(value));
        return;
      }
      if (value === target) return;

      if (value > target) flash();
      from = displayed;
      target = value;
      startTime = -1;
      if (raf === 0) raf = requestAnimationFrame(step);
    },
  };
}

/* -------------------------------------------------------------- controls */

export type ButtonVariant = 'primary' | 'buy' | 'danger' | 'ghost';

/**
 * A real `<button>`, always `type="button"`.
 *
 * The explicit type is not pedantry: a bare `<button>` defaults to `submit`,
 * and the day someone wraps a settings panel in a `<form>` every button in it
 * starts reloading the page mid-game.
 *
 * Focus is deliberately *not* dropped after a click. It is tempting - a
 * focused button means the next Space press activates it instead of jumping -
 * but blurring breaks keyboard navigation entirely. The game's input layer is
 * the right place to ignore keys while `document.activeElement` is a control.
 */
export function button(label: string, onClick: () => void, variant: ButtonVariant = 'primary'): HTMLButtonElement {
  const node = el<'button'>(`button.btn.btn--${variant}`, {
    type: 'button',
    textContent: label,
  });
  node.addEventListener('click', () => {
    if (node.disabled) return;
    onClick();
  });
  return node;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Turns the raw number into a readout, e.g. `(v) => `${Math.round(v * 100)}%``. */
  format?: (value: number) => string;
  onInput: (value: number) => void;
}

/**
 * A labelled range slider.
 *
 * It is a genuine `<input type="range">` with a genuine `<label for>`, which
 * buys keyboard stepping, screen-reader announcement, touch handling and
 * platform conventions for nothing. The custom look is entirely CSS.
 *
 * The filled portion of the track is a gradient stop driven by the `--fill`
 * custom property (0..1). That means one property write per input event - no
 * extra elements, no measurement, and the browser interpolates nothing.
 */
export function slider(options: SliderOptions): HTMLElement {
  const id = uid('slider');
  const format = options.format ?? ((value: number): string => String(value));

  const input = el<'input'>('input.slider__input', {
    type: 'range',
    id,
    min: String(options.min),
    max: String(options.max),
    step: String(options.step),
    value: String(options.value),
  });
  const labelNode = el<'label'>('label.slider__label', {
    htmlFor: id,
    textContent: options.label,
  });
  const valueNode = el('span.slider__value');
  const root = el('div.slider', undefined, [labelNode, valueNode, input]);

  const sync = (value: number): void => {
    setText(valueNode, format(value));
    const span = options.max - options.min;
    input.style.setProperty('--fill', String(clamp01(span === 0 ? 0 : (value - options.min) / span)));
  };

  input.addEventListener('input', () => {
    const value = Number(input.value);
    sync(value);
    options.onInput(value);
  });

  sync(options.value);
  return root;
}

export interface ToggleOptions {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

/**
 * A switch backed by a real checkbox.
 *
 * The input is moved off-screen with a clip rather than `display: none`. That
 * distinction is the whole accessibility story for custom switches: a
 * `display: none` input is removed from the tab order and from the
 * accessibility tree, so the control becomes invisible to keyboards and
 * screen readers while looking perfectly fine. Clipped, it stays focusable,
 * and `:checked`/`:focus-visible` sibling selectors drive the visuals.
 */
export function toggle(options: ToggleOptions): HTMLElement {
  const id = uid('toggle');
  const input = el<'input'>('input.toggle__input', {
    type: 'checkbox',
    id,
    checked: options.value,
  });
  // Sibling order matters: the CSS reaches the track via `.toggle__input:checked + .toggle__track`.
  const track = el('span.toggle__track', undefined, el('span.toggle__knob'));
  const labelNode = el('span.toggle__label', { textContent: options.label });
  const root = el<'label'>('label.toggle', { htmlFor: id }, [labelNode, input, track]);

  input.addEventListener('change', () => {
    options.onChange(input.checked);
  });

  return root;
}

export interface TabItem {
  id: string;
  label: string;
}

export interface TabsHandle {
  root: HTMLElement;
  /** Switch tabs programmatically. Fires `onSelect`; a no-op if already selected. */
  select(id: string): void;
}

/**
 * A tab bar using the roving-tabindex pattern.
 *
 * Only the active tab is in the tab order; Left/Right/Home/End move between
 * them. That is the ARIA authoring-practices behaviour for a tablist, and it
 * means a keyboard user tabs *past* the whole bar in one press instead of
 * stepping through five buttons to reach the panel content.
 *
 * The initial tab is selected without firing `onSelect`, so construction has
 * no side effects: the caller has not stored the handle yet and its handler
 * may not be ready to run.
 */
export function tabs(items: TabItem[], onSelect: (id: string) => void): TabsHandle {
  const buttons = new Map<string, HTMLButtonElement>();
  const order = items.map((item) => item.id);
  const root = el('div.tabs', { attrs: { role: 'tablist' } });
  let current = '';

  const apply = (id: string, notify: boolean): void => {
    // The early return also makes `select` re-entrancy-safe: a handler that
    // calls back into `select` with the same id cannot loop.
    if (id === current) return;
    const next = buttons.get(id);
    if (next === undefined) return;

    const previous = buttons.get(current);
    if (previous !== undefined) {
      previous.classList.remove('tab--active');
      previous.setAttribute('aria-selected', 'false');
      previous.tabIndex = -1;
    }
    next.classList.add('tab--active');
    next.setAttribute('aria-selected', 'true');
    next.tabIndex = 0;
    current = id;
    if (notify) onSelect(id);
  };

  for (const item of items) {
    const node = el<'button'>('button.tab', {
      type: 'button',
      textContent: item.label,
      attrs: { role: 'tab', 'aria-selected': 'false' },
    });
    node.tabIndex = -1;
    node.addEventListener('click', () => apply(item.id, true));
    buttons.set(item.id, node);
    root.appendChild(node);
  }

  root.addEventListener('keydown', (event: KeyboardEvent) => {
    const { key } = event;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    if (order.length === 0) return;
    event.preventDefault();

    const at = order.indexOf(current);
    let index: number;
    if (key === 'Home') index = 0;
    else if (key === 'End') index = order.length - 1;
    else if (key === 'ArrowLeft') index = (at - 1 + order.length) % order.length;
    else index = (at + 1) % order.length;

    const id = order[index];
    if (id === undefined) return;
    apply(id, true);
    buttons.get(id)?.focus();
  });

  const first = order[0];
  if (first !== undefined) apply(first, false);

  return {
    root,
    select(id: string): void {
      apply(id, true);
    },
  };
}

/* --------------------------------------------------------------- toasts -- */

export type ToastTone = 'info' | 'good' | 'bad';

export interface ToastOptions {
  icon?: string;
  tone?: ToastTone;
  /** Visible duration in milliseconds before the exit animation starts. */
  ms?: number;
}

interface PooledToast {
  root: HTMLElement;
  icon: HTMLElement;
  message: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}

const TOAST_DEFAULT_MS = 2600;
/** Beyond this the stack becomes a wall; the oldest is retired early. */
const TOAST_MAX_VISIBLE = 4;
/** Safety net for the exit animation. Must exceed `--dur-toast` in styles.css. */
const TOAST_EXIT_MS = 400;

/**
 * A stack of transient notifications in the corner of the screen.
 *
 * Nodes are pooled. Toasts fire on sells, unlocks, quest completions and
 * treasure finds - a burst of five in a second is normal - and creating and
 * discarding five element trees per second is a steady GC drip landing inside
 * frames. The pool is capped so a pathological burst does not permanently
 * retain a hundred nodes.
 *
 * The container is an `aria-live` region, so the messages are announced. That
 * is the whole reason toasts are readable text rather than icons.
 */
export class ToastStack {
  private readonly root: HTMLElement;
  private readonly pool: PooledToast[] = [];
  private readonly live: PooledToast[] = [];
  private disposed = false;

  constructor(parent: HTMLElement) {
    this.root = el('div.toasts', {
      attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
    });
    parent.appendChild(this.root);
  }

  push(message: string, options?: ToastOptions): void {
    if (this.disposed) return;

    // Retire from the front: the oldest toast has had the most screen time.
    while (this.live.length >= TOAST_MAX_VISIBLE) {
      const oldest = this.live[0];
      if (oldest === undefined) break;
      this.retire(oldest);
    }

    const toast = this.acquire();
    const icon = options?.icon;
    const tone = options?.tone ?? 'info';

    toast.root.className = `toast toast--${tone}`;
    if (icon === undefined || icon === '') {
      toast.icon.hidden = true;
      setText(toast.icon, '');
    } else {
      toast.icon.hidden = false;
      setText(toast.icon, icon);
    }
    setText(toast.message, message);

    this.live.push(toast);
    this.root.appendChild(toast.root);

    toast.timer = setTimeout(() => {
      toast.timer = null;
      this.retire(toast);
    }, options?.ms ?? TOAST_DEFAULT_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const toast of this.live) {
      if (toast.timer !== null) clearTimeout(toast.timer);
    }
    this.live.length = 0;
    this.pool.length = 0;
    this.root.remove();
  }

  private acquire(): PooledToast {
    const reused = this.pool.pop();
    if (reused !== undefined) return reused;

    const icon = el('span.toast__icon', { attrs: { 'aria-hidden': 'true' } });
    const message = el('span.toast__msg');
    const root = el('div.toast', undefined, [icon, message]);
    return { root, icon, message, timer: null };
  }

  /**
   * Start the exit animation and recycle afterwards.
   *
   * The node leaves `live` immediately so the visible count stays honest
   * while it animates out; the actual DOM removal waits for `animationend`,
   * with a timer as a fallback because animations do not fire in a
   * backgrounded tab and the pool would otherwise leak.
   */
  private retire(toast: PooledToast): void {
    const index = this.live.indexOf(toast);
    if (index < 0) return;
    this.live.splice(index, 1);

    if (toast.timer !== null) {
      clearTimeout(toast.timer);
      toast.timer = null;
    }

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (toast.timer !== null) {
        clearTimeout(toast.timer);
        toast.timer = null;
      }
      toast.root.removeEventListener('animationend', onEnd);
      toast.root.remove();
      toast.root.className = 'toast';
      if (!this.disposed && this.pool.length < TOAST_MAX_VISIBLE * 3) this.pool.push(toast);
    };
    const onEnd = (event: AnimationEvent): void => {
      if (event.target !== toast.root) return;
      finish();
    };

    toast.root.addEventListener('animationend', onEnd);
    toast.root.classList.add('toast--out');
    toast.timer = setTimeout(finish, TOAST_EXIT_MS);
  }
}

/* --------------------------------------------------------------- popups -- */

export interface PopupOptions {
  /** Extra class for colour, e.g. `popup--money`, `popup--gem`, `popup--big`. */
  className?: string;
  /** Lifetime override in milliseconds. Defaults to the CSS animation length. */
  ms?: number;
}

interface PooledPopup {
  root: HTMLElement;
  inner: HTMLElement;
  /** rAF-clock timestamp of the last release, for the same-frame reuse guard. */
  releasedAt: number;
}

const POPUP_POOL_MAX = 48;

/**
 * World-anchored "+12" popups.
 *
 * The caller projects a world position to viewport pixels and calls `spawn`;
 * everything after that is CSS. The node has two levels for a reason:
 *
 *   - the outer `.popup` carries **position** (`translate3d`, written once at
 *     spawn), and
 *   - the inner `.popup__inner` carries **motion** (the `ftn-float-up`
 *     keyframes).
 *
 * Both are transforms, and a single element cannot hold two independent ones.
 * Splitting them means the rise-and-fade runs entirely on the compositor
 * while JS touches the DOM exactly once per popup. The alternative - updating
 * a position every frame from JS - is what makes damage numbers in browser
 * games stutter.
 *
 * Popups are decorative and never focusable or announced; the authoritative
 * numbers live in the HUD chips.
 */
export class PopupLayer {
  private readonly root: HTMLElement;
  private readonly pool: PooledPopup[] = [];
  private disposed = false;

  constructor(parent: HTMLElement) {
    this.root = el('div.popups', { attrs: { 'aria-hidden': 'true' } });
    parent.appendChild(this.root);
  }

  /** @param x @param y Viewport pixels; the text is centred horizontally on the point. */
  spawn(x: number, y: number, text: string, options?: PopupOptions): void {
    if (this.disposed) return;

    const popup = this.acquire();
    const className = options?.className;
    popup.root.className = className === undefined ? 'popup' : `popup ${className}`;
    // Whole pixels: sub-pixel offsets re-rasterise the glyphs for no visible
    // gain, and these spawn in bursts.
    popup.root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    popup.inner.style.animationDuration = options?.ms === undefined ? '' : `${options.ms}ms`;
    setText(popup.inner, text);

    // Un-hiding is what starts the animation: an element in `display: none`
    // has no running animations, so revealing it always plays from frame one.
    // No class juggling, no forced reflow.
    popup.root.hidden = false;
    this.root.appendChild(popup.root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.length = 0;
    this.root.remove();
  }

  private acquire(): PooledPopup {
    const head = this.pool[0];
    // A node released during this same frame has not had its `hidden` state
    // observed by style resolution yet, so re-showing it would not restart the
    // animation and the popup would never appear. Cheaper to build a new one.
    if (head !== undefined && performance.now() - head.releasedAt > 20) {
      this.pool.shift();
      return head;
    }

    const inner = el('span.popup__inner');
    const root = el('div.popup', undefined, inner);
    const popup: PooledPopup = { root, inner, releasedAt: 0 };

    // One listener for the life of the node, attached here rather than per
    // spawn. `ftn-float-up` is the only animation on the subtree, so no name
    // check is needed.
    root.addEventListener('animationend', () => {
      root.hidden = true;
      root.remove();
      popup.releasedAt = performance.now();
      if (!this.disposed && this.pool.length < POPUP_POOL_MAX) this.pool.push(popup);
    });

    return popup;
  }
}

/* ---------------------------------------------------------------- modal -- */

export interface ModalOptions {
  title: string;
  /**
   * Called when the player asks to close: Escape, the close button, or a
   * click on the scrim. The modal does **not** close itself in response - the
   * owner decides, because closing usually has to be coordinated with
   * releasing pointer lock, unpausing, or saving. Call `close()` from here.
   */
  onClose: () => void;
  wide?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * A modal dialog: scrim, header, optional tab bar, scrolling body, footer.
 *
 * DESIGN NOTES
 * ------------
 * * **Mounted on open, removed on close.** Keeping a dozen dormant panels in
 *   the tree costs style recalculation on every class change elsewhere, and
 *   re-inserting the node guarantees the entrance animation replays without
 *   any reflow trickery.
 * * **Focus is trapped, then restored.** Tab cycles inside the dialog and the
 *   previously focused element gets focus back on close. Without the restore,
 *   dismissing a shop drops focus to `<body>` and the next Tab starts from
 *   the top of the document.
 * * **Escape is handled at the document, in the capture phase.** The game
 *   binds its own global Escape (for the pause menu). Capturing here means an
 *   open dialog consumes it first and the player does not get a pause menu
 *   stacked on top of a shop.
 * * **The scrim closes on `mousedown`, not `click`.** Otherwise a text drag
 *   that starts inside the panel and releases outside it counts as a click on
 *   the scrim and throws the dialog away mid-sentence.
 */
export class Modal {
  /** The scrim. This is what gets mounted; the dialog is inside it. */
  readonly root: HTMLElement;
  /** The scrolling content area. Fill this. */
  readonly body: HTMLElement;
  /** The dialog card itself, for callers that need to reach the chrome. */
  readonly panel: HTMLElement;
  /** Right-aligned action row below the body. Empty by default. */
  readonly footer: HTMLElement;

  private readonly parent: HTMLElement;
  private readonly titleNode: HTMLElement;
  private readonly header: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly requestClose: () => void;
  private tabsNode: HTMLElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private open_ = false;
  private disposed = false;

  constructor(parent: HTMLElement, options: ModalOptions) {
    this.parent = parent;
    this.requestClose = options.onClose;

    const titleId = uid('modal-title');
    this.titleNode = el('h2.modal__title', { id: titleId, textContent: options.title });
    this.closeButton = el<'button'>('button.btn.btn--ghost.btn--icon.modal__close', {
      type: 'button',
      textContent: '✕',
      attrs: { 'aria-label': 'Close' },
    });
    this.closeButton.addEventListener('click', () => this.requestClose());

    this.header = el('div.modal__header', undefined, [this.titleNode, this.closeButton]);
    this.body = el('div.modal__body');
    this.footer = el('div.modal__footer.u-hidden');

    this.panel = el(
      'div.panel.modal',
      {
        className: options.wide === true ? 'modal--wide' : undefined,
        // `tabindex="-1"` makes the card itself focusable so `open()` can put
        // focus inside the dialog without landing on a destructive control.
        tabIndex: -1,
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
        },
      },
      [this.header, this.body, this.footer],
    );

    this.root = el('div.modal-scrim', undefined, this.panel);
    this.root.addEventListener('mousedown', (event: MouseEvent) => {
      if (event.target === this.root) this.requestClose();
    });
  }

  setTitle(title: string): void {
    setText(this.titleNode, title);
  }

  /** Mount (or remove) a tab bar between the header and the body. */
  setTabs(node: HTMLElement | null): void {
    if (this.tabsNode !== null) this.tabsNode.remove();
    this.tabsNode = node;
    if (node === null) return;
    node.classList.add('modal__tabs');
    this.header.after(node);
  }

  /** Show or hide the footer action row. */
  setFooterVisible(visible: boolean): void {
    toggleClass(this.footer, 'u-hidden', !visible);
  }

  open(): void {
    if (this.open_ || this.disposed) return;
    this.open_ = true;

    const active = document.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;

    this.parent.appendChild(this.root);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.panel.focus();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;

    document.removeEventListener('keydown', this.onKeyDown, true);
    this.root.remove();

    const restore = this.previousFocus;
    this.previousFocus = null;
    // `isConnected` guards the case where the panel that opened this dialog
    // was itself rebuilt while it was open.
    if (restore !== null && restore.isConnected) restore.focus();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    clear(this.body);
    this.root.remove();
  }

  /**
   * Arrow-free focus trap. Only Tab and Escape are intercepted; everything
   * else falls through so text inputs still work.
   *
   * The focusable list is re-queried on each Tab rather than cached, because
   * panel contents change while the dialog is open (a purchase can disable a
   * buy button). It deliberately does not filter by visibility: that would
   * require reading layout, and the only way to hit the edge case is to leave
   * a `display: none` button in the dialog.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open_) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.requestClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(this.panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      this.panel.focus();
      return;
    }

    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    const active = document.activeElement;

    if (event.shiftKey) {
      // The panel itself counts as "before the first control": on open, focus
      // sits on the card, and Shift+Tab should wrap to the end.
      if (active === first || active === this.panel) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
