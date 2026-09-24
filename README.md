# Find the Needle

A cozy first-person game about digging through a giant haystack looking for a
needle. Built with three.js, TypeScript and Vite. Every model is generated in
Blender from scripts in this repository; every sound is synthesised in the
browser. There are no textures, no audio files and no third-party assets.

**One needle. A million straws.**

The game itself is in **Russian**; the code, the comments and this file are in
English. Strings are translated in place rather than behind an i18n layer -
the game ships in one language, and a lookup table with a fallback chain would
be three moving parts serving a switch nobody can throw.

---

## The game

You arrive at a farmyard with a haystack in the middle of it, and there is a
needle in there somewhere.

Pull hay out of the stack with your hands. Carry it to the cow. The cow pays.
Spend the money on a deeper grasp, a wider sweep, a bigger bag, better boots and
a sharper tongue for haggling — and, when you can afford them, on a pitchfork, a
rake, a stick of dynamite, a leaf blower, an industrial hay vacuum and finally a
stack compressor. Somewhere between a third and three quarters of the way
through the stack, the needle turns up.

Then it all resets and you do it again, on a bigger stack.

### The three clocks

The whole design hangs on three loops running at once:

| Clock | Period | What it is |
| --- | --- | --- |
| Buy something | ~10 s | The shop always has something you can nearly afford |
| Fill and sell | ~60 s | Bag fills, walk to the cow, watch the number go up |
| Find the needle | ~8 min | The run ends, gems are banked, a bigger stack opens |

### Runs, not a bank account

Cash, upgrade levels and the tools you bought belong to **one haystack**. They
are gone the moment the needle turns up. Only **gems** cross the boundary, and
they buy permanent perks that make every future run a little easier.

This is the same structure the games that inspired this one use, and it is there
for a concrete reason: an upgrade tree that persists forever is fully bought out
within a few hours and the economy dies with it. A tree that resets means the
ten-second "something to buy" clock ticks from the first pull of every session,
and a run becomes a self-contained thing you can win.

### The yard

Everything the player can reach is inside a ring of post-and-rail seventeen
metres beyond the kiosks: the stack, the shop, the barn - which has a real
doorway and bales inside it - and the animals. Outside the fence the ground
rises into a rampart of hills that closes the horizon in every direction.

A bowl the player cannot see out of is a hundred metres across instead of six
hundred, and it removes the need to dress a far field nobody will ever visit.
The fence is drawn as one `InstancedMesh` and carries no colliders: a single
analytic radius in `CollisionWorld` is the wall, and it cannot develop the gap
that a ring of eighty boxes eventually will.

### What is in a stack

- **The needle.** Its burial depth is not random — it is *authored*. The game
  picks how much of the stack should be gone when it surfaces, then solves for
  the height that produces exactly that. (A uniformly random depth gives a
  uniformly random run length, with a median of exactly 50 % and a miserable
  tail past 95 %. See `BuriedField.placeNeedle`.)
- **Buried oddities.** An old penny, a lucky horseshoe, a pocket watch stopped
  at 4:07, a garden gnome who seems fine, a flying saucer. Eleven of them, in
  five rarity bands, with a permanent collection to fill.
- **Golden bundles.** Roughly one pull in twenty comes up gold and pays eight
  times over.

### Six stacks

| Stack | In game | Straws | Mood |
| --- | --- | --- | --- |
| The Home Stack | Домашний стог | 12,000 | Midday |
| The Barn Loft | Сеновал | 33,000 | Overcast |
| Sunset Field | Закатное поле | 95,000 | Golden hour |
| Storm Silo | Грозовой силос | 260,000 | Storm |
| Moonlit Meadow | Лунный луг | 550,000 | Night |
| The Mother Lode | Золотая жила | 1,000,000 | Dawn |

Each is bigger than the last, pays more per straw and starts you with a better
tool, so a run takes roughly the same eight minutes on every one of them. What
changes is the scale of the numbers and the light you are working in.

---

## Controls

