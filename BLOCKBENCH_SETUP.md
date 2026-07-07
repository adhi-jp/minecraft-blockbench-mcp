# Blockbench Setup

Blockbench source is installed under:

```sh
external/blockbench
```

Current source revision:

```text
8fe8d9d9568de8233d77cd592744acad495d46b0
```

## Installed Runtime

- Node.js: `v24.13.0`
- npm: `11.11.0`
- Electron: `v40.8.3`
- Blockbench package version: `5.1.4`

## Commands

Run the web app:

```sh
cd external/blockbench
npm run serve
```

Open:

```text
http://127.0.0.1:8000/
```

Build the web bundle:

```sh
cd external/blockbench
npm run build-web
```

Run the Electron development app:

```sh
cd external/blockbench
npm run dev
```

In this Codex sandbox, commands that bind localhost ports or launch Electron may need elevated execution permissions. The local WSL environment has both `DISPLAY=:0` and `WAYLAND_DISPLAY=wayland-0`, so WSLg GUI launch should be available.

## GeckoLib plugin (one-time install)

The MCP `geckolib_*` commands require the third-party **GeckoLib Models &
Animations** Blockbench plugin (plugin id `geckolib`; tested with 4.2.5 on
Blockbench 5.1.4). Install it once inside Blockbench:

1. **File → Plugins → Available**, search "GeckoLib", click **Install**.

The install persists across restarts (Blockbench records it in its local
plugin registry). Headless installation by file placement alone does not work —
Blockbench only loads plugins listed in that registry. From a DevTools console
(`npm run dev` exposes remote debugging on port 9223) the same install can be
scripted with `Plugins.all.find(p => p.id === 'geckolib').install()`.

Until the plugin is installed, `geckolib_*` MCP commands fail per call with
`E_PLUGIN_DEPENDENCY_MISSING`; everything else works without it.
