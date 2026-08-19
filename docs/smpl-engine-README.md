# DSD SMPL-Engine

DSD's web-based, AI-driven 3D authoring environment — TypeScript + Three.js, **WebGL2 baseline** with WebGPU as a later progressive enhancement. (Internal package scope remains `@engine/*`.)

- [MASTER.md](MASTER.md) — canonical system design; the **MCP-first** architecture (every subsystem is AI-addressable).
- [roadmap-001.md](roadmap-001.md) — phased delivery plan.

> **Status:** Phases 1–7 landed; Phase 9 (Digital Twin Simulator) complete; the
> KOBI UR5e digital-twin / physics-rehearsal track (`KOBI-SIMULATOR-MASTERPLAN.md`)
> is through Phase 4 engine-side, with the deployed player live-mirroring `ursim`
> over postMessage MCP. Plan-012 (local-folder projects) and the boot-splash work
> have shipped (uncommitted). The MCP spine, ECS, fixed-step physics (Rapier 3D),
> scripting (esbuild-wasm + Worker isolation), procedural + imported animation,
> nav grids, audio, VFX, prefabs, materials, behavior trees, the digital-twin +
> twin-sim packs, and the standalone web player + Docker `engine-deployer`
> all ship; the URDF / robotics / sim-gate / kobi-assets / ros-bridge packs
> power KOBI. Per-phase notes in [docs/phase-1.md](docs/phase-1.md) …
> [docs/phase-6.md](docs/phase-6.md); per-plan notes in `docs/plan-NNN-*.md`.

## Layout

```
packages/
  types/        @engine/types  — shared types, HostCapabilities + capability gating
  engine-core/  @engine/core   — the engine: ECS, scheduler, physics, scripting,
                                 renderer, scene I/O, commands/undo, and the MCP spine
    src/mcp/        MCP spine — McpProvider contract + McpRegistry
    src/ecs/        World, components, queries
    src/physics/    Rapier fixed-step physics system
    src/scripting/  behavior lifecycle + registry
    src/scene/      glTF-sidecar serialization + mutation commands
    src/render/     RenderSyncSystem (ECS→Three.js) + ThreeViewport
    src/providers/  built-in MCP providers (scene/physics/script/renderer/undo/…)
  runtime/      @engine/runtime — deployed browser runtime (Vite)
  editor/       @engine/editor  — editor app (Vite + React): viewport, hierarchy,
                                 inspector, console — all MCP-driven
packs/          domain extension packs (added in Phase 4)
docker/         per-service Dockerfiles + nginx config
e2e/            Playwright smoke tests
```

## Run the stack (Docker — primary)

**Docker Compose is the canonical way to run this project.** Everything ships
in containers (roadmap §3.6); no host installs beyond Docker + Compose. The
host-Node dev paths further down are for library work (tests, typecheck,
linting) only — the editor and runtime you actually use are always the
container builds.

First run / rebuild after a code change:

```bash
docker compose up -d --build       # or: npm run stack:rebuild
```

Subsequent runs (no source changes):

```bash
docker compose up -d               # or: npm run stack:up
```

Services and ports:

| Service          | URL                          | What it is                                                                  |
|------------------|------------------------------|-----------------------------------------------------------------------------|
| `engine-editor`  | http://localhost:4174        | Editor preview bundle (nginx, static). Auto-exposes to `host.docker.internal:8765`. |
| `engine-runtime` | http://localhost:4173        | Deployed runtime preview (nginx, static).                                   |
| `engine-deployer`| http://localhost:4180/health | 1-click "Deploy as WebGL" sidecar (drives the Docker daemon).               |

All three share the `engine-net` bridge network and address each other by
container name (`engine-runtime`, `engine-editor`, `engine-deployer`); later
phases add `mcp-registry`, `gen-trellis`, and `gen-flux` to the same network.

### The edit → rebuild loop

The editor and runtime images bake a static Vite bundle into nginx — there is
no in-container HMR. **Any source edit (anywhere under `packages/`) requires
rebuilding the affected image** before it appears in the browser:

```bash
# Edit anything under packages/editor/** or packages/engine-core/**
docker compose up -d --build editor       # rebuild + restart just the editor
# (or `npm run stack:rebuild` to rebuild all three services)
```

Then hard-refresh the browser (Ctrl+Shift+R) so it picks up the new asset
hashes. Which service to rebuild for which change:

| You changed…                                                | Rebuild       |
|-------------------------------------------------------------|---------------|
| `packages/editor/**` only                                   | `editor`      |
| `packages/runtime/**` only                                  | `runtime`     |
| `packages/engine-core/**` or `packages/types/**`            | `editor` + `runtime` (and `deployer` if the player bundle is affected) |
| `packages/runtime/src/player.ts` / anything in the player   | `deployer` (rebakes `player.js`) + `runtime` |
| `docker/**`, `docker-compose.yml`                           | all three     |

