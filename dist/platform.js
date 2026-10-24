"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrinnovAltitudePlatform = void 0;
const settings_1 = require("./settings");
const trinnovClient_1 = require("./trinnovClient");
const platformAccessory_1 = require("./platformAccessory");
class TrinnovAltitudePlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    accessories = [];
    clients = [];
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.log.info(`Initializing Trinnov Altitude Platform v${settings_1.PLUGIN_VERSION}: "${this.config.name || 'Trinnov Altitude'}"`);
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
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.push(accessory);
    }
    discoverDevices() {
        const rawDevices = this.config.devices || [];
        const devices = [...rawDevices];
        // Also support top-level single-device configuration in case "host" was put directly on the platform block
        if (devices.length === 0 && typeof this.config.host === 'string' && this.config.host.trim()) {
            devices.push({
                name: this.config.name || 'Trinnov Altitude32',
                host: this.config.host.trim(),
                port: this.config.port || 44100,
                mac: this.config.mac,
                minVolumeDb: this.config.minVolumeDb,
                maxVolumeDb: this.config.maxVolumeDb,
                enableVolumeSlider: this.config.enableVolumeSlider,
                volumeAccessoryType: this.config.volumeAccessoryType,
                enableMuteSwitch: this.config.enableMuteSwitch,
                enableBypassSwitch: this.config.enableBypassSwitch,
                enableTvAccessory: this.config.enableTvAccessory,
                inputs: this.config.inputs,
                presets: this.config.presets,
            });
        }
        const activeUUIDs = new Set();
        if (devices.length === 0) {
            this.log.warn('No Trinnov Altitude devices configured in Homebridge config.');
            return;
        }
        this.log.info(`Configuring ${devices.length} Trinnov Altitude processor(s)...`);
        for (const [index, deviceConfig] of devices.entries()) {
            if (!deviceConfig.host) {
                this.log.warn(`Device #${index + 1} is missing IP / host. Skipping.`);
                continue;
            }
            const deviceName = deviceConfig.name?.trim() || `Trinnov Altitude ${index + 1}`;
            const port = deviceConfig.port || 44100;
            this.log.info(`[${deviceName}] Setting up at ${deviceConfig.host}:${port}`);
            const client = new trinnovClient_1.TrinnovClient({
                host: deviceConfig.host,
                port,
                mac: deviceConfig.mac,
                clientName: deviceConfig.clientName || 'Homebridge',
                minVolumeDb: deviceConfig.minVolumeDb,
                maxVolumeDb: deviceConfig.maxVolumeDb,
            }, this.log);
            this.clients.push(client);
            client.start();
            // 1. Register Standard Bridged Accessory (Appears automatically in your HomeKit Home!)
            const bridgedIdentifier = `trinnov:bridged:${deviceConfig.host}:${port}`;
            const bridgedUuid = this.api.hap.uuid.generate(bridgedIdentifier);
            activeUUIDs.add(bridgedUuid);
            const existingAccessory = this.accessories.find((acc) => acc.UUID === bridgedUuid);
            if (existingAccessory) {
                this.log.info(`[${deviceName}] Restoring existing bridged accessory from cache: "${existingAccessory.displayName}"`);
                existingAccessory.displayName = deviceName;
                new platformAccessory_1.TrinnovBridgedAccessory(this, existingAccessory, client, {
                    ...deviceConfig,
                    name: deviceName,
                });
                this.api.updatePlatformAccessories([existingAccessory]);
            }
            else {
                this.log.info(`[${deviceName}] Registering new bridged accessory in HomeKit: "${deviceName}"`);
                const accessory = new this.api.platformAccessory(deviceName, bridgedUuid);
                new platformAccessory_1.TrinnovBridgedAccessory(this, accessory, client, {
                    ...deviceConfig,
                    name: deviceName,
                });
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
            // 2. Unbridged Television / Receiver Accessory (Enabled by default so Apple TV Remote & hardware volume buttons work!)
            if (deviceConfig.enableTvAccessory !== false) {
                const tvIdentifier = `trinnov:tv:${deviceConfig.host}:${port}`;
                const tvUuid = this.api.hap.uuid.generate(tvIdentifier);
                const tvAccessory = new this.api.platformAccessory(`${deviceName} Receiver`, tvUuid, 34 /* Categories.AUDIO_RECEIVER */ || 31 /* Categories.TELEVISION */);
                new platformAccessory_1.TrinnovTelevisionAccessory(this, tvAccessory, client, {
                    ...deviceConfig,
                    name: `${deviceName} Receiver`,
                });
                try {
                    this.api.publishExternalAccessories(settings_1.PLUGIN_NAME, [tvAccessory]);
                    this.log.info(`[${deviceName}] Published Receiver accessory for Apple TV Remote volume & input control.`);
                }
                catch (err) {
                    const error = err;
                    this.log.error(`[${deviceName}] Failed to publish external TV accessory: ${error.message}`);
                }
            }
        }
        // Clean up any stale cached accessories that were removed from config
        const staleAccessories = this.accessories.filter((acc) => !activeUUIDs.has(acc.UUID));
        if (staleAccessories.length > 0) {
            this.log.info(`Removing ${staleAccessories.length} stale cached Trinnov accessory(ies)...`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, staleAccessories);
        }
    }
}
exports.TrinnovAltitudePlatform = TrinnovAltitudePlatform;
//# sourceMappingURL=platform.js.map