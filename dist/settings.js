"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_VERSION = exports.TRINNOV_DISCOVERY_FILENAME = exports.TRINNOV_DEFAULT_PORT = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
exports.loadPluginVersion = loadPluginVersion;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Name of the platform registered in Homebridge.
 * This must match the platform name used in config.json and config.schema.json.
 */
exports.PLATFORM_NAME = 'TrinnovAltitude';
/**
 * Name of the npm package.
 * This must match the name in package.json.
 */
exports.PLUGIN_NAME = 'homebridge-trinnov-altitude';
/**
 * Default Trinnov ASCII automation TCP port.
 */
exports.TRINNOV_DEFAULT_PORT = 44100;
/**
 * Discovery file written into Homebridge storagePath so companion plugins
 * (such as homebridge-pulse8-appletv-cec) can discover live Trinnov processors.
 */
exports.TRINNOV_DISCOVERY_FILENAME = 'homebridge-trinnov-discovery.json';
/**
 * Reads the current plugin version from package.json dynamically so
 * Homebridge logs and HomeKit FirmwareRevision always match package.json.
 */
function loadPluginVersion() {
    try {
        const pkgPath = (0, node_path_1.join)(__dirname, '..', 'package.json');
        const pkg = JSON.parse((0, node_fs_1.readFileSync)(pkgPath, 'utf8'));
        return pkg.version || '1.0.0';
    }
    catch {
        return '1.0.0';
    }
}
exports.PLUGIN_VERSION = loadPluginVersion();
//# sourceMappingURL=settings.js.map