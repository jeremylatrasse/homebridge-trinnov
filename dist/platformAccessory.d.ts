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
 * Unified Trinnov Altitude Receiver Accessory:
 * The ONLY accessory exposed to HomeKit.
 *
 * Exposes:
 * - Service.Television (`AUDIO_RECEIVER`): Power (WoL / Standby), Input Source selector, and Control Center Remote
 * - Service.TelevisionSpeaker: Hardware volume rocker in iOS Control Center Remote when Trinnov is selected
 * - Service.InputSource: Explicitly named Trinnov Profiles (unnamed profiles are ignored)
 * - In-Room Volume Slider (`Service.Fan` or `Service.Lightbulb`) & Explicitly Named Preset switches on the same Receiver accessory
 */
export declare class TrinnovReceiverAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly client;
    private readonly deviceConfig;
    private tvService;
    private speakerService;
    private volumeSliderService?;
    private muteSwitchService?;
    private bypassSwitchService?;
    private inputServices;
    private presetSwitchServices;
    constructor(platform: TrinnovAltitudePlatform, accessory: PlatformAccessory, client: TrinnovClient, deviceConfig: TrinnovDeviceConfig);
    private setupInputSources;
    private registerInputSource;
    private createOrUpdateSwitch;
    private setupVolumeSlider;
    private setupSwitches;
    private handleRemoteKey;
    private subscribeClientEvents;
}
