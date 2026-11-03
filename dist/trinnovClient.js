"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrinnovClient = void 0;
exports.validateTrinnovHost = validateTrinnovHost;
const child_process_1 = require("child_process");
const events_1 = require("events");
const net = __importStar(require("net"));
const dgram = __importStar(require("dgram"));
/**
 * Validates that an IPv4 address has exactly 4 octets between 0 and 255.
 * Also permits standard RFC 1123 hostnames (e.g. altitude.local).
 */
function validateTrinnovHost(host) {
    if (typeof host !== 'string' || !host.trim()) {
        return { valid: false, reason: 'Host is empty or undefined.' };
    }
    const trimmed = host.trim();
    // If host contains only digits and dots, it is an IPv4 address attempt
    if (/^[0-9.]+$/.test(trimmed)) {
        const octets = trimmed.split('.');
        if (octets.length !== 4) {
            return {
                valid: false,
                reason: `Invalid IPv4 address '${trimmed}': an IPv4 address must contain exactly 4 octets (found ${octets.length}). Example: 172.16.1.66`,
            };
        }
        for (let i = 0; i < octets.length; i++) {
            const octet = octets[i];
            if (octet === '' || isNaN(Number(octet))) {
                return {
                    valid: false,
                    reason: `Invalid IPv4 address '${trimmed}': octet #${i + 1} is empty or non-numeric.`,
                };
            }
            const num = Number(octet);
            if (num < 0 || num > 255) {
                return {
                    valid: false,
                    reason: `Invalid IPv4 address '${trimmed}': octet #${i + 1} ('${octet}') is out of range 0-255.`,
                };
            }
            if (octet.length > 1 && octet.startsWith('0')) {
                return {
                    valid: false,
                    reason: `Invalid IPv4 address '${trimmed}': octet #${i + 1} ('${octet}') cannot have leading zeroes.`,
                };
            }
        }
        return { valid: true };
    }
    // Otherwise hostname / FQDN validation:
    const parts = trimmed.split('.');
    if (parts.some((p) => p.length === 0)) {
        return { valid: false, reason: `Invalid hostname '${trimmed}': consecutive or trailing dots.` };
    }
    const lastPart = parts[parts.length - 1];
    if (/^[0-9]+$/.test(lastPart)) {
        return {
            valid: false,
            reason: `Invalid host '${trimmed}': looks like an incomplete IPv4 address with ${parts.length} octets. IPv4 addresses must have exactly 4 octets.`,
        };
    }
    return { valid: true };
}
class TrinnovClient extends events_1.EventEmitter {
    log;
    socket = null;
    isConnecting = false;
    isDestroyed = false;
    buffer = '';
    reconnectTimer;
    heartbeatTimer;
    pingIntervalTimer;
    transitionTimer;
    powerOffDisconnectTimer;
    awaitingResponse = false;
    config;
    state = {
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
    constructor(config, log) {
        super();
        this.log = log;
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
        const validation = validateTrinnovHost(this.config.host);
        if (!validation.valid) {
            this.log.error(`[${this.config.host}] ${validation.reason}`);
            throw new Error(`[TrinnovClient] ${validation.reason}`);
        }
    }
    start() {
        this.isDestroyed = false;
        this.connect();
        this.startHeartbeat();
        this.startResponsivenessPolling('start');
    }
    stop() {
        this.isDestroyed = true;
        this.clearTimers();
        this.disconnect();
    }
    restart() {
        this.log.info(`[${this.config.host}] Restarting Trinnov client connection & checking if unit is responding...`);
        this.stop();
        this.start();
        this.startResponsivenessPolling('restart');
    }
    clearTimers() {
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
        if (this.transitionTimer) {
            clearInterval(this.transitionTimer);
            this.transitionTimer = undefined;
        }
        if (this.powerOffDisconnectTimer) {
            clearTimeout(this.powerOffDisconnectTimer);
            this.powerOffDisconnectTimer = undefined;
        }
    }
    isConnected() {
        return this.socket !== null && !this.socket.destroyed && this.state.power;
    }
    /**
     * Performs an ICMP ping against the Trinnov host.
     */
    pingHost(timeoutMs = 1500) {
        return new Promise((resolve) => {
            const isDarwin = process.platform === 'darwin';
            const args = isDarwin
                ? ['-c', '1', '-W', String(Math.max(1000, timeoutMs)), this.config.host]
                : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), this.config.host];
            let settled = false;
            let cp;
            try {
                cp = (0, child_process_1.spawn)('ping', args);
            }
            catch {
                resolve(false);
                return;
            }
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try {
                        cp.kill('SIGKILL');
                    }
                    catch {
                        // ignore
                    }
                    resolve(false);
                }
            }, timeoutMs + 300);
            cp.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(code === 0);
                }
            });
            cp.on('error', () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(false);
                }
            });
        });
    }
    /**
     * Probes whether a TCP port (e.g. 44100 telnet or 80 http) connects.
     * When Trinnov is in standby, the processor OS is completely shut down and all TCP ports reject/timeout.
     */
    checkTcpPort(port, timeoutMs = 1500) {
        return new Promise((resolve) => {
            const probe = new net.Socket();
            let settled = false;
            const finish = (open) => {
                if (!settled) {
                    settled = true;
                    try {
                        probe.removeAllListeners();
                        probe.destroy();
                    }
                    catch {
                        // ignore
                    }
                    resolve(open);
                }
            };
            probe.setTimeout(timeoutMs);
            probe.on('connect', () => finish(true));
            probe.on('data', () => finish(true));
            probe.on('timeout', () => finish(false));
            probe.on('error', () => finish(false));
            probe.on('close', () => finish(false));
            probe.connect(port, this.config.host);
        });
    }
    /**
     * Actively checks whether the unit is responding via ping, telnet (port 44100), or HTTP (port 80).
     * Returns a detailed status object and never falsely claims standby if any layer answers.
     */
    async probeUnitReachability(timeoutMs = 1500) {
        const pingPromise = this.pingHost(timeoutMs);
        const telnetPromise = (this.socket && !this.socket.destroyed)
            ? Promise.resolve(true)
            : this.checkTcpPort(this.config.port, timeoutMs);
        const httpPromise = this.checkTcpPort(80, timeoutMs);
        const [ping, telnet, http] = await Promise.all([pingPromise, telnetPromise, httpPromise]);
        const responding = ping || telnet || http;
        return { responding, ping, telnet, http };
    }
    async checkIfResponding(timeoutMs = 1500) {
        const status = await this.probeUnitReachability(timeoutMs);
        return status.responding;
    }
    /**
     * Rapidly polls during start / stop / restart transitions to detect as soon as the unit
     * starts or stops responding.
     */
    startResponsivenessPolling(mode, maxDurationMs = 90000, intervalMs = 2000) {
        if (this.transitionTimer) {
            clearInterval(this.transitionTimer);
            this.transitionTimer = undefined;
        }
        const startedAt = Date.now();
        this.log.info(`[${this.config.host}] Checking if unit is responding (${mode})...`);
        this.transitionTimer = setInterval(async () => {
            if (this.isDestroyed) {
                if (this.transitionTimer) {
                    clearInterval(this.transitionTimer);
                    this.transitionTimer = undefined;
                }
                return;
            }
            const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
            if (Date.now() - startedAt > maxDurationMs) {
                if (mode === 'stop') {
                    this.log.warn(`[${this.config.host}] Timed out after ${elapsedSec}s waiting for unit to enter standby — unit is still responding to ping/telnet. Power off was not executed.`);
                    if (!this.state.power) {
                        this.state.power = true;
                        this.emit('powerChange', true);
                    }
                }
                else {
                    this.log.warn(`[${this.config.host}] Timed out after ${elapsedSec}s waiting for unit (${mode}).`);
                }
                if (this.transitionTimer) {
                    clearInterval(this.transitionTimer);
                    this.transitionTimer = undefined;
                }
                return;
            }
            if (mode === 'start' || mode === 'restart') {
                if (this.isConnected()) {
                    this.log.info(`[${this.config.host}] Unit is now responding (${elapsedSec}s elapsed).`);
                    if (this.transitionTimer) {
                        clearInterval(this.transitionTimer);
                        this.transitionTimer = undefined;
                    }
                    return;
                }
                this.log.debug(`[${this.config.host}] Waiting for unit to respond (${elapsedSec}s elapsed)...`);
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = undefined;
                }
                this.connect();
            }
            else if (mode === 'stop') {
                const probe = await this.probeUnitReachability(1500);
                if (!probe.responding) {
                    this.log.info(`[${this.config.host}] Altitude is no longer responding (ping: no, telnet: closed, http: closed) — standby confirmed (${elapsedSec}s elapsed).`);
                    if (this.transitionTimer) {
                        clearInterval(this.transitionTimer);
                        this.transitionTimer = undefined;
                    }
                    if (this.socket) {
                        this.handleSocketClose();
                    }
                    else if (this.state.power) {
                        this.state.power = false;
                        this.emit('powerChange', false);
                    }
                }
                else {
                    this.log.info(`[${this.config.host}] Unit is still responding (ping: ${probe.ping ? 'yes' : 'no'}, telnet: ${probe.telnet ? 'open' : 'closed'}, http: ${probe.http ? 'open' : 'closed'}) (${elapsedSec}s elapsed)...`);
                }
            }
        }, intervalMs);
    }
    // --- Connection Management ---
    connect() {
        if (this.isDestroyed || this.socket || this.isConnecting) {
            return;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.isConnecting = true;
        this.awaitingResponse = true;
        this.log.debug(`[${this.config.host}] Connecting to Trinnov Altitude on ${this.config.host}:${this.config.port}...`);
        const socket = new net.Socket();
        this.socket = socket;
        socket.setKeepAlive(true, 10000);
        socket.setTimeout(15000);
        socket.on('connect', () => {
            this.isConnecting = false;
            this.awaitingResponse = true;
            this.log.info(`[${this.config.host}] TCP connected to Trinnov Altitude — checking if unit is responding...`);
            // Initial Trinnov handshake: announce client identifier
            this.sendRaw(`id ${this.config.clientName}`);
            // Query initial status to verify the automation server is responsive
            this.sendRaw('send_volume');
            this.sendRaw('send_profile');
            this.sendRaw('send_preset');
        });
        socket.on('data', (data) => {
            this.handleIncomingData(data.toString('utf8'));
        });
        socket.on('timeout', () => {
            this.log.debug(`[${this.config.host}] Socket timeout - probing if unit is still responding...`);
            this.sendRaw('send_volume');
        });
        socket.on('error', (err) => {
            this.log.debug(`[${this.config.host}] Socket error: ${err.message}`);
        });
        socket.on('close', (hadError) => {
            this.log.debug(`[${this.config.host}] Socket closed (hadError: ${hadError})`);
            this.handleSocketClose();
        });
        socket.connect(this.config.port, this.config.host);
    }
    disconnect() {
        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.end();
                this.socket.destroy();
            }
            catch {
                // ignore errors on tear-down
            }
            this.socket = null;
        }
        this.isConnecting = false;
    }
    handleSocketClose() {
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
    startHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        this.heartbeatTimer = setInterval(async () => {
            if (this.isDestroyed) {
                return;
            }
            // Check reachability across ICMP ping, Telnet (44100), and HTTP (80)
            const probe = await this.probeUnitReachability(1500);
            if (probe.responding) {
                // Processor is powered on and answering network probes
                if (!this.state.power) {
                    this.state.power = true;
                    this.log.info(`[${this.config.host}] Altitude is online (ping: ${probe.ping ? 'yes' : 'no'}, telnet: ${probe.telnet ? 'open' : 'closed'}, http: ${probe.http ? 'open' : 'closed'}) — power active.`);
                    this.emit('powerChange', true);
                }
                if (!this.socket || this.socket.destroyed) {
                    if (!this.isConnecting) {
                        this.connect();
                    }
                }
                else {
                    // Query status & profiles to keep HomeKit state refreshed
                    this.sendRaw('send_volume');
                    this.sendRaw('get_current_profile');
                    this.sendRaw('get_all_label');
                }
            }
            else {
                // All probes silent — unit is in standby / powered off
                if (this.state.power) {
                    this.state.power = false;
                    this.log.info(`[${this.config.host}] Altitude is unreachable (ping, telnet, http silent) — in standby.`);
                    this.emit('powerChange', false);
                }
                if (this.socket) {
                    this.disconnect();
                }
            }
        }, this.config.heartbeatInterval * 1000);
    }
    // --- Protocol Parsing ---
    markUnitResponding() {
        if (this.awaitingResponse) {
            this.awaitingResponse = false;
            this.log.info(`[${this.config.host}] Trinnov Altitude is responding and ready`);
        }
        if (!this.state.power) {
            this.state.power = true;
            this.emit('powerChange', true);
            this.emit('connected');
        }
    }
    handleIncomingData(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        // Keep incomplete last segment in the buffer
        this.buffer = lines.pop() || '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            this.markUnitResponding();
            this.emit('lineReceived', line);
            this.parseLine(line);
        }
    }
    parseLine(line) {
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
    sendRaw(command) {
        if (!this.socket || this.socket.destroyed) {
            this.log.debug(`[${this.config.host}] Cannot send '${command}', socket not connected`);
            return;
        }
        this.log.debug(`[Trinnov TX] ${command}`);
        this.socket.write(`${command}\r\n`);
    }
    /**
     * Power On via Wake-on-LAN (UDP magic packet).
     * Trinnov Altitude hardware completely shuts down network listening in standby,
     * so a WOL magic packet is required to wake it.
     */
    async powerOn() {
        this.log.info(`[${this.config.host}] Powering on Altitude...`);
        if (this.powerOffDisconnectTimer) {
            clearTimeout(this.powerOffDisconnectTimer);
            this.powerOffDisconnectTimer = undefined;
        }
        if (this.config.mac) {
            try {
                await this.sendWakeOnLan(this.config.mac);
                this.log.info(`[${this.config.host}] Wake-on-LAN magic packet sent to ${this.config.mac}`);
            }
            catch (err) {
                const error = err;
                this.log.error(`[${this.config.host}] Failed to send WOL packet: ${error.message}`);
            }
        }
        else {
            this.log.warn(`[${this.config.host}] No MAC address provided in Homebridge config for Wake-on-LAN; sleeping processor cannot wake.`);
        }
        // Attempt connecting immediately and poll until the unit starts responding
        this.connect();
        this.startResponsivenessPolling('start');
    }
    /**
     * Transmits the secured shutdown sequence over telnet.
     */
    sendPowerOffCommand() {
        return new Promise((resolve) => {
            const shutdownCommands = [
                'power off SECURED FHZMCH48FE',
                'power_off SECURED FHZMCH48FE',
                'power_off_SECURED_FHZMCH48FE',
                'power_off',
            ];
            const payload = shutdownCommands.map((cmd) => `${cmd}\r\n`).join('');
            if (this.socket && !this.socket.destroyed && !this.isConnecting) {
                this.log.info(`[Trinnov TX] Sending shutdown commands (CRLF):\n${shutdownCommands.join('\n')}`);
                this.socket.write(`id ${this.config.clientName}\r\n${payload}`, () => {
                    resolve();
                });
                return;
            }
            this.log.info(`[${this.config.host}] Connecting direct socket to send shutdown commands...`);
            const directSocket = new net.Socket();
            let settled = false;
            const finish = () => {
                if (!settled) {
                    settled = true;
                    try {
                        directSocket.removeAllListeners();
                        directSocket.destroy();
                    }
                    catch {
                        // ignore
                    }
                    resolve();
                }
            };
            directSocket.setTimeout(5000);
            directSocket.on('connect', () => {
                directSocket.write(`id ${this.config.clientName}\r\n${payload}`, () => {
                    setTimeout(finish, 800);
                });
            });
            directSocket.on('timeout', () => finish());
            directSocket.on('error', () => finish());
            directSocket.on('close', () => finish());
            directSocket.connect(this.config.port, this.config.host);
        });
    }
    /**
     * Power Off / Standby over TCP automation connection.
     */
    async powerOff() {
        this.log.info(`[${this.config.host}] Sending power off / standby to Altitude...`);
        await this.sendPowerOffCommand();
        // Poll with ping and telnet to verify when the unit actually stops responding
        this.startResponsivenessPolling('stop', 60000, 2000);
    }
    /**
     * Set master volume in decibels (e.g. -35.5 dB)
     */
    setVolumeDb(db) {
        const clampedDb = Math.min(this.config.maxVolumeDb, Math.max(this.config.minVolumeDb, db));
        this.log.debug(`[${this.config.host}] Setting volume to ${clampedDb.toFixed(1)} dB`);
        this.sendRaw(`volume ${clampedDb.toFixed(1)}`);
    }
    /**
     * Adjust master volume delta in decibels (e.g. +1.0 or -1.0 dB)
     */
    adjustVolumeDb(delta) {
        const sign = delta >= 0 ? '+' : '';
        this.log.debug(`[${this.config.host}] Adjusting volume delta: ${sign}${delta.toFixed(1)} dB`);
        this.sendRaw(`dvolume ${sign}${delta.toFixed(1)}`);
    }
    /**
     * Set volume by HomeKit percentage 0 - 100%
     */
    setVolumePercentage(percentage) {
        const db = this.percentageToDb(percentage);
        this.setVolumeDb(db);
    }
    /**
     * Mute control
     */
    setMute(mute) {
        this.log.info(`[${this.config.host}] Setting mute: ${mute}`);
        this.sendRaw(`mute ${mute ? 1 : 0}`);
    }
    toggleMute() {
        this.sendRaw('mute 2');
    }
    /**
     * Dim control (-20 dB attenuation toggle)
     */
    setDim(dim) {
        this.sendRaw(`dim ${dim ? 1 : 0}`);
    }
    /**
     * Select Input / Profile by index
     */
    setProfile(profileIndex) {
        this.log.info(`[${this.config.host}] Switching to profile/input: ${profileIndex}`);
        this.sendRaw(`profile ${profileIndex}`);
    }
    /**
     * Recall Preset by index
     */
    setPreset(presetIndex) {
        this.log.info(`[${this.config.host}] Recalling preset: ${presetIndex}`);
        this.sendRaw(`loadp ${presetIndex}`);
        this.sendRaw(`preset ${presetIndex}`);
    }
    /**
     * Optimizer Bypass toggle
     */
    setBypass(bypass) {
        this.sendRaw(`bypass ${bypass ? 1 : 0}`);
    }
    // --- Math Utilities ---
    dbToPercentage(db) {
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
    percentageToDb(percent) {
        const min = this.config.minVolumeDb;
        const max = this.config.maxVolumeDb;
        const clampedPercent = Math.min(100, Math.max(0, percent));
        const db = min + (clampedPercent / 100) * (max - min);
        return Math.round(db * 2) / 2; // round to nearest 0.5 dB
    }
    // --- Wake On Lan Implementation ---
    sendWakeOnLan(macAddress) {
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
                try {
                    socket.close();
                }
                catch {
                    // ignore
                }
                reject(err);
            });
            socket.bind(() => {
                try {
                    socket.setBroadcast(true);
                }
                catch {
                    // ignore
                }
                // Send Wake-on-LAN magic packet to standard WoL broadcast port 9
                socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
                    try {
                        socket.close();
                    }
                    catch {
                        // ignore
                    }
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }
                });
            });
        });
    }
}
exports.TrinnovClient = TrinnovClient;
//# sourceMappingURL=trinnovClient.js.map