import './devconsole.css';

/**
 * The admin console.
 *
 * One panel, opened with `~`, that can reach anything the game can do: jump
 * between stacks, print money, max the shop, dig the pile to an exact
 * percentage, walk through walls, find the needle. It exists so a build can be
 * checked end to end in a minute instead of an hour, and so a bug report that
 * says "on the fourth stack, with the vacuum" can be reproduced in two clicks.
 *
 * It talks to the game through `DevApi` and nothing else. That boundary is the
 * whole point: the console can be dropped from `main.ts` in one line, and no
 * gameplay code carries an `if (devMode)`.
 *
 * Both halves of the panel drive the same verbs - a button runs the same
 * command string the text line parses - so there is exactly one implementation
 * of "unlock everything" and the two can never disagree.
 */

export interface DevTierInfo {
  index: number;
  id: string;
  name: string;
  unlocked: boolean;
  current: boolean;
}

export interface DevStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  strawInstances: number;
  quality: string;
  resolutionScale: number;
  /** Fraction of the stack dug away, 0..1. */
  cleared: number;
  cash: number;
  gems: number;
  noclip: boolean;
  position: { x: number; y: number; z: number };
}

/** Everything the console is allowed to do. Implemented by `Game`. */
export interface DevApi {
  tiers(): DevTierInfo[];
  travelTo(index: number): void;
  unlockAllTiers(): void;

  addCash(amount: number): void;
  setCash(amount: number): void;
  addGems(amount: number): void;

  maxUpgrades(): void;
  unlockAllTools(): void;
  unlockAllPerks(): void;
  refillHunches(): void;

  /** Set the fraction of the stack that has been dug away, 0..1. */
  setCleared(fraction: number): void;
  fillBag(): void;
  emptyBag(): void;
  /** Stand on top of the needle and expose it. */
  revealNeedle(): void;
  /** End the run as though the needle had just been found. */
  findNeedle(): void;
  collectTreasures(): void;
  completeCollection(): void;

  setNoclip(on: boolean): void;
  setSpeed(multiplier: number): number;
  teleport(where: TeleportTarget): void;

  setQuality(tier: string): void;
  setMood(mood: string): void;
  moods(): readonly string[];

  stats(): DevStats;
  resetSave(): void;
  /** Told whenever the panel opens or closes, so the game can free the mouse. */
  setConsoleOpen(open: boolean): void;
}

export type TeleportTarget = 'stack' | 'sell' | 'shop' | 'spawn';

const TELEPORT_TARGETS: readonly TeleportTarget[] = ['stack', 'sell', 'shop', 'spawn'];
const QUALITY_TIERS: readonly string[] = ['low', 'medium', 'high', 'ultra', 'auto'];

interface Command {
  /** Verbs that invoke this command; the first is the canonical one. */
  names: readonly string[];
  args: string;
  help: string;
  run(api: DevApi, args: string[]): string;
}

const NUMBER_SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** Parse `1000`, `+2.5k`, `-1m`. Returns NaN for anything else. */
function parseAmount(text: string | undefined): number {
  if (!text) return NaN;
  const match = /^([+-]?[\d.]+)\s*([kmb])?$/i.exec(text.trim());
  if (!match) return NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return NaN;
  return value * (match[2] ? NUMBER_SUFFIX[match[2].toLowerCase()] : 1);
}

/** `on` / `off` / nothing, where nothing means "flip it". */
function parseToggle(text: string | undefined, current: boolean): boolean {
  if (text === 'on' || text === '1' || text === 'true') return true;
  if (text === 'off' || text === '0' || text === 'false') return false;
  return !current;
}