`npm run stack:rebuild` is the safe blanket option — it rebuilds and restarts
every service.

### Other knobs

- **Bridge URL baked into the editor.** The editor image bakes
  `VITE_EXPOSE_URL=ws://host.docker.internal:8765` so opening
  http://localhost:4174 auto-connects to a `smpl-mcp-bridge` running on the
  host. Override at build time:
  `docker compose build --build-arg VITE_EXPOSE_URL=ws://other-host:8765 editor`.
- **Logs.** `docker compose logs -f editor` / `runtime` / `deployer`.
- **Health.** `docker compose ps` (each service has a healthcheck on its
  container port).
- **Reset.** `docker compose down` to stop; `docker compose down -v` to also
  drop the named volumes (`project-data`, `generated-assets`).

## Host-Node tasks (tests, typecheck, lint)

These don't run the editor or runtime — they're for CI-style checks and
library development against the workspace packages.

```bash
npm install
npm run typecheck     # tsc project build + app noEmit checks
npm test              # Vitest unit tests
npm run test:e2e      # Playwright smoke (runtime preview :4173 + editor preview :4174)
```

The Playwright smoke targets the same `:4173` / `:4174` ports as the Docker
stack, so bring the stack up first (`npm run stack:up`) before running
`test:e2e`.

> **Raw Vite dev servers (`npm run dev:runtime` / `dev:editor` on
> `:5173` / `:5174`) are not the supported runtime path.** They exist for
> debugging Vite plugin / HMR issues in isolation; the editor and deployed
> player you ship and validate are always the Docker images on `:4174` /
> `:4173`.

## MCP-first

The engine's control surface **is** an MCP server: every subsystem registers
tools/resources/events into one `McpRegistry`, and the editor UI, AI agents, and
external tools all drive the engine through that same surface. See
[MASTER.md](MASTER.md) §4 for the full tool catalog. Try it in code:

```ts
import { Engine } from "@engine/core";
const engine = new Engine({ profile: "editor" });

// Author a scene the way an AI agent would — one undoable transaction:
const { content } = await engine.mcp.callTool("scene.createEntity", {
  components: { Transform: { position: [0, 3, 0] }, MeshRenderer: { primitive: "box" } },
});
await engine.mcp.callTool("undo.undo", {}); // collapses the whole create

// Discover the surface at runtime:
await engine.mcp.readResource("engine://mcp/catalog");
```

## Drive the engine from an AI MCP client

`@engine/mcp-bridge` re-exposes the live editor as an official MCP server
(stdio), so Claude Code / Augment Code / Claude Desktop can drive it. Two
processes, connected by a WebSocket on `ws://localhost:8765`:

```
MCP client  ──stdio──►  smpl-mcp-bridge (Node)  ──WebSocket──►  Editor (browser)
```

Build the bridge once (`npm run build`), then register it with your client:

```bash
# Claude Code (run from this repo root so `npx -w` resolves)
claude mcp add smpl-engine -- npx -y -w @engine/mcp-bridge smpl-mcp-bridge
```

For clients that ignore `cwd` in their MCP config, point `node` at the built
script directly — this also avoids the workspace-resolution path entirely:

```json
{
  "mcpServers": {
    "smpl-engine": {
      "command": "node",
      "args": ["<repo>/packages/mcp-bridge/dist/cli.js"]
    }
  }
}
```

The bridge is a **host process** (it speaks stdio to your MCP client and binds
TCP on the host) — it deliberately is not in the Docker stack. The editor
container reaches it through `host.docker.internal:8765`, which the editor
image already bakes as the auto-expose target, so opening http://localhost:4174
connects on its own. You only need to visit the editor's **MCP Servers** panel
and click **Expose** with `ws://localhost:8765` if you're running the editor
on the host (e.g. `npm run dev:editor`) or want to switch to a different
bridge port. Until the editor connects, the only tool exposed is
`engine_status` (it reports the connection state). Once Expose succeeds the
bridge fires `tools/list_changed` and the full editor-profile catalog (~178
tools — `scene_*`, `undo_*`, `physics_*`, …) appears in the client.

**Running more than one MCP client at once.** Each client spawns its own
bridge process, and only one can bind a given port. Pass `--port <n>` in the
extra clients' args (e.g. `8766`, `8767`) and type the matching
`ws://localhost:<n>` into the editor's Expose field for whichever bridge you
want to drive. The bridge now exits with a clear `EADDRINUSE` message if the
port is taken, so the conflict surfaces in your client's UI immediately.

On Windows, paths with spaces (e.g. `C:\Users\Some Name\…`) break unquoted
config strings; use the 8.3 short name (`dir /x` shows it — e.g.
`C:\Users\SOMENA~1\…`) or move the repo to a space-free path.