| | |
| --- | --- |
| **W A S D** | Move |
| **Mouse** | Look |
| **Left mouse** | Pull hay |
| **Space** | Jump |
| **Shift** | Sprint |
| **E** | Use whatever you are standing in front of |
| **F** | Hunch — points toward the needle, if you have bought one |
| **Q / R / wheel / 1-7** | Change tool |
| **B** | Shop |
| **J** | Jobs board |
| **M** | Travel |
| **Esc** | Pause |
| **~** | Admin console |
| **F3** | Performance readout |

On a phone: the left half of the screen is a movement stick and the right half
looks and digs. That covers walking and pulling hay, and nothing else - so
every keyboard verb a phone cannot reach has something to tap instead. The
four panels live on an action rail down the right of the HUD, which is what
gives a phone a shop at all; the rail also carries the pause button; the
interaction prompt under the crosshair is a button, because it is the only
thing on screen that says "sell"; and the tool read-out in the corner is the
tool button. All of them go through the same paths the keys do, and all of
them work with a mouse as well.

### The admin console

`~` opens a panel that can reach anything the game can do: jump between
stacks, print cash and gems, max the shop, dig the pile to an exact
percentage, fly through walls, surface the needle, swap the lighting. Its
buttons and its command line run the same verbs, and it talks to the game
through one interface (`DevApi`), so no gameplay code carries an
`if (devMode)`.

It is not in the Yandex Games build - see below - where a reachable developer
console counts as both technical text and a cheat. It is in the public web
build, which is where it earns its keep.

---

## Running it

```bash
npm install
npm run dev      # http://127.0.0.1:5187
```

```bash
npm run build    # typecheck, then bundle into dist/
npm run preview  # serve the production build
npm run balance  # play a few thousand simulated runs and print the pacing
npm run assets   # optimise the .glb library in place
```

### Yandex Games

