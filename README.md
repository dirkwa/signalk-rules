# signalk-rules

Simple switching automation for [Signal K](https://signalk.org/):
**WHEN** conditions on Signal K paths **THEN** switch, pulse or
notify — composed in a friendly webapp, no Node-RED required.

Classic use cases, each a one-minute setup:

- **Solar water heater** — heater on only while the solar charger
  actually delivers current (with hysteresis + hold so clouds don't
  flap the contactor).
- **Anchor light** — on only when nothing is charging, no shore power
  is present, SOG is below 1 kn and it is dark.
- **Generator autostart** — pulse the start circuit for 30 s when SOC
  drops below 25 %, pulse stop at 84 %, with a cooldown so a restart
  loop can never machine-gun the starter.
- **Deck lights on anchor alarm** — on while the anchor alarm
  (`notifications.navigation.anchor`) is raised, and ten minutes
  after it clears.

## How it behaves

- **Edge-triggered.** A rule sends a command only when its decision
  *changes*. Manual overrides (panel, plotter, another app) stick
  until the next transition. Rules that must stay enforced can opt
  into a per-rule *re-assert every N minutes*.
- **Restart-proof.** A rule keeps its decision across a server
  restart and across edits that leave its actions and dry-run setting
  alone, so neither counts as a transition and a manual override
  survives them. A rule that comes back *on* raises its notification
  again, since the server does not keep it.
- **Flap-proof.** Numeric conditions support a separate release
  threshold (hysteresis), and every rule can require its conditions to
  hold for N seconds before acting.
- **Honest about missing data.** A condition whose input is missing or
  stale evaluates to *unknown*: the rule holds its last decision,
  commands nothing, and the Dashboard shows exactly which input
  blocks. Paths from gear that isn't installed yet are a display
  state, not an error.
- **Cautious with pulses.** Pulse records hit disk *before* the output
  energizes; a crash mid-pulse is reverted on the next start, plugin
  disable reverts immediately, and pulses are capped at 60 s.
- **Dry-run.** Any rule can run the full state machine while only
  logging what it *would* do — safe testing against live data.

> **Safety note.** No software can revert an output across a hard
> power loss. For safety-critical momentary loads (engine starters,
> windlass), configure the switching hardware's own momentary/timer
> channel and let the rule merely trigger it.

Actions go through normal Signal K PUTs, so any switching backend that
registers action handlers works (e.g. `signalk-n2k-switching` for
NMEA 2000 relay banks). Rules can additionally raise
`notifications.*` with a chosen state and message.

A rule can also react to a notification another plugin raises: *WHEN
[Anchor alarm] [is raised at alarm or worse] THEN [Deck lights]
follows*. It is true while the notification's state is at least the
chosen one, and false once it is cleared or was never raised. Since a
notification is sent only when it changes, it never goes stale.

A message can quote a value the rule's conditions read: `{path}` is
replaced when the notification is raised, in the units the editor
shows (`Fridge at {environment.inside.refrigerator.temperature}`
becomes *Fridge at 12.2 °C*). A missing or stale value reads `?`, and
the clearing notification keeps the text it was raised with. Braces
around anything else, including a path no condition reads, stay as
written; the editor warns about the latter.

## Webapp

The **Rules** webapp (Webapps section of the server UI) provides:

- a sentence-style editor: *WHEN all of [Solar current] [is above]
  [2 A] THEN [Water heater] follows* — with live values and truth
  ticks beside every condition while you build it,
- a path picker that shows `meta.displayName` names where set and lets
  you name unnamed switches inline (names are written back as Signal K
  meta, so every app benefits),
- unit-aware inputs — you type knots, percent or °C; rules store raw
  SI units,
- a live Dashboard answering "why isn't my generator starting":
  per-condition values, staleness, hold/pulse/cooldown countdowns and
  the last actions of every rule,
- one-click starter templates (created paused + dry-run).

Editing rules needs a user with *readwrite* permission; viewing the
dashboard needs *readonly* (on servers with access-scoped plugin
routers).

## Install

Install **Rules** from the Signal K Appstore, or:

```bash
cd ~/.signalk
npm install signalk-rules
```

Engine knobs (evaluation interval, staleness TTL, verbose logging)
live in the plugin's server configuration; the rules themselves are
edited only in the webapp and hot-reload without a plugin restart.

## Development

```bash
npm install
npm run dev          # vite dev server, proxies /signalk + /plugins
                     # to $SIGNALK_DEV_URL (default 127.0.0.1:3000)
npm run build:all    # lint + plugin tsc + webapp typecheck+build + tests
```

Repo layout: `src/` is the plugin (rules engine), `webapp/` the React
UI, `src/shared/` the TypeBox schema + validation both sides share.
See [AGENTS.md](AGENTS.md) for architecture invariants.

## License

signalk-rules 2.0.0 and later is **source available, not open source**.
See [LICENSE.md](LICENSE.md).

**You may**, free of charge: run it on your own boat or fleet, private or
commercial; use it for internal company operations; modify it for your own use;
use it in non-commercial education and research; and provide professional
services to others who use it under these terms.

**You may not**: redistribute modified versions or derivative works, or publish
them to npm or anywhere else. Unmodified official releases may be mirrored,
cached and redistributed verbatim as long as the notices stay intact and the
license terms are included.

Versions 1.0.0 and earlier remain available under the Apache-2.0 license
(see [LICENSE-Apache-2.0-through-v1.x.txt](LICENSE-Apache-2.0-through-v1.x.txt)).
