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
        this.log.info(`Initializing Trinnov Altitude Platform: "${this.config.name || 'Trinnov Altitude'}"`);
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
        const devices = this.config.devices || [];
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
            const deviceIdentifier = `trinnov:${deviceConfig.host}:${deviceConfig.port || 44100}`;
            const uuid = this.api.hap.uuid.generate(deviceIdentifier);
            this.log.info(`[${deviceName}] Setting up at ${deviceConfig.host}:${deviceConfig.port || 44100}`);
            const client = new trinnovClient_1.TrinnovClient({
                host: deviceConfig.host,
                port: deviceConfig.port || 44100,
                mac: deviceConfig.mac,
                clientName: deviceConfig.clientName || 'Homebridge',
                minVolumeDb: deviceConfig.minVolumeDb,
                maxVolumeDb: deviceConfig.maxVolumeDb,
            }, this.log);
            this.clients.push(client);
            client.start();
            // In Apple HomeKit / HAP, Television / Receiver accessories MUST be published
            // as external accessories so Apple Home enables the Remote widget and Input selector.
            const accessory = new this.api.platformAccessory(deviceName, uuid, 34 /* Categories.AUDIO_RECEIVER */ || 31 /* Categories.TELEVISION */);
            new platformAccessory_1.TrinnovAccessory(this, accessory, client, {
                ...deviceConfig,
                name: deviceName,
            });
            try {
                this.api.publishExternalAccessories(settings_1.PLUGIN_NAME, [accessory]);
                this.log.info(`[${deviceName}] Successfully published as External Audio Receiver accessory. ` +
                    `If this is your first time adding it, open the Apple Home app, tap '+' > 'Add Accessory' > 'More options...' ` +
                    `and select '${deviceName}'.`);
            }
            catch (err) {
                const error = err;
                this.log.error(`[${deviceName}] Failed to publish external accessory: ${error.message}`);
            }
        }
    }
}
exports.TrinnovAltitudePlatform = TrinnovAltitudePlatform;
//# sourceMappingURL=platform.js.map