The game ships to [Yandex Games](https://yandex.ru/games/) as well as to the web,
and that platform is strict in a very mechanical way: a moderator opens the draft
with a debug panel and checks a list. `src/platform/ysdk.ts` is the only file that
touches `window.YaGames`; the rest of the game calls `loadingReady()`,
`showInterstitial()`, `showRewarded()` and `saveCloudDebounced()` and never knows
whether the platform is there.

```bash
npm run build:yandex   # production build without the admin console
npm run pack:yandex    # the above, then validate and zip into build.zip
```

`tools/pack.mjs` is the packer, and it is not optional: a zip made by Windows
PowerShell has backslash entry names, the platform then serves only `index.html`,
and the rejection reads "SDK not integrated". It also checks the things that are
easy to get wrong - `index.html` at the archive root, no absolute asset paths, no
CDN hosts, the `/sdk.js` tag present, the archive under 100 MB.

What the platform wiring actually does, and why each piece is where it is:

- **The SDK tag is `<script src="/sdk.js">`, root-relative and unbundled.** The
  platform serves that exact path itself. It 404s everywhere else, so a dev-only
  Vite middleware answers it with a one-line stub - not to fake the SDK, but so
  the console has no permanent red line in it.
- **Boot order is the requirement.** The handshake starts before anything is
  constructed, because it is what reads the portal language; the cloud save is
  awaited before `Game.boot`, because everything downstream is built from the
  save; and `ready()` fires on the line where the title screen appears. Early is
  a rejection, late is a rejection, and on a timer is a rejection.
- **The cloud save rides on the local one.** `SaveManager.saved` already fires at
  every moment worth keeping, so the cloud write hangs off it, debounced to stay
  under the platform's rate limit and flushed on `pagehide`. Coming back, the
  newer of the two wins - not the cloud, or a player who played offline gets
  rolled back by a stale blob.
- **One interstitial, on travel.** The player has just pressed a button, the
  stack behind them is finished, and nothing is happening that an interruption
  can ruin. Four-minute cooldown against a seven-minute stack means at most one
  per haystack.
- **One rewarded video, on the summary card**, doubling that run's gems. The
  reward is granted in the platform's `onRewarded` and nowhere else: granting in
  `onClose` pays out for closing the advert after two seconds.
- **The admin console is not in the store build.** `--mode yandex` switches
  `VITE_DEV_CONSOLE` off and the bundler drops the module - a reachable developer
  console is both technical text and a cheat. It stays in the public web build,
  which is where it is useful.

---

## How it is built

### The haystack

The stack is a **height field** — a grid of surface heights in a typed array.
Digging subtracts a smooth crater, walking queries the interpolated surface, and
aiming ray-marches it, so nothing about the gameplay depends on the pile's
triangle count.

Drawing it is three layers:

1. **A packed core** — the height field as a mesh, shaded by a procedural fibre
   pattern that carries the middle and far distance without a texture.
2. **A shell** — thousands of real straw instances anchored across the whole
   footprint, whose height tracks the surface. Dig, and the straws in the crater
   sink out of existence.
3. **A detail band** — a much denser patch of straws that follows the player,
   because the density that reads correctly at forty centimetres is an order of
   magnitude higher than the density that is affordable across a twenty-metre
   stack.

That third layer is not a nicety. A uniform shell dense enough for a close-up
costs several times the frame budget at Mother Lode scale, and a shell cheap
enough to afford looks like sand with sprinkles the moment you lean in. The
pile is bound by total instance count, so moving instances from *everywhere* to
*where the player is standing* changes where they are, not how many.

### Everything else

- **Fixed-timestep loop.** Gameplay advances in exact 1/60 s steps; rendering is
  decoupled and interpolates, so the game plays identically on a 30 Hz laptop
  and a 240 Hz monitor.
- **Procedural animal gaits.** There is no `Walk` clip. Legs swing as a
  function of *distance travelled*, layered on top of the idle the mixer is
  playing, so a hen scurrying and a cow ambling are the same eight lines with a
  different stride length and no foot ever skates.
- **One material language.** Every mesh is authored in Blender with a per-corner
  colour attribute and one of five surface families, so the whole world runs on
  a handful of shared materials with a stylised rim light and wind sway patched
  in. No textures anywhere.
- **Adaptive resolution.** The renderer scales its internal resolution to hold
  the frame budget before it asks the player to turn anything off, and gives up
  a whole quality tier when that is not enough.
- **A shadow camera that does not follow you.** The usual trick is a tight
  frustum on the player, snapped to the shadow map's texel grid. That was here
  and it popped: 26 m does not reach a tree line that starts at 32 m, so across
  48 standing positions the number of the yard's 91 casters that had shadows
  ranged from 34 to 68, and a hillside of trees switched on and off as you
  crossed the yard. But the world is a bounded disc the player cannot leave,
  and each stack holds one sun elevation, so the frustum is fitted to the disc
  instead — 91 of 91 from everywhere, and no snapping needed, because a
  projection that never changes lands on the same texels by construction. The
  fit is analytic: the light's right axis is horizontal, so the disc needs
  exactly its own radius across; its up axis is tilted by the elevation, so the
  same disc needs `R·sin(E)` along it plus `h·cos(E)` for a caster of height h.
  A low sun therefore wants a *shorter* frustum in that direction, and dawn
  gets 14 mm texels along the sun where noon gets 38.
- **Collide what is there, not what it is called.** Buildings are not boxes.
  The barn is five wall slabs with a three-metre gap where its doorway is, and
  the pole barn — which is a roof on six posts with one wall across the back —
  is one slab and six boxes. It used to be classed "open-sided" and given no
  collision at all, which meant you could walk into the middle of it from 17
  of 18 compass headings, straight through an eight-metre plank wall.
- **Procedural audio.** Every sound is synthesised at runtime with the Web Audio
  API — filtered noise bursts for hay, FM for anything metallic, a lookahead
  scheduler for a generative music bed. Zero bytes of audio ship.
- **A farmyard that answers you.** Two calls per species, deliberately opposite
  shapes, because the third identical moo is the one the ear stops believing;
  a fixed pitch per individual animal, so five hens are five hens rather than
  one hen that cannot make up its mind; and a call when the player walks up,
  which is the half of it a player actually connects to the animal in front of
  them. The cow at the trough moos when you feed it.
- **A key per scene.** Four chords is twenty-six seconds and a player is on one
  haystack for eight minutes, so each scene has its own chord set and
  pentatonic, swapped in at the next chord when you travel. The melody walks
  rather than being drawn from the scale — uniform random over a pentatonic
  never sounds wrong, but it sounds like a wind chime, because a tune is mostly
  steps with the occasional leap.
- **Versioned saves.** The save file is treated like a database schema, with
  migrations. A file that cannot be migrated is archived, never discarded.

### Quality, and climbing down from it

Nothing in a frame of this game waits on the CPU - simulation and frame update
together measure about 0.1 ms. So the starting quality tier is not chosen from
`deviceMemory` and `hardwareConcurrency`, which describe the CPU and were
handing Ultra to desktops with integrated graphics on the strength of their
RAM. The renderer string gets a veto: a software rasteriser starts at the
bottom and an integrated GPU is capped at medium.

When frames still run long, resolution scales first, because it is the only
lever with no visual discontinuity. But that only helps a renderer short of
fill rate, and a weak GPU is just as often short of vertex throughput or
shadow budget - so after six seconds pinned at the resolution floor the engine
gives up a whole tier and hands the resolution back. Ultra to high to medium
to low, each step dropping the pixel ratio, the shadow map, bloom and the
straw budget: 526k triangles and 155 draw calls at ultra, 343k and 64 at low,
with the pile still reading as loose hay. It only ever climbs down, and only
on "auto".

Shadow map sizes are picked for the texel size they produce on the ground
rather than as round numbers, because the frustum covers the whole stack —
about 120 m across — instead of a patch around the player: 39 mm at ultra and
high, 59 mm at medium, and no shadows at all at low.

### Balance is measured, not guessed

`tools/balance.ts` imports the real tables from `src/gameplay/Content.ts` and
plays whole runs — including the boring parts: walking to the cow, waiting out
pull cooldowns, pulls that hit ground already cleared, and the fact that a
bigger stack means more walking between working faces.

```
=== per-stack pacing (no perks, needle at the median quantile) ===
  stack                 time  first  gap p50  gap p90  buys   upg    dead      hay  tool
  Домашний стог        7m27s   5.3s    11.5s    19.0s    32   14%   0m19s     5.0K  pitchfork
  Сеновал              8m35s   5.6s    12.4s    23.9s    34   15%   0m10s    15.4K  pitchfork
  Закатное поле        9m06s   5.6s    12.5s    24.7s    35   16%   0m00s    46.6K  pitchfork
  Грозовой силос       9m35s   5.7s    12.7s    25.2s    35   16%   0m19s     133K  rake
  Лунный луг          10m02s   5.8s    12.9s    26.0s    36   16%   0m06s     295K  blower
  Золотая жила        10m27s   5.8s    12.9s    26.0s    37   17%   0m00s     567K  vacuum
```

First purchase at five seconds, one every twelve seconds after that, and no
"nothing left to buy" tail. Every number in `Content.ts` was moved until that
table said what it should.

---

## The art

Every model in `public/models/` is generated by the Python in
`tools/blender/`. There is no `.blend` file to lose and no binary to merge — a
model is a function, and changing the barn is a diff.

```python
def build_square_bale():
    """A rectangular bale with chamfered corners and two baling wires."""
    body = cube("BaleBody", size=(0.9, 0.6, 0.55), loc=(0, 0, 0.275), color="straw")
    bevel(body, 0.05, 2)
    apply_modifiers(body)
    paint(body, "straw_mid", faces=select_faces(body, lambda c, n: abs(n.x) > 0.8))
    ...
```

To rebuild the library, open Blender with the MCP add-on and run:

```python
exec(open(r"tools/blender/run.py").read())
build_everything()
```

Colour lives in a per-corner `FLOAT_COLOR` attribute rather than a texture, so
a prop is one draw call, the whole library is under a megabyte after
optimisation, and a palette change is one dictionary.

---

## Layout

```
src/
  core/       engine, input, assets, materials, saves, maths, RNG
  world/      sky, terrain, scenery, collision, the height field and the pile
  gameplay/   player, digging, tools, buried things, the run and the meta-game
  fx/         particles, screen effects
  audio/      the synthesiser
  ui/         widget kit, stylesheet, and the game's screens
tools/
  blender/    the modelling kit and one script per asset family
  balance.ts  the pacing simulator
```

---

## Credits

Made with hay, sunshine and three.js. Inspired by the wave of Roblox
needle-in-a-haystack games of August 2026, rebuilt from the ground up in first
person for the browser.
