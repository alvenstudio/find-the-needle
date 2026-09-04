# Find the Needle

A cozy first-person game about digging through a giant haystack looking for a
needle. Built with three.js, TypeScript and Vite. Every model is generated in
Blender from scripts in this repository; every sound is synthesised in the
browser. There are no textures, no audio files and no third-party assets.

**One needle. A million straws.**

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

| Stack | Straws | Mood |
| --- | --- | --- |
| The Home Stack | 12,000 | Midday |
| The Barn Loft | 33,000 | Overcast |
| Sunset Field | 95,000 | Golden hour |
| Storm Silo | 260,000 | Storm |
| Moonlit Meadow | 550,000 | Night |
| The Mother Lode | 1,000,000 | Dawn |

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

On a phone: left half of the screen is a movement stick, right half looks and
digs.

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
- **One material language.** Every mesh is authored in Blender with a per-corner
  colour attribute and one of five surface families, so the whole world runs on
  a handful of shared materials with a stylised rim light and wind sway patched
  in. No textures anywhere.
- **Adaptive resolution.** The renderer scales its internal resolution to hold
  the frame budget before it asks the player to turn anything off.
- **Procedural audio.** Every sound is synthesised at runtime with the Web Audio
  API — filtered noise bursts for hay, FM for anything metallic, a lookahead
  scheduler for a slow generative music bed. Zero bytes of audio ship.
- **Versioned saves.** The save file is treated like a database schema, with
  migrations. A file that cannot be migrated is archived, never discarded.

### Balance is measured, not guessed

`tools/balance.ts` imports the real tables from `src/gameplay/Content.ts` and
plays whole runs — including the boring parts: walking to the cow, waiting out
pull cooldowns, pulls that hit ground already cleared, and the fact that a
bigger stack means more walking between working faces.

```
=== per-stack pacing (no perks, needle at the median quantile) ===
  stack                 time  first  gap p50  gap p90  buys   upg    dead      hay  tool
  The Home Stack       7m27s   5.3s    11.5s    19.0s    32   14%   0m19s     5.0K  pitchfork
  The Barn Loft        8m35s   5.6s    12.4s    23.9s    34   15%   0m10s    15.4K  pitchfork
  Sunset Field         9m06s   5.6s    12.5s    24.7s    35   16%   0m00s    46.6K  pitchfork
  Storm Silo           9m35s   5.7s    12.7s    25.2s    35   16%   0m19s     133K  rake
  Moonlit Meadow      10m02s   5.8s    12.9s    26.0s    36   16%   0m06s     295K  blower
  The Mother Lode     10m27s   5.8s    12.9s    26.0s    37   17%   0m00s     567K  vacuum
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
