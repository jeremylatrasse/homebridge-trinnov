import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
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
export class TrinnovBridgedAccessory {
  private powerService: Service;
  private volumeService?: Service;
  private muteSwitchService?: Service;
  private bypassSwitchService?: Service;
  private inputSwitchServices: Map<number, Service> = new Map();
  private presetSwitchServices: Map<number, Service> = new Map();

  constructor(
    private readonly platform: TrinnovAltitudePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: TrinnovClient,
    private readonly deviceConfig: TrinnovDeviceConfig,
  ) {
    const { Service, Characteristic } = this.platform;

    // 1. Accessory Information
    const infoService = this.accessory.getService(Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(Characteristic.Name, this.deviceConfig.name)
      .setCharacteristic(Characteristic.Manufacturer, 'Trinnov Audio')
      .setCharacteristic(Characteristic.Model, 'Altitude32')
      .setCharacteristic(Characteristic.SerialNumber, `TRINNOV-${this.deviceConfig.host}`)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');

    // 2. Main Power Switch
    const powerSubtype = 'power-switch';
    this.powerService = this.accessory.getServiceById(Service.Switch, powerSubtype) ||
      this.accessory.addService(Service.Switch, `${this.deviceConfig.name} Power`, powerSubtype);

    this.powerService.setCharacteristic(Characteristic.Name, `${this.deviceConfig.name} Power`);
    this.powerService.setCharacteristic(Characteristic.ConfiguredName, `${this.deviceConfig.name} Power`);

    this.powerService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.client.state.power)
      .onSet(async (value: CharacteristicValue) => {
        if (Boolean(value)) {
          await this.client.powerOn();
        } else {
          this.client.powerOff();
        }
      });

    // 3. Volume Slider (Enabled by default so you have immediate volume + mute control in the Home app)
    this.setupVolumeSlider();

    // 4. Input Selection Switches (Trinnov Profiles)
    this.setupInputSwitches();

    // 5. Optional Mute, Bypass, and Preset Switches
    this.setupExtraSwitches();

    // 6. Subscribe to Live Client Events
    this.subscribeClientEvents();
  }