const COMMANDS: readonly Command[] = [
  {
    names: ['help', '?'],
    args: '',
    help: 'список команд',
    run: () =>
      COMMANDS.map(
        (command) => `  ${command.names[0]}${command.args ? ' ' + command.args : ''} — ${command.help}`,
      ).join('\n'),
  },
  {
    names: ['tp', 'stack', 'level'],
    args: '<1..N>',
    help: 'перейти на стог по номеру',
    run: (api, args) => {
      const tiers = api.tiers();
      const index = Math.round(parseAmount(args[0])) - 1;
      if (!Number.isFinite(index) || index < 0 || index >= tiers.length) {
        return `нужен номер 1..${tiers.length}`;
      }
      api.unlockAllTiers();
      api.travelTo(index);
      return `переход: ${tiers[index].name}`;
    },
  },
  {
    names: ['goto', 'go'],
    args: TELEPORT_TARGETS.join('|'),
    help: 'телепорт по двору',
    run: (api, args) => {
      const where = args[0] as TeleportTarget;
      if (!TELEPORT_TARGETS.includes(where)) return `куда: ${TELEPORT_TARGETS.join(', ')}`;
      api.teleport(where);
      return `телепорт: ${where}`;
    },
  },
  {
    names: ['cash', 'money'],
    args: '<±сумма>',
    help: 'выдать (со знаком) или установить деньги',
    run: (api, args) => {
      const raw = args[0] ?? '';
      const amount = parseAmount(raw);
      if (!Number.isFinite(amount)) return 'нужна сумма, например 10k или +500';
      if (raw.startsWith('+') || raw.startsWith('-')) api.addCash(amount);
      else api.setCash(amount);
      return `деньги: ${Math.round(api.stats().cash)}`;
    },
  },
  {
    names: ['gems', 'gem'],
    args: '<±сумма>',
    help: 'выдать кристаллы',
    run: (api, args) => {
      const amount = parseAmount(args[0]);
      if (!Number.isFinite(amount)) return 'нужна сумма';
      api.addGems(amount);
      return `кристаллы: ${api.stats().gems}`;
    },
  },
  {
    names: ['max', 'all'],
    args: '',
    help: 'всё: апгрейды, инструменты, перки, стога',
    run: (api) => {
      api.unlockAllTiers();
      api.unlockAllTools();
      api.maxUpgrades();
      api.unlockAllPerks();
      api.refillHunches();
      return 'выдано всё';
    },
  },
  {
    names: ['dig', 'clear'],
    args: '<0..100>',
    help: 'разобрать стог на N процентов',
    run: (api, args) => {
      const percent = parseAmount(args[0]);
      if (!Number.isFinite(percent)) return 'нужен процент 0..100';
      const clamped = Math.max(0, Math.min(100, percent));
      api.setCleared(clamped / 100);
      return `стог разобран на ${clamped.toFixed(0)}%`;
    },
  },
  {
    names: ['needle'],
    args: '[find]',
    help: 'встать над иголкой (или сразу найти её)',
    run: (api, args) => {
      if (args[0] === 'find') {
        api.findNeedle();
        return 'иголка найдена';
      }
      api.revealNeedle();
      return 'иголка под ногами';
    },
  },
  {
    names: ['bag'],
    args: 'full|empty',
    help: 'наполнить или опустошить мешок',
    run: (api, args) => {
      if (args[0] === 'empty') {
        api.emptyBag();
        return 'мешок пуст';
      }
      api.fillBag();
      return 'мешок полон';
    },
  },
  {
    names: ['fly', 'noclip', 'god'],
    args: '[on|off]',
    help: 'полёт сквозь стены',
    run: (api, args) => {
      const on = parseToggle(args[0], api.stats().noclip);
      api.setNoclip(on);
      return `полёт: ${on ? 'вкл' : 'выкл'}`;
    },
  },
  {
    names: ['speed'],
    args: '<множитель>',
    help: 'скорость передвижения',
    run: (api, args) => {
      const value = parseAmount(args[0]);
      if (!Number.isFinite(value)) return 'нужен множитель, например 3';
      return `скорость ×${api.setSpeed(value)}`;
    },
  },
  {
    names: ['quality', 'q'],
    args: QUALITY_TIERS.join('|'),
    help: 'уровень графики',
    run: (api, args) => {
      const tier = args[0] ?? '';
      if (!QUALITY_TIERS.includes(tier)) return QUALITY_TIERS.join(', ');
      api.setQuality(tier);
      return `графика: ${tier}`;
    },
  },
  {
    names: ['mood', 'time'],
    args: '<название>',
    help: 'освещение и время суток',
    run: (api, args) => {
      const mood = args[0] ?? '';
      if (!api.moods().includes(mood)) return `варианты: ${api.moods().join(', ')}`;
      api.setMood(mood);
      return `освещение: ${mood}`;
    },
  },
  {
    names: ['treasures', 'loot'],
    args: '',
    help: 'собрать все находки в стоге',
    run: (api) => {
      api.collectTreasures();
      return 'находки собраны';
    },
  },
  {
    names: ['collection'],
    args: '',
    help: 'заполнить коллекцию находок',
    run: (api) => {
      api.completeCollection();
      return 'коллекция заполнена';
    },
  },
  {
    names: ['reset'],
    args: '',
    help: 'стереть сохранение и перезагрузить',
    run: (api) => {
      api.resetSave();
      return 'сохранение стёрто';
    },
  },
];

