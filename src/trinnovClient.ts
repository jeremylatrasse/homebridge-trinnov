import { EventEmitter } from 'events';
import * as net from 'net';
import * as dgram from 'dgram';

export interface TrinnovClientConfig {
  host: string;
  port?: number;
  mac?: string;
  clientName?: string;
  reconnectInterval?: number; // seconds
  heartbeatInterval?: number; // seconds
  minVolumeDb?: number; // e.g. -90.0 dB
  maxVolumeDb?: number; // e.g. 0.0 dB
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
  volume: number; // in dB (e.g. -35.0)
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

export class TrinnovClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private isConnecting = false;
  private isDestroyed = false;
  private buffer = '';
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private pingIntervalTimer?: NodeJS.Timeout;

  public readonly config: Required<TrinnovClientConfig>;
  public state: TrinnovState = {
    power: false,
    volume: -40.0,
    mute: false,
    dim: false,
    currentProfileId: null,
    currentPresetId: null,
    bypass: false,
    profiles: new Map(),
    presets: new Map(),
    audiosync: false,
  };

  constructor(
    config: TrinnovClientConfig,
    private readonly log: LoggerLike,
  ) {
    super();
    this.config = {
      host: config.host,
      port: config.port || 44100,
      mac: config.mac || '',
      clientName: config.clientName || 'Homebridge',
      reconnectInterval: config.reconnectInterval || 5,
      heartbeatInterval: config.heartbeatInterval || 10,
      minVolumeDb: config.minVolumeDb !== undefined ? config.minVolumeDb : -90.0,
      maxVolumeDb: config.maxVolumeDb !== undefined ? config.maxVolumeDb : 0.0,
    };
  }

  public start(): void {
    this.isDestroyed = false;
    this.connect();
    this.startHeartbeat();
  }

