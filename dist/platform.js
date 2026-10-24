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
        this.log.info('Loading cached accessory:', accessory.displayName);
        this.accessories.push(accessory);
    }
    discoverDevices() {
        // 1. Remove any legacy bridged accessories from cache so ONLY the Receiver exists in HomeKit
        if (this.accessories.length > 0) {
            this.log.info(`Removing ${this.accessories.length} legacy bridged accessory(ies) so only the Receiver is exposed...`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, this.accessories);
            this.accessories.length = 0;
        }
        const rawDevices = this.config.devices || [];
        const devices = [...rawDevices];
        // Also support top-level single-device configuration
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
                inputs: this.config.inputs,
                presets: this.config.presets,
            });
        }
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
            const deviceName = deviceConfig.name?.trim() || `Trinnov Altitude32`;
            const port = deviceConfig.port || 44100;
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
            client.start();
            // Publish ONLY the single unified Receiver accessory
            const receiverIdentifier = `trinnov:receiver:${deviceConfig.host}:${port}`;
            const receiverUuid = this.api.hap.uuid.generate(receiverIdentifier);
            const receiverAccessory = new this.api.platformAccessory(deviceName, receiverUuid, 34 /* Categories.AUDIO_RECEIVER */ || 31 /* Categories.TELEVISION */);
            new platformAccessory_1.TrinnovReceiverAccessory(this, receiverAccessory, client, {
                ...deviceConfig,
                name: deviceName,
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
    }
}
exports.TrinnovAltitudePlatform = TrinnovAltitudePlatform;
//# sourceMappingURL=platform.js.map