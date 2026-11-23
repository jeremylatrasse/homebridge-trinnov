# Building & Maintaining `homebridge-trinnov-altitude`

This guide documents everything required to build, extend, test, version, and release `homebridge-trinnov-altitude` across Node.js, Homebridge Config UI X, Xcode, and GitHub.

---

## 1. Architecture & File Map

| Path | Role |
| :--- | :--- |
| [src/index.ts](src/index.ts) | Homebridge CommonJS entry point (`export = (api) => ...`). |
| [src/settings.ts](src/settings.ts) | Defines `PLUGIN_NAME` (`homebridge-trinnov-altitude`), `PLATFORM_NAME` (`TrinnovAltitude`), `TRINNOV_DEFAULT_PORT` (`44100`), `TRINNOV_DISCOVERY_FILENAME` (`homebridge-trinnov-discovery.json`), and `PLUGIN_VERSION`. |
| [src/platform.ts](src/platform.ts) | `TrinnovAltitudePlatform` (`DynamicPlatformPlugin`), config normalization (`normalizePlatformConfig`), external `AUDIO_RECEIVER` publication, legacy cached bridged-accessory cleanup, and `homebridge-trinnov-discovery.json` export. |
| [src/platformAccessory.ts](src/platformAccessory.ts) | `TrinnovReceiverAccessory`: HomeKit `Service.Television` (`AUDIO_RECEIVER`), explicitly named `Service.InputSource` profiles, in-room volume slider (`Service.Fan` or `Service.Lightbulb`), optional Mute/Bypass switches, named Preset switches, `sanitizeHomeKitName`, and `isExplicitlyNamed`. |
| [src/trinnovClient.ts](src/trinnovClient.ts) | `TrinnovClient`: TCP socket lifecycle (port `44100`), ASCII automation protocol parser, multi-layer reachability probe (`ping` + TCP `44100` + HTTP `80`), `resolvePingPath`, Wake-on-LAN UDP magic packet broadcast, secured shutdown sequence, and dB $\leftrightarrow$ percentage volume math. |
| [config.schema.json](config.schema.json) | Homebridge Config UI X schema (`pluginAlias` must equal `PLATFORM_NAME`). |
| [test-trinnov.mjs](test-trinnov.mjs) | Node unit, protocol, schema slider audit, discovery, and mock-server test suite executed against compiled `dist/` via `npm test`. |
| [homebridge-trinnov/main.swift](homebridge-trinnov/main.swift) | macOS Swift diagnostic CLI (`--probe`, `--status`, `--monitor`, `--wake`) built by the Xcode project. |
| [dist/](dist/) | **Tracked in git** compiled output for zero-compile GitHub installations. |

---

## 2. Core Design Rules (Do Not Break)

### A. Zero-Compile GitHub Installs
Homebridge users often install directly from GitHub (`npm install git+https://github.com/jeremylatrasse/homebridge-trinnov.git`) on systems without `typescript` or `devDependencies`.
1. **Always commit updated `dist/` files** whenever `src/` changes. (`.gitignore` intentionally keeps `dist/` tracked.)
2. **Keep `"dependencies": {}` empty** in `package.json`. Use Node.js built-ins (`node:net`, `node:dgram`, `node:child_process`, `node:fs`, `node:events`, `node:path`) and put `@types/node`, `homebridge`, and `typescript` in `devDependencies`.
3. **Never add `"prepare"` or `"postinstall"` scripts** in `package.json`—they run during `npm install` on target Homebridge hosts and can fail in restricted environments. Use `"prepublishOnly": "npm run compile"` instead.
4. **Keep CommonJS entry export** (`export = (api: API) => ...`) in `src/index.ts`, and resolve scoped platform names safely in `src/platform.ts`:
   ```ts
   this.registeredPlatformName = this.config.platform
     ? String(this.config.platform).split('.').pop() || PLATFORM_NAME
     : PLATFORM_NAME;
   ```