  private setupVolumeSlider(): void {
    const { Service, Characteristic } = this.platform;
    const subtype = 'companion-volume';
    const enabled = this.deviceConfig.enableVolumeSlider !== false; // default true

    if (enabled) {
      const volName = `${this.deviceConfig.name} Volume`;
      this.volumeService = this.accessory.getServiceById(Service.Lightbulb, subtype) ||
        this.accessory.addService(Service.Lightbulb, volName, subtype);

      this.volumeService.setCharacteristic(Characteristic.Name, volName);
      this.volumeService.setCharacteristic(Characteristic.ConfiguredName, volName);

      this.volumeService
        .getCharacteristic(Characteristic.On)
        .onGet(() => !this.client.state.mute && this.client.state.power)
        .onSet((value: CharacteristicValue) => {
          this.client.setMute(!Boolean(value));
        });

      this.volumeService
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.client.dbToPercentage(this.client.state.volume))
        .onSet((value: CharacteristicValue) => {
          this.client.setVolumePercentage(Number(value));
        });
    } else {
      const existing = this.accessory.getServiceById(Service.Lightbulb, subtype);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }
  }

  private setupInputSwitches(): void {
    const configuredInputs = this.deviceConfig.inputs && this.deviceConfig.inputs.length > 0
      ? this.deviceConfig.inputs
      : [
          { id: 0, name: 'Apple TV' },
          { id: 1, name: 'Kaleidescape' },
          { id: 2, name: 'Blu-ray / Disc' },
          { id: 3, name: 'Turntable / Phono' },
          { id: 4, name: 'Roon / Streamer' },
          { id: 5, name: 'Game Console' },
        ];

    for (const input of configuredInputs) {
      this.registerInputSwitch(input.id, input.name);
    }
  }

  private registerInputSwitch(id: number, name: string): void {
    const { Service, Characteristic } = this.platform;
    const subtype = `input-switch-${id}`;
    const label = `Input: ${name}`;

    let switchService = this.accessory.getServiceById(Service.Switch, subtype);
    if (!switchService) {
      switchService = this.accessory.addService(Service.Switch, label, subtype);
    }

    switchService.setCharacteristic(Characteristic.Name, label);
    switchService.setCharacteristic(Characteristic.ConfiguredName, label);

    switchService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.client.state.power && this.client.state.currentProfileId === id)
      .onSet((value: CharacteristicValue) => {
        if (Boolean(value)) {
          this.client.setProfile(id);
          // Radio-button behavior: turn on selected input and turn off others immediately in UI
          for (const [otherId, otherService] of this.inputSwitchServices.entries()) {
            otherService.updateCharacteristic(Characteristic.On, otherId === id);
          }
        } else {
          // Keep current profile switch ON if user taps the already-active input
          if (this.client.state.currentProfileId === id) {
            setTimeout(() => {
              switchService?.updateCharacteristic(Characteristic.On, true);
            }, 150);
          }
        }
      });

    this.inputSwitchServices.set(id, switchService);
  }

  private setupExtraSwitches(): void {
    const { Service, Characteristic } = this.platform;

    // Mute switch
    const muteSubtype = 'mute-switch';
    if (this.deviceConfig.enableMuteSwitch) {
      const muteName = `${this.deviceConfig.name} Mute`;
      this.muteSwitchService = this.accessory.getServiceById(Service.Switch, muteSubtype) ||
        this.accessory.addService(Service.Switch, muteName, muteSubtype);

      this.muteSwitchService.setCharacteristic(Characteristic.Name, muteName);
      this.muteSwitchService.setCharacteristic(Characteristic.ConfiguredName, muteName);

      this.muteSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.mute)
        .onSet((value: CharacteristicValue) => {
          this.client.setMute(Boolean(value));
        });
    } else {
      const existing = this.accessory.getServiceById(Service.Switch, muteSubtype);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    // Optimizer Bypass switch
    const bypassSubtype = 'bypass-switch';
    if (this.deviceConfig.enableBypassSwitch) {
      const bypassName = `${this.deviceConfig.name} Bypass`;
      this.bypassSwitchService = this.accessory.getServiceById(Service.Switch, bypassSubtype) ||
        this.accessory.addService(Service.Switch, bypassName, bypassSubtype);

      this.bypassSwitchService.setCharacteristic(Characteristic.Name, bypassName);
      this.bypassSwitchService.setCharacteristic(Characteristic.ConfiguredName, bypassName);

      this.bypassSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.bypass)
        .onSet((value: CharacteristicValue) => {
          this.client.setBypass(Boolean(value));
        });
    } else {
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
          this.accessory.addService(Service.Switch, preset.name, pSubtype);

        pService.setCharacteristic(Characteristic.Name, preset.name);
        pService.setCharacteristic(Characteristic.ConfiguredName, preset.name);

        pService
          .getCharacteristic(Characteristic.On)
          .onGet(() => this.client.state.currentPresetId === preset.id)
          .onSet((value: CharacteristicValue) => {
            if (Boolean(value)) {
              this.client.setPreset(preset.id);
            }
          });

        this.presetSwitchServices.set(preset.id, pService);
      }
    }
  }

  private subscribeClientEvents(): void {
    const { Characteristic } = this.platform;

    this.client.on('powerChange', (power: boolean) => {
      this.powerService.updateCharacteristic(Characteristic.On, power);
      if (this.volumeService) {
        this.volumeService.updateCharacteristic(Characteristic.On, power && !this.client.state.mute);
      }
      if (!power) {
        for (const service of this.inputSwitchServices.values()) {
          service.updateCharacteristic(Characteristic.On, false);
        }
      } else if (this.client.state.currentProfileId !== null) {
        for (const [id, service] of this.inputSwitchServices.entries()) {
          service.updateCharacteristic(Characteristic.On, id === this.client.state.currentProfileId);
        }
      }
    });

    this.client.on('volumeChange', (_db: number, percent: number) => {
      if (this.volumeService) {
        this.volumeService.updateCharacteristic(Characteristic.Brightness, percent);
      }
    });

    this.client.on('muteChange', (muted: boolean) => {
      if (this.muteSwitchService) {
        this.muteSwitchService.updateCharacteristic(Characteristic.On, muted);
      }
      if (this.volumeService) {
        this.volumeService.updateCharacteristic(Characteristic.On, !muted && this.client.state.power);
      }
    });

    this.client.on('profileChange', (profileId: number) => {
      for (const [id, service] of this.inputSwitchServices.entries()) {
        service.updateCharacteristic(Characteristic.On, id === profileId);
      }
    });

    this.client.on('profileDiscovered', (id: number, name: string) => {
      if (!this.inputSwitchServices.has(id)) {
        this.registerInputSwitch(id, name);
      }
    });

    this.client.on('presetChange', (presetId: number) => {
      for (const [id, service] of this.presetSwitchServices.entries()) {
        service.updateCharacteristic(Characteristic.On, id === presetId);
      }
    });

    this.client.on('bypassChange', (bypassed: boolean) => {
      if (this.bypassSwitchService) {
        this.bypassSwitchService.updateCharacteristic(Characteristic.On, bypassed);
      }
    });
  }
}

/**
 * Optional Standalone Television / Receiver Accessory:
 * Published as an unbridged external accessory for users who also want the
 * iOS Control Center Apple Remote widget and native TV input picker.
 */
export class TrinnovTelevisionAccessory {
  private tvService: Service;
  private speakerService: Service;
  private inputServices: Map<number, Service> = new Map();

