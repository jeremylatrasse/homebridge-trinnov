import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
export declare class TrinnovAltitudePlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    private readonly clients;
    constructor(log: Logger, config: PlatformConfig, api: API);
    /**
     * Homebridge invokes this method for cached accessories restored from disk.
     */
    configureAccessory(accessory: PlatformAccessory): void;
    discoverDevices(): void;
}
