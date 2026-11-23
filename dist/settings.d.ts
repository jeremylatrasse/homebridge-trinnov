/**
 * Name of the platform registered in Homebridge.
 * This must match the platform name used in config.json and config.schema.json.
 */
export declare const PLATFORM_NAME = "TrinnovAltitude";
/**
 * Name of the npm package.
 * This must match the name in package.json.
 */
export declare const PLUGIN_NAME = "homebridge-trinnov-altitude";
/**
 * Default Trinnov ASCII automation TCP port.
 */
export declare const TRINNOV_DEFAULT_PORT = 44100;
/**
 * Discovery file written into Homebridge storagePath so companion plugins
 * (such as homebridge-pulse8-appletv-cec) can discover live Trinnov processors.
 */
export declare const TRINNOV_DISCOVERY_FILENAME = "homebridge-trinnov-discovery.json";
/**
 * Reads the current plugin version from package.json dynamically so
 * Homebridge logs and HomeKit FirmwareRevision always match package.json.
 */
export declare function loadPluginVersion(): string;
export declare const PLUGIN_VERSION: string;
