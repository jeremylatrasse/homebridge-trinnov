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
    enableMuteSwitch?: boolean;
    enableBypassSwitch?: boolean;
    enableTvAccessory?: boolean;
    inputs?: InputSourceConfig[];
    presets?: PresetConfig[];
}
/**
 * Standard Bridged HomeKit Accessory:
 * Automatically appears in your existing HomeKit Home via your Homebridge bridge
 * (or child bridge) with ZERO extra pairing required!
 *
 * Exposes:
 * - Power Switch (Wake-on-LAN & TCP Standby)
 * - Volume Control Slider (0-100% mapped to dB range, plus Mute toggle)
 * - Input Source Switches (radio-button style switches for each Trinnov Profile)
 * - Optional Mute, Optimizer Bypass, and Preset switches
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
    private setupVolumeSlider;
    private setupInputSwitches;
    private registerInputSwitch;
    private setupExtraSwitches;
    private subscribeClientEvents;
}
/**
 * Optional Standalone Television / Receiver Accessory:
 * Published as an unbridged external accessory for users who also want the
 * iOS Control Center Apple Remote widget and native TV input picker.
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