export class DevConsole {
  private readonly panel: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly tierGrid: HTMLElement;
  private readonly flyButton: HTMLButtonElement;
  private readonly perfButton: HTMLButtonElement;

  private open = false;
  private perfVisible = false;
  private readonly history: string[] = [];
  private historyCursor = -1;
  private readonly disposers: (() => void)[] = [];

  constructor(
    root: HTMLElement,
    private readonly api: DevApi,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'devc';
    this.panel.hidden = true;
    this.panel.innerHTML = TEMPLATE;
    root.appendChild(this.panel);

    this.perf = document.createElement('div');
    this.perf.className = 'devc-perf';
    this.perf.hidden = true;
    root.appendChild(this.perf);

    this.log = this.query('.devc__log');
    this.input = this.query('.devc__input') as HTMLInputElement;
    this.readout = this.query('.devc__readout');
    this.tierGrid = this.query('[data-grid="tiers"]');
    this.flyButton = this.query('[data-cmd="fly"]') as HTMLButtonElement;
    this.perfButton = this.query('[data-cmd="perf"]') as HTMLButtonElement;

    this.buildTierButtons();
    this.bindButtons();
    this.bindInput();
    this.bindHotkeys();
    this.print('Админ-консоль. `help` — список команд.', 'ok');
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Called once a frame; does nothing at all while everything is hidden. */
  update(): void {
    if (!this.open && !this.perfVisible) return;
    const stats = this.api.stats();
    if (this.perfVisible) {
      this.perf.textContent =
        `${stats.fps.toFixed(0)} fps · ${stats.quality} ×${stats.resolutionScale.toFixed(2)}\n` +
        `${stats.drawCalls} вызовов · ${(stats.triangles / 1000).toFixed(0)}k тр.\n` +
        `${stats.strawInstances} соломин · разобрано ${(stats.cleared * 100).toFixed(1)}%`;
    }
    if (!this.open) return;
    this.readout.textContent = '';
    this.readout.append(
      readoutCell('fps', stats.fps.toFixed(0)),
      readoutCell('вызовов', String(stats.drawCalls)),
      readoutCell('треуг.', `${(stats.triangles / 1000).toFixed(0)}k`),
      readoutCell('соломин', String(stats.strawInstances)),
      readoutCell('деньги', String(Math.round(stats.cash))),
      readoutCell('кристаллы', String(stats.gems)),
      readoutCell('разобрано', `${(stats.cleared * 100).toFixed(1)}%`),
      readoutCell(
        'xyz',
        `${stats.position.x.toFixed(0)} ${stats.position.y.toFixed(0)} ${stats.position.z.toFixed(0)}`,
      ),
    );
    this.flyButton.classList.toggle('is-on', stats.noclip);
  }

  toggle(force?: boolean): void {
    const next = force ?? !this.open;
    if (next === this.open) return;
    this.open = next;
    this.panel.hidden = !this.open;
    this.api.setConsoleOpen(this.open);
    if (this.open) {
      this.refreshTierButtons();
      this.input.focus();
    } else {
      this.input.blur();
    }
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.panel.remove();
    this.perf.remove();
  }

  // -------------------------------------------------------------- internals
  private query(selector: string): HTMLElement {
    const found = this.panel.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`dev console template is missing ${selector}`);
    return found;
  }

