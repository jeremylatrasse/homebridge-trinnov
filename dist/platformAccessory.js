"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrinnovTelevisionAccessory = exports.TrinnovBridgedAccessory = void 0;
exports.sanitizeHomeKitName = sanitizeHomeKitName;
exports.isExplicitlyNamed = isExplicitlyNamed;
const settings_1 = require("./settings");
/**
 * Sanitizes any string into a valid Apple HomeKit HAP Name:
 * - Must start and end with a letter or number
 * - Only letters, numbers, spaces, apostrophes, and hyphens allowed
 * - Removes parentheses, pluses, slashes, etc. that trigger HAP-NodeJS warnings
 */
function sanitizeHomeKitName(rawName, fallback = 'Trinnov Control') {
    const cleaned = rawName
        .replace(/\+/g, ' and ')
        .replace(/[()[\]{}/\\]/g, ' ')
        .replace(/[^a-zA-Z0-9 '-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[^a-zA-Z0-9]+/, '')
        .replace(/[^a-zA-Z0-9]+$/, '');
    return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}
/**
 * Checks whether a profile or preset entry has a valid user-provided name
 * and is not an unnamed placeholder (e.g. "", "Switch 1", "Preset 2", "Profile 3").
 */
function isExplicitlyNamed(rawName) {
    if (!rawName) {
        return false;
    }
    const trimmed = rawName.trim();
    if (!trimmed) {
        return false;
    }
    // Ignore generic unnamed placeholders
    if (/^(switch|preset|profile|input|config|unnamed|empty|none)\s*#?\d*$/i.test(trimmed)) {
        return false;
    }
    return true;
}
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
class TrinnovBridgedAccessory {
    platform;
    accessory;
    client;
    deviceConfig;
    powerService;
    volumeService;
    muteSwitchService;
    bypassSwitchService;
    inputSwitchServices = new Map();
    presetSwitchServices = new Map();
    constructor(platform, accessory, client, deviceConfig) {
        this.platform = platform;
        this.accessory = accessory;
        this.client = client;
        this.deviceConfig = deviceConfig;
        const { Service, Characteristic } = this.platform;
        const cleanDeviceName = sanitizeHomeKitName(this.deviceConfig.name, 'Trinnov Altitude32');
        // 1. Accessory Information
        const infoService = this.accessory.getService(Service.AccessoryInformation);
        infoService
            .setCharacteristic(Characteristic.Name, cleanDeviceName)
            .setCharacteristic(Characteristic.Manufacturer, 'Trinnov Audio')
            .setCharacteristic(Characteristic.Model, 'Altitude32')
            .setCharacteristic(Characteristic.SerialNumber, `TRINNOV-${this.deviceConfig.host}`)
            .setCharacteristic(Characteristic.FirmwareRevision, settings_1.PLUGIN_VERSION);
        // 2. Main Power Switch
        const powerSubtype = 'power-switch';
        const powerName = sanitizeHomeKitName(`${cleanDeviceName} Power`, 'Altitude Power');
        this.powerService = this.createOrUpdateSwitch(powerSubtype, powerName);
        this.powerService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.client.state.power)
            .onSet(async (value) => {
            if (Boolean(value)) {
                await this.client.powerOn();
            }
            else {
                this.client.powerOff();
            }
        });
        // 3. Volume Slider (Fan 0-100% slider by default, or Lightbulb if requested)
        this.setupVolumeSlider(cleanDeviceName);
        // 4. Explicitly Configured Input Selection Switches (Trinnov Profiles)
        this.setupInputSwitches();
        // 5. Optional Mute, Bypass, and Explicitly Named Preset Switches
        this.setupExtraSwitches(cleanDeviceName);
        // 6. Subscribe to Live Client Events
        this.subscribeClientEvents();
    }
    /**
     * Helper that creates or updates a Switch service with `ConfiguredName` and `Name`
     * added BEFORE the service is registered on the accessory so iOS 16/17/18 Home app
     * shows the exact name instead of "Switch 1..32".
     */
    createOrUpdateSwitch(subtype, rawName) {
        const { Service, Characteristic } = this.platform;
        const safeName = sanitizeHomeKitName(rawName, 'Trinnov Switch');
        let svc = this.accessory.getServiceById(Service.Switch, subtype);
        if (!svc) {
            svc = new Service.Switch(safeName, subtype);
            svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
            svc.setCharacteristic(Characteristic.Name, safeName);
            svc.setCharacteristic(Characteristic.ConfiguredName, safeName);
            this.accessory.addService(svc);
        }
        else {
            if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
                svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
            }
            svc.displayName = safeName;
            svc.setCharacteristic(Characteristic.Name, safeName);
            svc.setCharacteristic(Characteristic.ConfiguredName, safeName);
            svc.updateCharacteristic(Characteristic.Name, safeName);
            svc.updateCharacteristic(Characteristic.ConfiguredName, safeName);
        }
        return svc;
    }
    setupVolumeSlider(cleanDeviceName) {
        const { Service, Characteristic } = this.platform;
        const fanSubtype = 'companion-volume-fan';
        const lightSubtype = 'companion-volume';
        const enabled = this.deviceConfig.enableVolumeSlider !== false &&
            this.deviceConfig.volumeAccessoryType !== 'none';
        const sliderType = this.deviceConfig.volumeAccessoryType || 'fan';
        const volName = sanitizeHomeKitName(`${cleanDeviceName} Volume`, 'Altitude Volume');
        // Remove unused slider service type if user switched types or disabled it
        if (!enabled || sliderType !== 'fan') {
            const existingFan = this.accessory.getServiceById(Service.Fan, fanSubtype);
            if (existingFan) {
                this.accessory.removeService(existingFan);
            }
        }
        if (!enabled || sliderType !== 'lightbulb') {
            const existingLight = this.accessory.getServiceById(Service.Lightbulb, lightSubtype);
            if (existingLight) {
                this.accessory.removeService(existingLight);
            }
        }
        if (!enabled) {
            return;
        }
        if (sliderType === 'fan') {
            let fanSvc = this.accessory.getServiceById(Service.Fan, fanSubtype);
            if (!fanSvc) {
                fanSvc = new Service.Fan(volName, fanSubtype);
                fanSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
                fanSvc.setCharacteristic(Characteristic.Name, volName);
                fanSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
                this.accessory.addService(fanSvc);
            }
            else {
                if (!fanSvc.testCharacteristic(Characteristic.ConfiguredName)) {
                    fanSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
                }
                fanSvc.displayName = volName;
                fanSvc.setCharacteristic(Characteristic.Name, volName);
                fanSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
            }
            fanSvc
                .getCharacteristic(Characteristic.On)
                .onGet(() => !this.client.state.mute && this.client.state.power)
                .onSet((value) => {
                this.client.setMute(!Boolean(value));
            });
            fanSvc
                .getCharacteristic(Characteristic.RotationSpeed)
                .onGet(() => this.client.dbToPercentage(this.client.state.volume))
                .onSet((value) => {
                this.client.setVolumePercentage(Number(value));
            });
            this.volumeService = fanSvc;
        }
        else {
            let lightSvc = this.accessory.getServiceById(Service.Lightbulb, lightSubtype);
            if (!lightSvc) {
                lightSvc = new Service.Lightbulb(volName, lightSubtype);
                lightSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
                lightSvc.setCharacteristic(Characteristic.Name, volName);
                lightSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
                this.accessory.addService(lightSvc);
            }
            else {
                if (!lightSvc.testCharacteristic(Characteristic.ConfiguredName)) {
                    lightSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
                }
                lightSvc.displayName = volName;
                lightSvc.setCharacteristic(Characteristic.Name, volName);
                lightSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
            }
            lightSvc
                .getCharacteristic(Characteristic.On)
                .onGet(() => !this.client.state.mute && this.client.state.power)
                .onSet((value) => {
                this.client.setMute(!Boolean(value));
            });
            lightSvc
                .getCharacteristic(Characteristic.Brightness)
                .onGet(() => this.client.dbToPercentage(this.client.state.volume))
                .onSet((value) => {
                this.client.setVolumePercentage(Number(value));
            });
            this.volumeService = lightSvc;
        }
    }
    setupInputSwitches() {
        const { Service } = this.platform;
        const configuredInputs = (this.deviceConfig.inputs || []).filter((input) => isExplicitlyNamed(input.name));
        const validSubtypes = new Set();
        for (const input of configuredInputs) {
            const subtype = `input-switch-${input.id}`;
            validSubtypes.add(subtype);
            this.registerInputSwitch(input.id, input.name);
        }
        // Remove any previously cached auto-discovered or unnamed input switches
        for (const svc of [...this.accessory.services]) {
            if (svc.UUID === Service.Switch.UUID &&
                svc.subtype?.startsWith('input-switch-') &&
                !validSubtypes.has(svc.subtype)) {
                this.accessory.removeService(svc);
            }
        }
    }
    registerInputSwitch(id, rawName) {
        const { Characteristic } = this.platform;
        const subtype = `input-switch-${id}`;
        const safeName = sanitizeHomeKitName(rawName, `Input ${id}`);
        const switchService = this.createOrUpdateSwitch(subtype, safeName);
        switchService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.client.state.power && this.client.state.currentProfileId === id)
            .onSet((value) => {
            if (Boolean(value)) {
                this.client.setProfile(id);
                for (const [otherId, otherService] of this.inputSwitchServices.entries()) {
                    otherService.updateCharacteristic(Characteristic.On, otherId === id);
                }
            }
            else {
                if (this.client.state.currentProfileId === id) {
                    setTimeout(() => {
                        switchService.updateCharacteristic(Characteristic.On, true);
                    }, 150);
                }
            }
        });
        this.inputSwitchServices.set(id, switchService);
    }
    setupExtraSwitches(cleanDeviceName) {
        const { Service, Characteristic } = this.platform;
        // Mute switch
        const muteSubtype = 'mute-switch';
        if (this.deviceConfig.enableMuteSwitch) {
            const muteName = sanitizeHomeKitName(`${cleanDeviceName} Mute`, 'Altitude Mute');
            this.muteSwitchService = this.createOrUpdateSwitch(muteSubtype, muteName);
            this.muteSwitchService
                .getCharacteristic(Characteristic.On)
                .onGet(() => this.client.state.mute)
                .onSet((value) => {
                this.client.setMute(Boolean(value));
            });
        }
        else {
            const existing = this.accessory.getServiceById(Service.Switch, muteSubtype);
            if (existing) {
                this.accessory.removeService(existing);
            }
        }
        // Optimizer Bypass switch
        const bypassSubtype = 'bypass-switch';
        if (this.deviceConfig.enableBypassSwitch) {
            const bypassName = sanitizeHomeKitName(`${cleanDeviceName} Bypass`, 'Altitude Bypass');
            this.bypassSwitchService = this.createOrUpdateSwitch(bypassSubtype, bypassName);
            this.bypassSwitchService
                .getCharacteristic(Characteristic.On)
                .onGet(() => this.client.state.bypass)
                .onSet((value) => {
                this.client.setBypass(Boolean(value));
            });
        }
        else {
            const existing = this.accessory.getServiceById(Service.Switch, bypassSubtype);
            if (existing) {
                this.accessory.removeService(existing);
            }
        }
        // Presets (Only explicitly named presets!)
        const configuredPresets = (this.deviceConfig.presets || []).filter((preset) => isExplicitlyNamed(preset.name));
        const validPresetSubtypes = new Set();
        for (const preset of configuredPresets) {
            const pSubtype = `preset-${preset.id}`;
            validPresetSubtypes.add(pSubtype);
            const safePresetName = sanitizeHomeKitName(preset.name, `Preset ${preset.id}`);
            const pService = this.createOrUpdateSwitch(pSubtype, safePresetName);
            pService
                .getCharacteristic(Characteristic.On)
                .onGet(() => this.client.state.currentPresetId === preset.id)
                .onSet((value) => {
                if (Boolean(value)) {
                    this.client.setPreset(preset.id);
                    for (const [otherId, otherService] of this.presetSwitchServices.entries()) {
                        otherService.updateCharacteristic(Characteristic.On, otherId === preset.id);
                    }
                }
                else {
                    if (this.client.state.currentPresetId === preset.id) {
                        setTimeout(() => {
                            pService.updateCharacteristic(Characteristic.On, true);
                        }, 150);
                    }
                }
            });
            this.presetSwitchServices.set(preset.id, pService);
        }
        // Remove any stale or unnamed preset switches from cache
        for (const svc of [...this.accessory.services]) {
            if (svc.UUID === Service.Switch.UUID &&
                svc.subtype?.startsWith('preset-') &&
                !validPresetSubtypes.has(svc.subtype)) {
                this.accessory.removeService(svc);
            }
        }
    }
    subscribeClientEvents() {
        const { Characteristic } = this.platform;
        this.client.on('powerChange', (power) => {
            this.powerService.updateCharacteristic(Characteristic.On, power);
            if (this.volumeService) {
                this.volumeService.updateCharacteristic(Characteristic.On, power && !this.client.state.mute);
            }
            if (!power) {
                for (const service of this.inputSwitchServices.values()) {
                    service.updateCharacteristic(Characteristic.On, false);
                }
            }
            else if (this.client.state.currentProfileId !== null) {
                for (const [id, service] of this.inputSwitchServices.entries()) {
                    service.updateCharacteristic(Characteristic.On, id === this.client.state.currentProfileId);
                }
            }
        });
        this.client.on('volumeChange', (_db, percent) => {
            if (this.volumeService) {
                if (this.volumeService.testCharacteristic(Characteristic.RotationSpeed)) {
                    this.volumeService.updateCharacteristic(Characteristic.RotationSpeed, percent);
                }
                else if (this.volumeService.testCharacteristic(Characteristic.Brightness)) {
                    this.volumeService.updateCharacteristic(Characteristic.Brightness, percent);
                }
            }
        });
        this.client.on('muteChange', (muted) => {
            if (this.muteSwitchService) {
                this.muteSwitchService.updateCharacteristic(Characteristic.On, muted);
            }
            if (this.volumeService) {
                this.volumeService.updateCharacteristic(Characteristic.On, !muted && this.client.state.power);
            }
        });
        this.client.on('profileChange', (profileId) => {
            for (const [id, service] of this.inputSwitchServices.entries()) {
                service.updateCharacteristic(Characteristic.On, id === profileId);
            }
        });
        this.client.on('presetChange', (presetId) => {
            for (const [id, service] of this.presetSwitchServices.entries()) {
                service.updateCharacteristic(Characteristic.On, id === presetId);
            }
        });
        this.client.on('bypassChange', (bypassed) => {
            if (this.bypassSwitchService) {
                this.bypassSwitchService.updateCharacteristic(Characteristic.On, bypassed);
            }
        });
    }
}
exports.TrinnovBridgedAccessory = TrinnovBridgedAccessory;
/**
 * Standalone Television / Receiver Accessory (`Trinnov Altitude32 Receiver`):
 * Exposes `Service.Television` + `Service.TelevisionSpeaker` + explicitly named `Service.InputSource`s.
 * Allows the iOS Apple TV Remote widget (and hardware volume buttons) to control the Altitude volume!
 */
