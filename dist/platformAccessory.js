"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrinnovAccessory = void 0;
class TrinnovAccessory {
    platform;
    accessory;
    client;
    deviceConfig;
    tvService;
    speakerService;
    volumeSliderService;
    muteSwitchService;
    bypassSwitchService;
    inputServices = new Map();
    presetServices = new Map();
    constructor(platform, accessory, client, deviceConfig) {
        this.platform = platform;
        this.accessory = accessory;
        this.client = client;
        this.deviceConfig = deviceConfig;
        const { Service, Characteristic } = this.platform;
        // 1. Accessory Information
        const infoService = this.accessory.getService(Service.AccessoryInformation);
        infoService
            .setCharacteristic(Characteristic.Manufacturer, 'Trinnov Audio')
            .setCharacteristic(Characteristic.Model, 'Altitude32')
            .setCharacteristic(Characteristic.SerialNumber, `TRINNOV-${this.deviceConfig.host}`)
            .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');
        // 2. Television Service (Main AV Receiver Accessory)
        this.tvService = this.accessory.getService(Service.Television) ||
            this.accessory.addService(Service.Television, this.deviceConfig.name, 'altitude-receiver');
        this.tvService
            .setCharacteristic(Characteristic.Name, this.deviceConfig.name)
            .setCharacteristic(Characteristic.ConfiguredName, this.deviceConfig.name)
            .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
        // Active (Power state: 0 = Standby / Off, 1 = On)
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
        // ActiveIdentifier (Current Input Source)
        this.tvService
            .getCharacteristic(Characteristic.ActiveIdentifier)
            .onGet(() => {
            return this.client.state.currentProfileId ?? 0;
        })
            .onSet((value) => {
            const inputId = Number(value);
            this.client.setProfile(inputId);
        });
        // RemoteKey (Control Center Apple Remote buttons)
        this.tvService
            .getCharacteristic(Characteristic.RemoteKey)
            .onSet((value) => {
            this.handleRemoteKey(Number(value));
        });
        // 3. Television Speaker Service (iOS Hardware Volume rocker & Mute)
        this.speakerService = this.accessory.getService(Service.TelevisionSpeaker) ||
            this.accessory.addService(Service.TelevisionSpeaker, `${this.deviceConfig.name} Speaker`, 'altitude-speaker');
        this.speakerService
            .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);
        this.speakerService
            .getCharacteristic(Characteristic.Mute)
            .onGet(() => {
            return this.client.state.mute;
        })
            .onSet((value) => {
            this.client.setMute(Boolean(value));
        });
        // iOS Remote hardware volume keys (VolumeSelector: 0 = INCREMENT, 1 = DECREMENT)
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
        // Absolute Volume characteristic on speaker (0 - 100%)
        if (this.speakerService.testCharacteristic(Characteristic.Volume)) {
            this.speakerService
                .getCharacteristic(Characteristic.Volume)
                .onGet(() => {
                return this.client.dbToPercentage(this.client.state.volume);
            })
                .onSet((value) => {
                this.client.setVolumePercentage(Number(value));
            });
        }
        this.tvService.addLinkedService(this.speakerService);
        // 4. Input Sources (Profile Selection)
        this.setupInputSources();
        // 5. Optional Companion Volume Slider (as Lightbulb brightness for full in-room slider in Home app)
        this.setupCompanionVolumeSlider();
        // 6. Optional Companion Mute & Bypass switches
        this.setupSwitches();
        // 7. Subscribe to Live Client Events
        this.subscribeClientEvents();
    }
    setupInputSources() {
        const configuredInputs = this.deviceConfig.inputs && this.deviceConfig.inputs.length > 0
            ? this.deviceConfig.inputs
            : [
                { id: 0, name: 'Apple TV', type: 'HDMI' },
                { id: 1, name: 'Kaleidescape', type: 'HDMI' },
                { id: 2, name: 'Blu-ray / Disc', type: 'HDMI' },
                { id: 3, name: 'Turntable / Phono', type: 'OTHER' },
                { id: 4, name: 'Roon / Streamer', type: 'AIRPLAY' },
                { id: 5, name: 'Game Console', type: 'HDMI' },
            ];
        for (const input of configuredInputs) {
            this.registerInputSource(input.id, input.name, input.type);
        }
    }
    registerInputSource(id, name, type) {
        const { Service, Characteristic } = this.platform;
        const subtype = `input-${id}`;
        let inputService = this.accessory.getServiceById(Service.InputSource, subtype);
        if (!inputService) {
            inputService = this.accessory.addService(Service.InputSource, name, subtype);
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
            .setCharacteristic(Characteristic.ConfiguredName, name)
            .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
            .setCharacteristic(Characteristic.InputSourceType, hapInputType)
            .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
        this.tvService.addLinkedService(inputService);
        this.inputServices.set(id, inputService);
    }
    setupCompanionVolumeSlider() {
        const { Service, Characteristic } = this.platform;
        const subtype = 'companion-volume';
        if (this.deviceConfig.enableVolumeSlider) {
            this.volumeSliderService = this.accessory.getServiceById(Service.Lightbulb, subtype) ||
                this.accessory.addService(Service.Lightbulb, `${this.deviceConfig.name} Volume`, subtype);
            this.volumeSliderService
                .getCharacteristic(Characteristic.On)
                .onGet(() => !this.client.state.mute && this.client.state.power)
                .onSet((value) => {
                this.client.setMute(!Boolean(value));
            });
            this.volumeSliderService
                .getCharacteristic(Characteristic.Brightness)
                .onGet(() => this.client.dbToPercentage(this.client.state.volume))
                .onSet((value) => {
                this.client.setVolumePercentage(Number(value));
            });
        }
        else {
            const existing = this.accessory.getServiceById(Service.Lightbulb, subtype);
            if (existing) {
                this.accessory.removeService(existing);
            }
        }
    }
    setupSwitches() {
        const { Service, Characteristic } = this.platform;
        // Mute switch
        const muteSubtype = 'mute-switch';
        if (this.deviceConfig.enableMuteSwitch) {
            this.muteSwitchService = this.accessory.getServiceById(Service.Switch, muteSubtype) ||
                this.accessory.addService(Service.Switch, `${this.deviceConfig.name} Mute`, muteSubtype);
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
            this.bypassSwitchService = this.accessory.getServiceById(Service.Switch, bypassSubtype) ||
                this.accessory.addService(Service.Switch, `${this.deviceConfig.name} Bypass`, bypassSubtype);
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
        // Presets
        if (this.deviceConfig.presets && this.deviceConfig.presets.length > 0) {
            for (const preset of this.deviceConfig.presets) {
                const pSubtype = `preset-${preset.id}`;
                const pService = this.accessory.getServiceById(Service.Switch, pSubtype) ||
                    this.accessory.addService(Service.Switch, `${preset.name}`, pSubtype);
                pService
                    .getCharacteristic(Characteristic.On)
                    .onGet(() => this.client.state.currentPresetId === preset.id)
                    .onSet((value) => {
                    if (value) {
                        this.client.setPreset(preset.id);
                    }
                });
                this.presetServices.set(preset.id, pService);
            }
        }
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
            if (this.volumeSliderService) {
                this.volumeSliderService.updateCharacteristic(Characteristic.On, power && !this.client.state.mute);
            }
        });
        this.client.on('volumeChange', (_db, percent) => {
            if (this.speakerService.testCharacteristic(Characteristic.Volume)) {
                this.speakerService.updateCharacteristic(Characteristic.Volume, percent);
            }
            if (this.volumeSliderService) {
                this.volumeSliderService.updateCharacteristic(Characteristic.Brightness, percent);
            }
        });
        this.client.on('muteChange', (muted) => {
            this.speakerService.updateCharacteristic(Characteristic.Mute, muted);
            if (this.muteSwitchService) {
                this.muteSwitchService.updateCharacteristic(Characteristic.On, muted);
            }
            if (this.volumeSliderService) {
                this.volumeSliderService.updateCharacteristic(Characteristic.On, !muted && this.client.state.power);
            }
        });
        this.client.on('profileChange', (profileId) => {
            this.tvService.updateCharacteristic(Characteristic.ActiveIdentifier, profileId);
        });
        this.client.on('profileDiscovered', (id, name) => {
            // Dynamically add discovered profile if not configured
            if (!this.inputServices.has(id)) {
                this.registerInputSource(id, name, 'HDMI');
            }
        });
        this.client.on('presetChange', (presetId) => {
            for (const [id, service] of this.presetServices.entries()) {
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
exports.TrinnovAccessory = TrinnovAccessory;
//# sourceMappingURL=platformAccessory.js.map