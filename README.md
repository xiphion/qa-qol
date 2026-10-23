# QA assistance menu

Ingame menu for common QA/admin commands to make our lives slightly easier.
UI is mostly self-explanatory.
Gear presets for dungeons courtesy of **livi**!

Open the menu by entering `/8 qa`. The panel is a separate Tauri window
(WebView2, if you can't/won't install that the awesomium branch is still up on Github) 
that sits on top of the game and keeps its own focus, so you can
use it while the game keeps running - same trick the old in-game awesomium
browser did, but without the jank.

The window has buttons to switch to **mini mode** (a strip of favourites,
the window shrinks to fit) or close it. Favourite commands by starring them.

## Keyboard

| Key | Does |
|---|---|
| `/` | jump to the filter |
| `Enter` in the filter | jump to the first match and focus it |
| `Escape` in the filter | clear it |
| `Tab` / `Enter` | every list row is a button - walk the zones, dungeons, gear sets and quests with the keyboard |

## Layout

| Path | What it is |
|---|---|
| `index.js` | the toolbox module: packet hooks, commands, and the panel API server |
| `ui/index.html` | the panel page - served by the module, loaded by the overlay |
| `commands.json` | the menu layout, and the `"mini"` list of favourites |
| `tauri/` | the Tauri overlay app (Rust) |
| `tools/check-api.js` | smoke test for the panel API |
| `tools/check-ui.js` | browser test for the panel itself |
| `tools/serve.js` | run the panel without the game |

The module serves the panel on `http://127.0.0.1:7331/` and the overlay simply
points its webview at that URL, so the page talks to the module with plain
relative fetches - no IPC layer in between. The overlay's own IPC (window
drag, close, resize) is allowed for `http://127.0.0.1` by
`tauri/src-tauri/capabilities/default.json`.

## Mini mode and favourites

Every item in the panel has a star (`☆` / `★`) in its header. Clicking it pins
the item to the mini strip. One-liners stay inline in a row; the menu-like
ones get their own compact block

The list lives on the module side in `panel.json` (with the logger options),
so it survives restarts and is the same for the overlay and for a plain
browser. The seed comes from the `"mini"` list in `commands.json`:

```json
"mini": ["No die", "No cooldown", "MP full", "Speed", "Kill range"]
```

`panel.json` is created the first time you click a star and is not part of
the published module.

## Build the overlay

```
cd tauri/src-tauri
cargo build --release
```

Needs Rust 1.85+ and the WebView2 runtime (default on Windows 10+).

The exe lands in `tauri/src-tauri/target/release/qa-tauri.exe`. Put it next to
`index.js` in the module folder, or point `QA_TAURI_EXE` at it - the module
starts the overlay on every `/8 qa` and a second start just focuses the
window that is already open.

## Run it without the game

```
node tools/check-api.js
```

Boots the module against a stub toolbox and serves the panel on
`http://127.0.0.1:7331/` - open that in any browser to click around. The same
port is used by the overlay; override it with `QA_TAURI_PORT`.

`node tools/check-ui.js` drives the panel in the installed Chrome and checks
every feature (commands, toggles, chains, search, quests, item search, auto
actions, reset, keyboard, mini mode). It needs `npm i playwright-core` - no
browser download, it uses the Chrome that is already installed.

`node tools/serve.js` boots the module against a stub toolbox and starts the
overlay on top of it, so you can click through the panel without the game.
