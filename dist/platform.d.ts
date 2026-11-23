import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { TrinnovDeviceConfig } from './platformAccessory';
export interface NormalizedTrinnovPlatformConfig {
    name: string;
    devices: TrinnovDeviceConfig[];
}
export interface TrinnovDiscoveryFileEntry {
    id: string;
    name: string;
    driver: 'trinnov';
    host: string;
    port: number;
    powered: boolean;
    activeSource?: string;
}
export interface TrinnovDiscoveryFilePayload {
    version: number;
    plugin: string;
    updatedAt: string;
    pid: number;
    processors: TrinnovDiscoveryFileEntry[];
}
export declare function normalizePlatformConfig(config: PlatformConfig): NormalizedTrinnovPlatformConfig;
export declare class TrinnovAltitudePlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    private readonly clients;
    private readonly managedDevices;
    private readonly normalizedConfig;
    private readonly registeredPlatformName;
    constructor(log: Logger, config: PlatformConfig, api: API);
    /**
     * Homebridge invokes this method for cached accessories restored from disk.
     */
    configureAccessory(accessory: PlatformAccessory): void;
    private resolveActiveSourceName;
    private writeDiscoveryFile;
    discoverDevices(): void;
}