### B. Child Bridge & Hardware Resilience
* Never throw uncaught exceptions during startup or `didFinishLaunching` if a Trinnov Altitude processor is in standby, unreachable, or misconfigured (`validateTrinnovHost()` logs a clear error and skips invalid hosts in `discoverDevices()`).
* `resolvePingPath()` checks `PATH` plus standard macOS/Linux directories (`/sbin`, `/bin`, `/usr/sbin`, `/usr/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) because `launchd`/`systemd`/Docker Child Bridges often omit `/sbin`.
* When a Trinnov Altitude processor enters standby, its internal Linux OS powers down completely. `probeUnitReachability()` checks ICMP `ping`, TCP automation (`44100`), and HTTP (`80`) concurrently so a half-open TCP socket never falsely reports the unit as awake when `ping` and `http` are both silent.
* On Homebridge `shutdown`, stop all `TrinnovClient` instances (clearing timers and sending `bye\r\n` before closing open TCP sockets).

---

## 3. Trinnov Automation Protocol & State Machine (`src/trinnovClient.ts`)

`TrinnovClient` connects to the Trinnov Altitude ASCII automation server over raw TCP (default port `44100`) and announces itself with `id <clientName>` (default `Homebridge`).

### Command & Notification Rules

| Direction | Frame / Command | Meaning & Required Behavior |
| :--- | :--- | :--- |
| **TX (Handshake)** | `id <clientName>` | Required immediately on TCP connect before issuing commands. Followed by `send_volume`, `send_profile`, `send_preset`. |
| **TX (Heartbeat)** | `send_volume`, `get_current_profile`, `get_all_label` | Polled every `heartbeatInterval` (`10s`) while reachable to keep HomeKit state synchronized. |
| **RX** | `VOLUME <dB>` | Updates `state.volume` (dB) and emits `volumeChange(db, percentage)`. |
| **RX** | `MUTE <0\|1>` | Updates `state.mute` and emits `muteChange(Boolean)`. |
| **RX** | `DIM <0\|1>` | Updates `state.dim` and emits `dimChange(Boolean)`. |
| **RX** | `BYPASS <0\|1>` | Updates `state.bypass` and emits `bypassChange(Boolean)`. |
| **RX** | `AUDIOSYNC <0\|1>` | Updates `state.audiosync` and emits `audioSyncChange(Boolean)`. |
| **RX** | `PROFILE <id>: <name>` / `CURRENT_PROFILE <id>` / `PROFILE <id>` | Updates `state.profiles` catalog or `state.currentProfileId` and emits `profileChange`. |
| **RX** | `LABEL <id>: <name>` / `CURRENT_PRESET <id>` / `PRESET <id>` | Updates `state.presets` catalog or `state.currentPresetId` and emits `presetChange`. |
| **TX (Power On)** | UDP Broadcast Magic Packet (Port `9`) | `6x 0xFF` + `16x MAC` broadcast to `255.255.255.255:9`, followed by rapid responsiveness polling (`startResponsivenessPolling('start')`). |
| **TX (Power Off)** | `power off SECURED FHZMCH48FE`, `power_off SECURED FHZMCH48FE`, `power_off_SECURED_FHZMCH48FE`, `power_off` | Transmits secured shutdown sequence with `\r\n` line endings and polls until `probeUnitReachability()` confirms all network layers (`ping`, `44100`, `80`) are offline. |

---

## 4. HomeKit Accessories & Companion Discovery

### HomeKit Services (`src/platformAccessory.ts`)
* Each configured Trinnov processor is published as a **single unified external accessory** (`publishExternalAccessories`, category `AUDIO_RECEIVER`) with:
  * `Service.Television` (`altitude-receiver`, primary service): Power (`Active` $\rightarrow$ WoL / Standby) and Input picker (`ActiveIdentifier` $\rightarrow$ `profile <id>`).
  * `Service.InputSource`: Only explicitly named profiles (`isExplicitlyNamed(input.name)`) are added and linked via `tvService.addLinkedService(inputService)`.
  * In-room Volume Slider (`Service.Fan` with `RotationSpeed` or `Service.Lightbulb` with `Brightness`): Maps `0%`–`100%` to `minVolumeDb`–`maxVolumeDb` (rounded to `0.5 dB` steps), and `On` to unmuted & powered.
  * Optional `Mute` switch, `Bypass` switch, and explicitly named `Preset` switches (`Service.Switch`).
* **Critical iOS Home Rule:** Never call `tvService.addLinkedService()` on `Fan`, `Lightbulb`, or `Switch` services—linking non-`InputSource` services to `Service.Television` causes iOS Home.app to hide their in-room tiles.
* **No `Service.TelevisionSpeaker`:** Any legacy `TelevisionSpeaker` service is actively removed so the iOS Control Center Apple TV Remote widget does not hijack hardware volume buttons.
* **UUID Stability:** Keep `receiverIdentifier` unchanged (`trinnov:receiver:${deviceConfig.host}:${port}`) so existing Apple Home room assignments and scenes do not break across upgrades.

### Companion Plugin Discovery (`homebridge-trinnov-discovery.json`)
* `TrinnovAltitudePlatform` writes `<storagePath>/homebridge-trinnov-discovery.json` on startup and whenever `powerChange` or `profileChange` fires.
* Companion plugins (such as `homebridge-pulse8-appletv-cec`) read this file to auto-discover Trinnov processors (`host`, `port`, `powered`, `activeSource`).

---

## 5. `config.schema.json` & Config UI X Rules

Homebridge Config UI X uses `@ng-formworks/core`, which automatically renders any bounded `"integer"` or `"number"` field (with `"minimum"` and `"maximum"`) as a **range slider** (`<input type="range">`) instead of a numeric text box.

* **Mandatory Rule:** Every numeric field (`"type": "integer"` or `"type": "number"`) in `config.schema.json` that defines `"minimum"` AND `"maximum"` **must** include:
  ```json
  "x-schema-form": {
    "type": "number"
  }
  ```
* Never use `"widget": "range"` or `"type": "range"`.
* Never add `"format": "hostname"` to `host` (it causes Config UI X to reject valid 4-octet IPv4 addresses); use the strict 4-octet IPv4 / RFC 1123 hostname `"pattern"` regex instead.
* Never add `"required": ["id", "name"]` inside `inputs.items` or `presets.items` (it breaks `id: 0` and unnamed rows in Config UI X).
* Keep `pluginAlias` (`"TrinnovAltitude"`) identical to `PLATFORM_NAME` in `src/settings.ts`.

### Slider Audit Command
Run this from the project root after any `config.schema.json` edit to verify valid JSON and zero unintended sliders (should print an empty table; also enforced automatically by `npm test`):

```bash
node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync("config.schema.json", "utf8"));
const hits = [];
function walk(node, path) {
  if (!node || typeof node !== "object") return;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const isBounded = Object.hasOwn(node, "minimum") && Object.hasOwn(node, "maximum");
  const isSliderType = types.includes("integer") || types.includes("number");
  const hasOverride = Boolean(
    node["x-schema-form"]?.type ||
    node["x-schema-form"]?.widget?.component ||
    typeof node["x-schema-form"]?.widget === "string" ||
    node.widget?.component ||
    typeof node.widget === "string"
  );
  if (isBounded && isSliderType && !hasOverride && path !== "schema.properties._bridge.properties.port") {
    hits.push({ path, type: node.type, minimum: node.minimum, maximum: node.maximum });
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.properties.${k}`);
  }
  if (node.items) {
    if (Array.isArray(node.items)) node.items.forEach((v, i) => walk(v, `${path}.items[${i}]`));
    else walk(node.items, `${path}.items`);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(node[key])) node[key].forEach((v, i) => walk(v, `${path}.${key}[${i}]`));
  }
}
walk(root.schema, "schema");
console.table(hits);
if (hits.length > 0) process.exit(1);
'
```

---

## 6. Local Development, Testing & Xcode Workflow

### Node / TypeScript Commands
```bash
npm install          # Install devDependencies locally
npm run compile      # Compile src/ -> dist/ via tsc
npm run watch        # Incremental compile during development
npm test             # Compiles TypeScript and runs test-trinnov.mjs
```

### Checklist When Modifying Features or Config
1. Update TypeScript source in `src/`.
2. If adding or changing config keys:
   * Update `normalizePlatformConfig()` / types in `src/platform.ts` and `src/platformAccessory.ts`.
   * Update `config.schema.json` (remembering `"x-schema-form": { "type": "number" }` for bounded numbers/integers).
   * Update the Configuration Options table in `README.md`.
3. Add or update assertions in `test-trinnov.mjs`.
4. Run `npm test` (which rebuilds `dist/` and runs all unit, mock-socket, discovery, and slider audit tests).
5. Verify `git status` includes updated `dist/` files alongside `src/`.

### Xcode Workflow (`⌘B` / `⌘R`)
* Opening `homebridge-trinnov.xcodeproj` provides a macOS build & diagnostic environment:
  * **Build (`⌘B`)** compiles TypeScript (`src/` $\rightarrow$ `dist/`) and installs local git hooks.
  * [`homebridge-trinnov/main.swift`](homebridge-trinnov/main.swift) provides a native macOS diagnostic CLI (`--probe`, `--status`, `--monitor`, `--wake`, `--host`, `--port`, `--mac`).

---

## 7. Git Versioning, Hooks & Release Pipeline

### Local Git Hooks (`.githooks/` & `.git/hooks/`)
This repository uses local hooks (`pre-commit`, `post-commit`, `pre-push`, installed via `make hooks`) to keep versions and `dist/` synchronized across npm and Xcode:
* **`pre-commit`:** Automatically unstages local-only Xcode files, increments the patch version in `package.json`, `package-lock.json`, and `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` inside `homebridge-trinnov.xcodeproj/project.pbxproj`, recompiles `dist/`, and stages `package.json`, `package-lock.json`, and `dist/`.
* **`post-commit`:** Ensures partial/IDE commits (e.g., Xcode Source Control UI) include the bumped version files and creates/updates the local `vX.Y.Z` tag.
* **`pre-push`:** Verifies that `HEAD` has an incremented version relative to the remote branch before pushing.
* **Bypass bumping when needed** (e.g., amending or keeping an explicit version):
  ```bash
  SKIP_VERSION_BUMP=1 git commit -m "..."
  ```

### GitHub Actions (`.github/workflows/bump-version.yml`)
* On every push to `main` / `master` (except `chore(release):` or `[skip ci]` commits), CI checks out the repo and creates/updates the `vX.Y.Z` git tag matching `package.json`.
* **Do not** add a second unconditional `npm version patch` step in CI while local `pre-commit` hooks are active, or every commit will be double-bumped.

### Publishing to npm & `homebridge/verified` Checklist
1. Inspect what will be included in the npm tarball (`.npmignore` excludes `src/`, tests, Xcode project, `.github/`, `.githooks/`, and `MAINTAINING.md`):
   ```bash
   npm pack --dry-run
   ```
2. Run `npm test` and confirm clean `git status`.
3. Publish (runs `prepublishOnly` $\rightarrow$ `npm run compile`):
   ```bash
   npm publish --access public
   ```
4. Before submitting or updating `github.com/homebridge/verified`:
   * Published publicly on npm with `"homebridge-plugin"` in `package.json` `keywords`.
   * Valid `config.schema.json` at root, `pluginAlias` matching `src/settings.ts`, and zero slider fields.
   * Child Bridge safe when the Trinnov processor is in standby or offline.
   * `README.md` documents installation, Apple Home pairing, Wake-on-LAN MAC configuration, and configuration options.