  public stop(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pingIntervalTimer) {
      clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = undefined;
    }
    this.disconnect();
  }

  public isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.state.power;
  }

  // --- Connection Management ---

  private connect(): void {
    if (this.isDestroyed || this.socket || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.log.debug(`[${this.config.host}] Connecting to Trinnov Altitude on ${this.config.host}:${this.config.port}...`);

    const socket = new net.Socket();
    this.socket = socket;

    socket.setKeepAlive(true, 10000);
    socket.setTimeout(15000);

    socket.on('connect', () => {
      this.isConnecting = false;
      this.log.info(`[${this.config.host}] Connected to Trinnov Altitude`);

      const prevPower = this.state.power;
      this.state.power = true;
      if (!prevPower) {
        this.emit('powerChange', true);
      }

      // Initial Trinnov handshake: announce client identifier
      this.sendRaw(`id ${this.config.clientName}`);

      // Query initial status
      this.sendRaw('send_volume');
      this.sendRaw('send_profile');
      this.sendRaw('send_preset');

      this.emit('connected');
    });

    socket.on('data', (data: Buffer) => {
      this.handleIncomingData(data.toString('utf8'));
    });

    socket.on('timeout', () => {
      this.log.debug(`[${this.config.host}] Socket timeout - checking connection`);
      // Send a lightweight probe or let heartbeat handle it
    });

    socket.on('error', (err: Error) => {
      this.log.debug(`[${this.config.host}] Socket error: ${err.message}`);
    });

    socket.on('close', (hadError: boolean) => {
      this.log.debug(`[${this.config.host}] Socket closed (hadError: ${hadError})`);
      this.handleSocketClose();
    });

    socket.connect(this.config.port, this.config.host);
  }

  private disconnect(): void {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.end();
        this.socket.destroy();
      } catch {
        // ignore errors on tear-down
      }
      this.socket = null;
    }
    this.isConnecting = false;
  }

  private handleSocketClose(): void {
    this.disconnect();

    const prevPower = this.state.power;
    this.state.power = false;
    if (prevPower) {
      this.emit('powerChange', false);
    }
    this.emit('disconnected');

    if (!this.isDestroyed) {
      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, this.config.reconnectInterval * 1000);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected()) {
        // Keep the stream alive and refresh state
        this.sendRaw('send_volume');
      }
    }, this.config.heartbeatInterval * 1000);
  }

  // --- Protocol Parsing ---

  private handleIncomingData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    // Keep incomplete last segment in the buffer
    this.buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    this.log.debug(`[Trinnov RX] ${line}`);

    // Volume notifications: VOLUME -35.25 or DISPLAY_VOLUME -35.3
    const volMatch = line.match(/^VOLUME\s+([-+]?\d+(?:\.\d+)?)/i);
    if (volMatch) {
      const db = parseFloat(volMatch[1]);
      if (!isNaN(db)) {
        this.state.volume = db;
        this.emit('volumeChange', db, this.dbToPercentage(db));
      }
      return;
    }

    // Mute notifications: MUTE 0 or MUTE 1
    const muteMatch = line.match(/^MUTE\s+([01])/i);
    if (muteMatch) {
      const isMuted = muteMatch[1] === '1';
      this.state.mute = isMuted;
      this.emit('muteChange', isMuted);
      return;
    }

    // Dim notifications: DIM 0 or DIM 1
    const dimMatch = line.match(/^DIM\s+([01])/i);
    if (dimMatch) {
      const isDim = dimMatch[1] === '1';
      this.state.dim = isDim;
      this.emit('dimChange', isDim);
      return;
    }

    // Profile catalog clear
    if (/^PROFILES_CLEAR/i.test(line)) {
      this.state.profiles.clear();
      this.emit('profilesCatalogClear');
      return;
    }

    // Profile item catalog: PROFILE <id>: <name>
    const profileItemMatch = line.match(/^PROFILE\s+(\d+):\s*(.*)$/i);
    if (profileItemMatch) {
      const id = parseInt(profileItemMatch[1], 10);
      const name = profileItemMatch[2].trim();
      this.state.profiles.set(id, name);
      this.emit('profileDiscovered', id, name);
      return;
    }

    // Current Profile active: CURRENT_PROFILE <id> or PROFILE <id>
    const currentProfileMatch = line.match(/^(?:CURRENT_)?PROFILE\s+(\d+)$/i);
    if (currentProfileMatch) {
      const id = parseInt(currentProfileMatch[1], 10);
      this.state.currentProfileId = id;
      this.emit('profileChange', id, this.state.profiles.get(id) || `Profile ${id}`);
      return;
    }

    // Preset catalog clear
    if (/^LABELS_CLEAR/i.test(line)) {
      this.state.presets.clear();
      this.emit('presetsCatalogClear');
      return;
    }

    // Preset catalog item: LABEL <id>: <name>
    const presetItemMatch = line.match(/^LABEL\s+(\d+):\s*(.*)$/i);
    if (presetItemMatch) {
      const id = parseInt(presetItemMatch[1], 10);
      const name = presetItemMatch[2].trim();
      this.state.presets.set(id, name);
      this.emit('presetDiscovered', id, name);
      return;
    }

    // Current Preset active: CURRENT_PRESET <id> or PRESET <id>
    const currentPresetMatch = line.match(/^(?:CURRENT_)?PRESET\s+(\d+)$/i);
    if (currentPresetMatch) {
      const id = parseInt(currentPresetMatch[1], 10);
      this.state.currentPresetId = id;
      this.emit('presetChange', id, this.state.presets.get(id) || `Preset ${id}`);
      return;
    }

    // Bypass mode
    const bypassMatch = line.match(/^BYPASS\s+([01])/i);
    if (bypassMatch) {
      const isBypassed = bypassMatch[1] === '1';
      this.state.bypass = isBypassed;
      this.emit('bypassChange', isBypassed);
      return;
    }

    // Audio sync state
    const syncMatch = line.match(/^AUDIOSYNC\s+([01])/i);
    if (syncMatch) {
      this.state.audiosync = syncMatch[1] === '1';
      this.emit('audioSyncChange', this.state.audiosync);
      return;
    }
  }

  // --- Commands ---

  public sendRaw(command: string): void {
    if (!this.socket || this.socket.destroyed) {
      this.log.debug(`[${this.config.host}] Cannot send '${command}', socket not connected`);
      return;
    }
    this.log.debug(`[Trinnov TX] ${command}`);
    this.socket.write(`${command}\n`);
  }

  /**
   * Power On via Wake-on-LAN (UDP magic packet).
   * Trinnov Altitude hardware completely shuts down network listening in standby,
   * so a WOL magic packet is required to wake it.
   */
  public async powerOn(): Promise<void> {
    this.log.info(`[${this.config.host}] Powering on Altitude...`);
    if (this.config.mac) {
      try {
        await this.sendWakeOnLan(this.config.mac);
        this.log.info(`[${this.config.host}] Wake-on-LAN magic packet sent to ${this.config.mac}`);
      } catch (err: unknown) {
        const error = err as Error;
        this.log.error(`[${this.config.host}] Failed to send WOL packet: ${error.message}`);
      }
    } else {
      this.log.warn(`[${this.config.host}] No MAC address provided for Wake-on-LAN; cannot wake sleeping processor.`);
    }

    // Attempt connecting immediately and start aggressive retries until awake
    this.connect();
  }

  /**
   * Power Off / Standby over TCP automation connection.
   */
  public powerOff(): void {
    this.log.info(`[${this.config.host}] Sending power off / standby to Altitude...`);
    // Both standard power_off and token supported by various firmware
    this.sendRaw('power_off');
    this.sendRaw('power_off_SECURED_FHZMCH48FE');

    // Assume power turns off immediately
    setTimeout(() => {
      this.disconnect();
    }, 1500);
  }

  /**
   * Set master volume in decibels (e.g. -35.5 dB)
   */
  public setVolumeDb(db: number): void {
    const clampedDb = Math.min(this.config.maxVolumeDb, Math.max(this.config.minVolumeDb, db));
    this.log.debug(`[${this.config.host}] Setting volume to ${clampedDb.toFixed(1)} dB`);
    this.sendRaw(`volume ${clampedDb.toFixed(1)}`);
  }

  /**
   * Adjust master volume delta in decibels (e.g. +1.0 or -1.0 dB)
   */
  public adjustVolumeDb(delta: number): void {
    const sign = delta >= 0 ? '+' : '';
    this.log.debug(`[${this.config.host}] Adjusting volume delta: ${sign}${delta.toFixed(1)} dB`);
    this.sendRaw(`dvolume ${sign}${delta.toFixed(1)}`);
  }

  /**
   * Set volume by HomeKit percentage 0 - 100%
   */
  public setVolumePercentage(percentage: number): void {
    const db = this.percentageToDb(percentage);
    this.setVolumeDb(db);
  }

  /**
   * Mute control
   */
  public setMute(mute: boolean): void {
    this.log.info(`[${this.config.host}] Setting mute: ${mute}`);
    this.sendRaw(`mute ${mute ? 1 : 0}`);
  }

  public toggleMute(): void {
    this.sendRaw('mute 2');
  }

  /**
   * Dim control (-20 dB attenuation toggle)
   */
  public setDim(dim: boolean): void {
    this.sendRaw(`dim ${dim ? 1 : 0}`);
  }

  /**
   * Select Input / Profile by index
   */
  public setProfile(profileIndex: number): void {
    this.log.info(`[${this.config.host}] Switching to profile/input: ${profileIndex}`);
    this.sendRaw(`profile ${profileIndex}`);
  }

  /**
   * Recall Preset by index
   */
  public setPreset(presetIndex: number): void {
    this.log.info(`[${this.config.host}] Recalling preset: ${presetIndex}`);
    this.sendRaw(`loadp ${presetIndex}`);
    this.sendRaw(`preset ${presetIndex}`);
  }

  /**
   * Optimizer Bypass toggle
   */
  public setBypass(bypass: boolean): void {
    this.sendRaw(`bypass ${bypass ? 1 : 0}`);
  }

  // --- Math Utilities ---

  public dbToPercentage(db: number): number {
    const min = this.config.minVolumeDb;
    const max = this.config.maxVolumeDb;
    if (db <= min) {
      return 0;
    }
    if (db >= max) {
      return 100;
    }
    const percent = Math.round(((db - min) / (max - min)) * 100);
    return Math.min(100, Math.max(0, percent));
  }

  public percentageToDb(percent: number): number {
    const min = this.config.minVolumeDb;
    const max = this.config.maxVolumeDb;
    const clampedPercent = Math.min(100, Math.max(0, percent));
    const db = min + (clampedPercent / 100) * (max - min);
    return Math.round(db * 2) / 2; // round to nearest 0.5 dB
  }

  // --- Wake On Lan Implementation ---

  private sendWakeOnLan(macAddress: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanMac = macAddress.replace(/[^0-9a-fA-F]/g, '');
      if (cleanMac.length !== 12) {
        return reject(new Error(`Invalid MAC address: "${macAddress}"`));
      }

      const macBuffer = Buffer.from(cleanMac, 'hex');
      // 6 bytes of 0xFF followed by 16 repetitions of target MAC
      const magicPacket = Buffer.alloc(6 + 16 * 6);
      magicPacket.fill(0xff, 0, 6);
      for (let i = 0; i < 16; i++) {
        macBuffer.copy(magicPacket, 6 + i * 6);
      }

      const socket = dgram.createSocket('udp4');
      socket.once('error', (err) => {
        socket.close();
        reject(err);
      });

      socket.bind(() => {
        socket.setBroadcast(true);
        // Send to standard WoL broadcast port 9 and port 7
        socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err9) => {
          socket.send(magicPacket, 0, magicPacket.length, 7, '255.255.255.255', (err7) => {
            socket.close();
            if (err9 || err7) {
              reject(err9 || err7);
            } else {
              resolve();
            }
          });
        });
      });
    });
  }
}
