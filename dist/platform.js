"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrinnovAltitudePlatform = void 0;
exports.normalizePlatformConfig = normalizePlatformConfig;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const settings_1 = require("./settings");
const trinnovClient_1 = require("./trinnovClient");
const platformAccessory_1 = require("./platformAccessory");
function normalizePlatformConfig(config) {
    const platformName = typeof config.name === 'string' && config.name.trim().length > 0
        ? config.name.trim()
        : 'Trinnov Altitude';
    const rawDevices = Array.isArray(config.devices)
        ? config.devices
        : [];
    const devices = rawDevices
        .filter((d) => Boolean(d && typeof d === 'object'))
        .map((d) => ({
        ...d,
        name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Trinnov Altitude32',
        host: typeof d.host === 'string' ? d.host.trim() : '',
        port: typeof d.port === 'number' && Number.isFinite(d.port) && d.port >= 1 && d.port <= 65535
            ? Math.floor(d.port)
            : settings_1.TRINNOV_DEFAULT_PORT,
    }));
    // Also support top-level single-device configuration
    if (devices.length === 0 && typeof config.host === 'string' && config.host.trim()) {
        const rawPort = config.port;
        devices.push({
            name: platformName !== 'Trinnov Altitude' ? platformName : 'Trinnov Altitude32',
            host: config.host.trim(),
            port: typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535
                ? Math.floor(rawPort)
                : settings_1.TRINNOV_DEFAULT_PORT,
            mac: config.mac,
            clientName: config.clientName,
            minVolumeDb: config.minVolumeDb,
            maxVolumeDb: config.maxVolumeDb,
            enableVolumeSlider: config.enableVolumeSlider,
            volumeAccessoryType: config.volumeAccessoryType,
            enableMuteSwitch: config.enableMuteSwitch,
            enableBypassSwitch: config.enableBypassSwitch,
            inputs: config.inputs,
            presets: config.presets,
        });
    }
    return {
        name: platformName,
        devices,
    };
}
class TrinnovAltitudePlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    accessories = [];
    clients = [];
    managedDevices = [];
    normalizedConfig;
    registeredPlatformName;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.normalizedConfig = normalizePlatformConfig(this.config);
        this.registeredPlatformName = this.config.platform
            ? String(this.config.platform).split('.').pop() || settings_1.PLATFORM_NAME
            : settings_1.PLATFORM_NAME;
        this.log.info(`Initializing Trinnov Altitude Platform v${settings_1.PLUGIN_VERSION}: "${this.normalizedConfig.name}"`);
        this.api.on('didFinishLaunching', () => {
            this.discoverDevices();
        });
        this.api.on('shutdown', () => {
            for (const client of this.clients) {
                client.stop();
            }
        });
    }
    /**
     * Homebridge invokes this method for cached accessories restored from disk.
     */
    configureAccessory(accessory) {
        this.log.info('Loading cached accessory:', accessory.displayName);
        this.accessories.push(accessory);
    }
    resolveActiveSourceName(entry) {
        const profileId = entry.client.state.currentProfileId;
        if (profileId === null || profileId === undefined) {
            return undefined;
        }
        const configuredInput = (entry.config.inputs || []).find((inp, idx) => (typeof inp.id === 'number' ? inp.id : idx) === profileId);
        if (configuredInput?.name && configuredInput.name.trim()) {
            return configuredInput.name.trim();
        }
        return entry.client.state.profiles.get(profileId);
    }
    writeDiscoveryFile() {
        try {
            const storagePath = typeof this.api?.user?.storagePath === 'function'
                ? this.api.user.storagePath()
                : undefined;
            if (!storagePath) {
                return;
            }
            const payload = {
                version: 1,
                plugin: settings_1.PLUGIN_NAME,
                updatedAt: new Date().toISOString(),
                pid: process.pid,
                processors: this.managedDevices.map((entry) => ({
                    id: `${entry.config.host}:${entry.config.port || settings_1.TRINNOV_DEFAULT_PORT}`,
                    name: entry.config.name,
                    driver: 'trinnov',
                    host: entry.config.host,
                    port: entry.config.port || settings_1.TRINNOV_DEFAULT_PORT,
                    powered: entry.client.state.power,
                    activeSource: this.resolveActiveSourceName(entry),
                })),
            };
            const filePath = (0, node_path_1.join)(storagePath, settings_1.TRINNOV_DISCOVERY_FILENAME);
            (0, node_fs_1.writeFileSync)(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.debug(`Unable to write ${settings_1.TRINNOV_DISCOVERY_FILENAME}: ${msg}`);
        }
    }
    discoverDevices() {
        // 1. Remove any legacy bridged accessories from cache so ONLY the Receiver exists in HomeKit
        if (this.accessories.length > 0) {
            this.log.info(`Removing ${this.accessories.length} legacy bridged accessory(ies) so only the Receiver is exposed...`);
            try {
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, this.registeredPlatformName, this.accessories);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log.debug(`Failed to unregister legacy cached accessories: ${msg}`);
            }
            this.accessories.length = 0;
        }
        const { devices } = this.normalizedConfig;
        if (devices.length === 0) {
            this.log.warn('No Trinnov Altitude devices configured in Homebridge config.');
            return;
        }
        this.log.info(`Configuring ${devices.length} Trinnov Altitude Receiver(s)...`);
        for (const [index, deviceConfig] of devices.entries()) {
            if (!deviceConfig.host) {
                this.log.warn(`Device #${index + 1} is missing IP / host. Skipping.`);
                continue;
            }
            const hostValidation = (0, trinnovClient_1.validateTrinnovHost)(deviceConfig.host);
            if (!hostValidation.valid) {
                this.log.error(`Device #${index + 1} (${deviceConfig.name || 'Trinnov'}): ${hostValidation.reason} Skipping.`);
                continue;
            }
            const deviceName = deviceConfig.name?.trim() || 'Trinnov Altitude32';
            const port = deviceConfig.port || settings_1.TRINNOV_DEFAULT_PORT;
            this.log.info(`[${deviceName}] Setting up Receiver at ${deviceConfig.host}:${port}`);
            const client = new trinnovClient_1.TrinnovClient({
                host: deviceConfig.host,
                port,
                mac: deviceConfig.mac,
                clientName: deviceConfig.clientName || 'Homebridge',
                minVolumeDb: deviceConfig.minVolumeDb,
                maxVolumeDb: deviceConfig.maxVolumeDb,
            }, this.log);
            this.clients.push(client);
            const managedEntry = {
                config: {
                    ...deviceConfig,
                    name: deviceName,
                    port,
                },
                client,
            };
            this.managedDevices.push(managedEntry);
            client.on('powerChange', () => this.writeDiscoveryFile());
            client.on('profileChange', () => this.writeDiscoveryFile());
            client.start();
            // Publish ONLY the single unified Receiver accessory
            const receiverIdentifier = `trinnov:receiver:${deviceConfig.host}:${port}`;
            const receiverUuid = this.api.hap.uuid.generate(receiverIdentifier);
            const receiverAccessory = new this.api.platformAccessory(deviceName, receiverUuid, 34 /* Categories.AUDIO_RECEIVER */ || 31 /* Categories.TELEVISION */);
            new platformAccessory_1.TrinnovReceiverAccessory(this, receiverAccessory, client, {
                ...deviceConfig,
                name: deviceName,
                port,
            });
            try {
                this.api.publishExternalAccessories(settings_1.PLUGIN_NAME, [receiverAccessory]);
                this.log.info(`[${deviceName}] Published Receiver accessory to HomeKit.`);
            }
            catch (err) {
                const error = err;
                this.log.error(`[${deviceName}] Failed to publish Receiver accessory: ${error.message}`);
            }
        }
        this.writeDiscoveryFile();
    }
}
exports.TrinnovAltitudePlatform = TrinnovAltitudePlatform;
//# sourceMappingURL=platform.js.map