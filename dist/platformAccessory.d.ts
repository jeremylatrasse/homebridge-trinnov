import { PlatformAccessory } from 'homebridge';
import { TrinnovAltitudePlatform } from './platform';
import { TrinnovClient } from './trinnovClient';
export interface InputSourceConfig {
    id: number;
    name: string;
    type?: 'HDMI' | 'AUDIO_SYSTEM' | 'AIRPLAY' | 'OTHER';
}
export interface PresetConfig {
    id: number;
    name: string;
}
export interface TrinnovDeviceConfig {
    name: string;
    host: string;
    port?: number;
    mac?: string;
    clientName?: string;
    minVolumeDb?: number;
    maxVolumeDb?: number;
    enableVolumeSlider?: boolean;
    volumeAccessoryType?: 'fan' | 'lightbulb' | 'none';
    enableMuteSwitch?: boolean;
    enableBypassSwitch?: boolean;
    enableTvAccessory?: boolean;
    inputs?: InputSourceConfig[];
    presets?: PresetConfig[];
}
/**
 * Sanitizes any string into a valid Apple HomeKit HAP Name:
 * - Must start and end with a letter or number
 * - Only letters, numbers, spaces, apostrophes, and hyphens allowed
 * - Removes parentheses, pluses, slashes, etc. that trigger HAP-NodeJS warnings
 */
export declare function sanitizeHomeKitName(rawName: string, fallback?: string): string;
/**
 * Checks whether a profile or preset entry has a valid user-provided name
 * and is not an unnamed placeholder (e.g. "", "Switch 1", "Preset 2", "Profile 3").
 */
export declare function isExplicitlyNamed(rawName?: string): boolean;
/**
 * Standard Bridged HomeKit Accessory:
 * Automatically appears in your existing HomeKit Home via your Homebridge bridge
 * (or child bridge) with ZERO extra pairing required!
 *
 * Exposes ONLY:
 * - Power Switch (Wake-on-LAN & TCP Standby)
 * - Volume Slider (Fan RotationSpeed 0-100% by default so "turn off lights" never mutes your theater,
 *   or Lightbulb Brightness if configured)
 * - Explicitly named Input Source switches from your config (unnamed profiles are never propagated)
 * - Explicitly named Preset switches from your config (unnamed presets are never propagated)
 */
export declare class TrinnovBridgedAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly client;
    private readonly deviceConfig;
    private powerService;
    private volumeService?;
    private muteSwitchService?;
    private bypassSwitchService?;
    private inputSwitchServices;
    private presetSwitchServices;
    constructor(platform: TrinnovAltitudePlatform, accessory: PlatformAccessory, client: TrinnovClient, deviceConfig: TrinnovDeviceConfig);
    /**
     * Helper that creates or updates a Switch service with `ConfiguredName` and `Name`
     * added BEFORE the service is registered on the accessory so iOS 16/17/18 Home app
     * shows the exact name instead of "Switch 1..32".
     */
    private createOrUpdateSwitch;
    private setupVolumeSlider;
    private setupInputSwitches;
    private registerInputSwitch;
    private setupExtraSwitches;
    private subscribeClientEvents;
}
/**
 * Standalone Television / Receiver Accessory (`Trinnov Altitude32 Receiver`):
 * Exposes `Service.Television` + `Service.TelevisionSpeaker` + explicitly named `Service.InputSource`s.
 * Allows the iOS Apple TV Remote widget (and hardware volume buttons) to control the Altitude volume!
 */
export declare class TrinnovTelevisionAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly client;
    private readonly deviceConfig;
    private tvService;
    private speakerService;
    private inputServices;
    constructor(platform: TrinnovAltitudePlatform, accessory: PlatformAccessory, client: TrinnovClient, deviceConfig: TrinnovDeviceConfig);
    private setupInputSources;
    private registerInputSource;
    private handleRemoteKey;
    private subscribeClientEvents;
}