class TrinnovTelevisionAccessory {
    platform;
    accessory;
    client;
    deviceConfig;
    tvService;
    speakerService;
    inputServices = new Map();
    constructor(platform, accessory, client, deviceConfig) {
        this.platform = platform;
        this.accessory = accessory;
        this.client = client;
        this.deviceConfig = deviceConfig;
        const { Service, Characteristic } = this.platform;
        const cleanTvName = sanitizeHomeKitName(this.deviceConfig.name, 'Trinnov Altitude32');
        const infoService = this.accessory.getService(Service.AccessoryInformation);
        infoService
            .setCharacteristic(Characteristic.Name, cleanTvName)
            .setCharacteristic(Characteristic.Manufacturer, 'Trinnov Audio')
            .setCharacteristic(Characteristic.Model, 'Altitude32')
            .setCharacteristic(Characteristic.SerialNumber, `TRINNOV-TV-${this.deviceConfig.host}`)
            .setCharacteristic(Characteristic.FirmwareRevision, settings_1.PLUGIN_VERSION);
        this.tvService = this.accessory.getService(Service.Television) ||
            this.accessory.addService(Service.Television, cleanTvName, 'altitude-receiver');
        this.tvService
            .setCharacteristic(Characteristic.Name, cleanTvName)
            .setCharacteristic(Characteristic.ConfiguredName, cleanTvName)
            .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
        this.tvService
            .getCharacteristic(Characteristic.Active)
            .onGet(() => {
            return this.client.state.power
                ? Characteristic.Active.ACTIVE
                : Characteristic.Active.INACTIVE;
        })
            .onSet(async (value) => {
            const targetActive = value === Characteristic.Active.ACTIVE;
            if (targetActive) {
                await this.client.powerOn();
            }
            else {
                this.client.powerOff();
            }
        });
        this.tvService
            .getCharacteristic(Characteristic.ActiveIdentifier)
            .onGet(() => this.client.state.currentProfileId ?? 0)
            .onSet((value) => {
            this.client.setProfile(Number(value));
        });
        this.tvService
            .getCharacteristic(Characteristic.RemoteKey)
            .onSet((value) => {
            this.handleRemoteKey(Number(value));
        });
        const speakerName = sanitizeHomeKitName(`${cleanTvName} Speaker`, 'Altitude Speaker');
        this.speakerService = this.accessory.getService(Service.TelevisionSpeaker) ||
            this.accessory.addService(Service.TelevisionSpeaker, speakerName, 'altitude-speaker');
        this.speakerService
            .setCharacteristic(Characteristic.Name, speakerName)
            .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
            .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
        this.speakerService
            .getCharacteristic(Characteristic.Mute)
            .onGet(() => this.client.state.mute)
            .onSet((value) => {
            this.client.setMute(Boolean(value));
        });
        this.speakerService
            .getCharacteristic(Characteristic.VolumeSelector)
            .onSet((value) => {
            if (value === Characteristic.VolumeSelector.INCREMENT) {
                this.client.adjustVolumeDb(1.0);
            }
            else if (value === Characteristic.VolumeSelector.DECREMENT) {
                this.client.adjustVolumeDb(-1.0);
            }
        });
        this.speakerService
            .getCharacteristic(Characteristic.Volume)
            .onGet(() => this.client.dbToPercentage(this.client.state.volume))
            .onSet((value) => {
            this.client.setVolumePercentage(Number(value));
        });
        this.tvService.addLinkedService(this.speakerService);
        // Only register explicitly named inputs from config (never auto-propagate all 32 Trinnov profiles)
        this.setupInputSources();
        this.subscribeClientEvents();
    }
    setupInputSources() {
        const configuredInputs = (this.deviceConfig.inputs || []).filter((input) => isExplicitlyNamed(input.name));
        for (const input of configuredInputs) {
            this.registerInputSource(input.id, input.name, input.type);
        }
    }
    registerInputSource(id, rawName, type) {
        const { Service, Characteristic } = this.platform;
        const subtype = `input-${id}`;
        const safeName = sanitizeHomeKitName(rawName, `Input ${id}`);
        let inputService = this.accessory.getServiceById(Service.InputSource, subtype);
        if (!inputService) {
            inputService = new Service.InputSource(safeName, subtype);
            inputService.setCharacteristic(Characteristic.Name, safeName);
            inputService.setCharacteristic(Characteristic.ConfiguredName, safeName);
            this.accessory.addService(inputService);
        }
        else {
            inputService.displayName = safeName;
            inputService.setCharacteristic(Characteristic.Name, safeName);
            inputService.setCharacteristic(Characteristic.ConfiguredName, safeName);
        }
        let hapInputType = Characteristic.InputSourceType.HDMI;
        if (type === 'AIRPLAY') {
            hapInputType = Characteristic.InputSourceType.AIRPLAY;
        }
        else if (type === 'OTHER' || type === 'AUDIO_SYSTEM') {
            hapInputType = Characteristic.InputSourceType.OTHER;
        }
        inputService
            .setCharacteristic(Characteristic.Identifier, id)
            .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
            .setCharacteristic(Characteristic.InputSourceType, hapInputType)
            .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
        this.tvService.addLinkedService(inputService);
        this.inputServices.set(id, inputService);
    }
    handleRemoteKey(key) {
        const { Characteristic } = this.platform;
        switch (key) {
            case Characteristic.RemoteKey.REWIND:
                this.client.adjustVolumeDb(-2.0);
                break;
            case Characteristic.RemoteKey.FAST_FORWARD:
                this.client.adjustVolumeDb(2.0);
                break;
            case Characteristic.RemoteKey.NEXT_TRACK:
            case Characteristic.RemoteKey.ARROW_UP:
                this.client.adjustVolumeDb(1.0);
                break;
            case Characteristic.RemoteKey.PREVIOUS_TRACK:
            case Characteristic.RemoteKey.ARROW_DOWN:
                this.client.adjustVolumeDb(-1.0);
                break;
            case Characteristic.RemoteKey.PLAY_PAUSE:
            case Characteristic.RemoteKey.SELECT:
                this.client.toggleMute();
                break;
            case Characteristic.RemoteKey.INFORMATION:
                this.client.sendRaw('send_volume');
                break;
            default:
                break;
        }
    }
    subscribeClientEvents() {
        const { Characteristic } = this.platform;
        this.client.on('powerChange', (power) => {
            this.tvService.updateCharacteristic(Characteristic.Active, power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
        });
        this.client.on('volumeChange', (_db, percent) => {
            this.speakerService.updateCharacteristic(Characteristic.Volume, percent);
        });
        this.client.on('muteChange', (muted) => {
            this.speakerService.updateCharacteristic(Characteristic.Mute, muted);
        });
        this.client.on('profileChange', (profileId) => {
            if (this.inputServices.has(profileId)) {
                this.tvService.updateCharacteristic(Characteristic.ActiveIdentifier, profileId);
            }
        });
    }
}
exports.TrinnovTelevisionAccessory = TrinnovTelevisionAccessory;
//# sourceMappingURL=platformAccessory.js.map