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
    inputs?: InputSourceConfig[];
    presets?: PresetConfig[];
}
export declare class TrinnovAccessory {
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
    private presetServices;
    constructor(platform: TrinnovAltitudePlatform, accessory: PlatformAccessory, client: TrinnovClient, deviceConfig: TrinnovDeviceConfig);
    private setupInputSources;
    private registerInputSource;
    private setupCompanionVolumeSlider;
    private setupSwitches;
    private handleRemoteKey;
    private subscribeClientEvents;
}