  constructor(
    private readonly platform: TrinnovAltitudePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: TrinnovClient,
    private readonly deviceConfig: TrinnovDeviceConfig,
  ) {
    const { Service, Characteristic } = this.platform;

    const infoService = this.accessory.getService(Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Trinnov Audio')
      .setCharacteristic(Characteristic.Model, 'Altitude32')
      .setCharacteristic(Characteristic.SerialNumber, `TRINNOV-TV-${this.deviceConfig.host}`)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');

    this.tvService = this.accessory.getService(Service.Television) ||
      this.accessory.addService(Service.Television, this.deviceConfig.name, 'altitude-receiver');

    this.tvService
      .setCharacteristic(Characteristic.Name, this.deviceConfig.name)
      .setCharacteristic(Characteristic.ConfiguredName, this.deviceConfig.name)
      .setCharacteristic(
        Characteristic.SleepDiscoveryMode,
        Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
      );

    this.tvService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => {
        return this.client.state.power
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE;
      })
      .onSet(async (value: CharacteristicValue) => {
        const targetActive = value === Characteristic.Active.ACTIVE;
        if (targetActive) {
          await this.client.powerOn();
        } else {
          this.client.powerOff();
        }
      });

    this.tvService
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.client.state.currentProfileId ?? 0)
      .onSet((value: CharacteristicValue) => {
        this.client.setProfile(Number(value));
      });

    this.tvService
      .getCharacteristic(Characteristic.RemoteKey)
      .onSet((value: CharacteristicValue) => {
        this.handleRemoteKey(Number(value));
      });

    this.speakerService = this.accessory.getService(Service.TelevisionSpeaker) ||
      this.accessory.addService(Service.TelevisionSpeaker, `${this.deviceConfig.name} Speaker`, 'altitude-speaker');

    this.speakerService
      .setCharacteristic(
        Characteristic.VolumeControlType,
        Characteristic.VolumeControlType.ABSOLUTE,
      );

    this.speakerService
      .getCharacteristic(Characteristic.Mute)
      .onGet(() => this.client.state.mute)
      .onSet((value: CharacteristicValue) => {
        this.client.setMute(Boolean(value));
      });

    this.speakerService
      .getCharacteristic(Characteristic.VolumeSelector)
      .onSet((value: CharacteristicValue) => {
        if (value === Characteristic.VolumeSelector.INCREMENT) {
          this.client.adjustVolumeDb(1.0);
        } else if (value === Characteristic.VolumeSelector.DECREMENT) {
          this.client.adjustVolumeDb(-1.0);
        }
      });

    if (this.speakerService.testCharacteristic(Characteristic.Volume)) {
      this.speakerService
        .getCharacteristic(Characteristic.Volume)
        .onGet(() => this.client.dbToPercentage(this.client.state.volume))
        .onSet((value: CharacteristicValue) => {
          this.client.setVolumePercentage(Number(value));
        });
    }

    this.tvService.addLinkedService(this.speakerService);

    this.setupInputSources();
    this.subscribeClientEvents();
  }

  private setupInputSources(): void {
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

  private registerInputSource(id: number, name: string, type?: string): void {
    const { Service, Characteristic } = this.platform;
    const subtype = `input-${id}`;

    let inputService = this.accessory.getServiceById(Service.InputSource, subtype);
    if (!inputService) {
      inputService = this.accessory.addService(Service.InputSource, name, subtype);
    }

    let hapInputType = Characteristic.InputSourceType.HDMI;
    if (type === 'AIRPLAY') {
      hapInputType = Characteristic.InputSourceType.AIRPLAY;
    } else if (type === 'OTHER' || type === 'AUDIO_SYSTEM') {
      hapInputType = Characteristic.InputSourceType.OTHER;
    }

    inputService
      .setCharacteristic(Characteristic.Identifier, id)
      .setCharacteristic(Characteristic.ConfiguredName, name)
      .setCharacteristic(
        Characteristic.IsConfigured,
        Characteristic.IsConfigured.CONFIGURED,
      )
      .setCharacteristic(Characteristic.InputSourceType, hapInputType)
      .setCharacteristic(
        Characteristic.CurrentVisibilityState,
        Characteristic.CurrentVisibilityState.SHOWN,
      );

    this.tvService.addLinkedService(inputService);
    this.inputServices.set(id, inputService);
  }

  private handleRemoteKey(key: number): void {
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

  private subscribeClientEvents(): void {
    const { Characteristic } = this.platform;

    this.client.on('powerChange', (power: boolean) => {
      this.tvService.updateCharacteristic(
        Characteristic.Active,
        power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
    });

    this.client.on('volumeChange', (_db: number, percent: number) => {
      if (this.speakerService.testCharacteristic(Characteristic.Volume)) {
        this.speakerService.updateCharacteristic(Characteristic.Volume, percent);
      }
    });

    this.client.on('muteChange', (muted: boolean) => {
      this.speakerService.updateCharacteristic(Characteristic.Mute, muted);
    });

    this.client.on('profileChange', (profileId: number) => {
      this.tvService.updateCharacteristic(Characteristic.ActiveIdentifier, profileId);
    });

    this.client.on('profileDiscovered', (id: number, name: string) => {
      if (!this.inputServices.has(id)) {
        this.registerInputSource(id, name, 'HDMI');
      }
    });
  }
}