  private buildTierButtons(): void {
    for (const tier of this.api.tiers()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${tier.index + 1}. ${tier.name}`;
      button.title = tier.id;
      button.addEventListener('click', () => {
        this.api.unlockAllTiers();
        this.api.travelTo(tier.index);
        this.print(`переход: ${tier.name}`, 'ok');
        this.refreshTierButtons();
      });
      this.tierGrid.appendChild(button);
    }
  }

  private refreshTierButtons(): void {
    const tiers = this.api.tiers();
    const buttons = Array.from(this.tierGrid.children) as HTMLElement[];
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('is-current', tiers[i]?.current ?? false);
      buttons[i].classList.toggle('is-locked', !(tiers[i]?.unlocked ?? true));
    }
  }

  private bindButtons(): void {
    for (const button of Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button[data-run]'))) {
      button.addEventListener('click', () => this.runCommand(button.dataset.run ?? '', false));
    }
    this.flyButton.addEventListener('click', () => this.runCommand('fly', false));
    this.perfButton.addEventListener('click', () => this.togglePerf());
  }

  private bindInput(): void {
    // Every key is stopped here so the game never sees the player "typing" WASD
    // into the command line; `Input` also guards on the event target, and both
    // are cheap, so the console keeps its own.
    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        const line = this.input.value.trim();
        this.input.value = '';
        if (!line) return;
        this.history.unshift(line);
        this.historyCursor = -1;
        this.runCommand(line, true);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (this.history.length === 0) return;
        this.historyCursor = Math.max(
          -1,
          Math.min(this.history.length - 1, this.historyCursor + (event.key === 'ArrowUp' ? 1 : -1)),
        );
        this.input.value = this.historyCursor < 0 ? '' : this.history[this.historyCursor];
      } else if (event.key === 'Escape') {
        this.toggle(false);
      }
    });
    this.input.addEventListener('keyup', (event) => event.stopPropagation());
  }

  private bindHotkeys(): void {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      // Backquote is the console. On a Russian layout the same physical key
      // types `ё`, and some layouts need a modifier for `~`, so the key value
      // is accepted as well as the code.
      const isToggle =
        event.code === 'Backquote' ||
        event.key === '`' ||
        event.key === '~' ||
        event.key === 'ё' ||
        event.key === 'Ё';
      if (isToggle) {
        event.preventDefault();
        this.toggle();
      } else if (event.code === 'F3') {
        event.preventDefault();
        this.togglePerf();
      }
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  private togglePerf(): void {
    this.perfVisible = !this.perfVisible;
    this.perf.hidden = !this.perfVisible;
    this.perfButton.classList.toggle('is-on', this.perfVisible);
  }

  /** Run one command line. `echo` prints the line itself first. */
  runCommand(line: string, echo: boolean): void {
    if (echo) this.print(`> ${line}`);
    const parts = line.trim().split(/\s+/);
    const verb = (parts.shift() ?? '').toLowerCase();
    const command = COMMANDS.find((entry) => entry.names.includes(verb));
    if (!command) {
      this.print(`неизвестная команда: ${verb}. \`help\` — список.`, 'err');
      return;
    }
    try {
      this.print(command.run(this.api, parts), 'ok');
    } catch (error) {
      this.print(error instanceof Error ? error.message : String(error), 'err');
    }
    this.refreshTierButtons();
  }

  private print(text: string, kind?: 'ok' | 'err'): void {
    const line = document.createElement('div');
    if (kind) line.className = kind === 'ok' ? 'is-ok' : 'is-err';
    line.textContent = text;
    this.log.appendChild(line);
    while (this.log.childElementCount > 60) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function readoutCell(label: string, value: string): HTMLElement {
  const cell = document.createElement('span');
  cell.textContent = `${label} `;
  const strong = document.createElement('b');
  strong.textContent = value;
  cell.appendChild(strong);
  return cell;
}

const TEMPLATE = `
  <div class="devc__head">
    <span>Админ-консоль</span>
    <span class="devc__hint">~ закрыть · F3 счётчики</span>
  </div>
  <div class="devc__body">
    <div class="devc__section">
      <div class="devc__title">Стога</div>
      <div class="devc__grid devc__grid--2" data-grid="tiers"></div>
    </div>

    <div class="devc__section">
      <div class="devc__title">Телепорт</div>
      <div class="devc__grid">
        <button type="button" data-run="goto stack">к стогу</button>
        <button type="button" data-run="goto sell">к корове</button>
        <button type="button" data-run="goto shop">к лавке</button>
        <button type="button" data-run="goto spawn">на старт</button>
      </div>
    </div>

    <div class="devc__section">
      <div class="devc__title">Деньги и прогресс</div>
      <div class="devc__grid">
        <button type="button" data-run="cash +1000">+1 000</button>
        <button type="button" data-run="cash +100k">+100k</button>
        <button type="button" data-run="cash +10m">+10M</button>
        <button type="button" data-run="cash 0">= 0</button>
        <button type="button" data-run="gems +25">+25 крист.</button>
        <button type="button" data-run="gems +500">+500 крист.</button>
        <button type="button" data-run="max">выдать всё</button>
        <button type="button" data-run="collection">коллекция</button>
      </div>
    </div>

    <div class="devc__section">
      <div class="devc__title">Стог</div>
      <div class="devc__grid">
        <button type="button" data-run="dig 0">целый</button>
        <button type="button" data-run="dig 50">−50%</button>
        <button type="button" data-run="dig 95">−95%</button>
        <button type="button" data-run="treasures">находки</button>
        <button type="button" data-run="bag full">мешок полон</button>
        <button type="button" data-run="bag empty">мешок пуст</button>
        <button type="button" data-run="needle">к иголке</button>
        <button type="button" data-run="needle find">найти иголку</button>
      </div>
    </div>

    <div class="devc__section">
      <div class="devc__title">Игрок и вид</div>
      <div class="devc__grid">
        <button type="button" data-cmd="fly">полёт</button>
        <button type="button" data-run="speed 1">×1</button>
        <button type="button" data-run="speed 3">×3</button>
        <button type="button" data-run="speed 8">×8</button>
        <button type="button" data-cmd="perf">счётчики</button>
        <button type="button" data-run="quality low">низкое</button>
        <button type="button" data-run="quality high">высокое</button>
        <button type="button" data-run="quality ultra">ультра</button>
      </div>
    </div>

    <div class="devc__section">
      <div class="devc__title">Освещение</div>
      <div class="devc__grid devc__grid--3">
        <button type="button" data-run="mood noon">день</button>
        <button type="button" data-run="mood overcast">пасмурно</button>
        <button type="button" data-run="mood golden">закат</button>
        <button type="button" data-run="mood storm">гроза</button>
        <button type="button" data-run="mood night">ночь</button>
        <button type="button" data-run="mood dawn">рассвет</button>
      </div>
    </div>

    <div class="devc__section">
      <div class="devc__title">Показатели</div>
      <div class="devc__readout"></div>
    </div>

    <div class="devc__section">
      <div class="devc__grid devc__grid--2">
        <button type="button" class="is-danger" data-run="reset">стереть сохранение</button>
      </div>
    </div>
  </div>
  <div class="devc__foot">
    <input class="devc__input" placeholder="команда: tp 4 · cash +50k · dig 80 · fly · help" spellcheck="false" autocomplete="off" />
    <div class="devc__log"></div>
  </div>
`;
