import { EventEmitter } from 'events';
export interface TrinnovClientConfig {
    host: string;
    port?: number;
    mac?: string;
    clientName?: string;
    reconnectInterval?: number;
    heartbeatInterval?: number;
    minVolumeDb?: number;
    maxVolumeDb?: number;
}
export interface TrinnovSource {
    id: number;
    name: string;
}
export interface TrinnovPreset {
    id: number;
    name: string;
}
export interface TrinnovState {
    power: boolean;
    volume: number;
    mute: boolean;
    dim: boolean;
    currentProfileId: number | null;
    currentPresetId: number | null;
    bypass: boolean;
    profiles: Map<number, string>;
    presets: Map<number, string>;
    audiosync: boolean;
}
export interface LoggerLike {
    info(message: string, ...parameters: unknown[]): void;
    warn(message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
    debug(message: string, ...parameters: unknown[]): void;
}
export declare class TrinnovClient extends EventEmitter {
    private readonly log;
    private socket;
    private isConnecting;
    private isDestroyed;
    private buffer;
    private reconnectTimer?;
    private heartbeatTimer?;
    private pingIntervalTimer?;
    readonly config: Required<TrinnovClientConfig>;
    state: TrinnovState;
    constructor(config: TrinnovClientConfig, log: LoggerLike);
    start(): void;
    stop(): void;
    isConnected(): boolean;
    private connect;
    private disconnect;
    private handleSocketClose;
    private startHeartbeat;
    private handleIncomingData;
    private parseLine;
    sendRaw(command: string): void;
    /**
     * Power On via Wake-on-LAN (UDP magic packet).
     * Trinnov Altitude hardware completely shuts down network listening in standby,
     * so a WOL magic packet is required to wake it.
     */
    powerOn(): Promise<void>;
    /**
     * Power Off / Standby over TCP automation connection.
     */
    powerOff(): void;
    /**
     * Set master volume in decibels (e.g. -35.5 dB)
     */
    setVolumeDb(db: number): void;
    /**
     * Adjust master volume delta in decibels (e.g. +1.0 or -1.0 dB)
     */
    adjustVolumeDb(delta: number): void;
    /**
     * Set volume by HomeKit percentage 0 - 100%
     */
    setVolumePercentage(percentage: number): void;
    /**
     * Mute control
     */
    setMute(mute: boolean): void;
    toggleMute(): void;
    /**
     * Dim control (-20 dB attenuation toggle)
     */
    setDim(dim: boolean): void;
    /**
     * Select Input / Profile by index
     */
    setProfile(profileIndex: number): void;
    /**
     * Recall Preset by index
     */
    setPreset(presetIndex: number): void;
    /**
     * Optimizer Bypass toggle
     */
    setBypass(bypass: boolean): void;
    dbToPercentage(db: number): number;
    percentageToDb(percent: number): number;
    private sendWakeOnLan;
}
