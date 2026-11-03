import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { TrinnovAltitudePlatform } from './platform';
import { TrinnovClient } from './trinnovClient';
import { PLUGIN_VERSION } from './settings';

export interface InputSourceConfig {
  id?: number;
  name?: string;
  type?: 'HDMI' | 'AUDIO_SYSTEM' | 'AIRPLAY' | 'OTHER';
}

export interface PresetConfig {
  id?: number;
  name?: string;
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
export function sanitizeHomeKitName(rawName: string, fallback = 'Trinnov Control'): string {
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
export function isExplicitlyNamed(rawName?: string): boolean {
  if (!rawName) {
    return false;
  }
  const trimmed = rawName.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(switch|preset|profile|input|config|unnamed|empty|none)\s*#?\d*$/i.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Unified Trinnov Altitude Receiver Accessory:
 * The ONLY accessory exposed to HomeKit.
 *
 * Exposes:
 * - Service.Television (`AUDIO_RECEIVER`): Power (WoL / Standby) and Input Source selector
 * - Service.InputSource: Explicitly named Trinnov Profiles (unnamed profiles are ignored)
 * - In-Room Volume Slider (`Service.Fan` or `Service.Lightbulb`) & Explicitly Named Preset switches on the same Receiver accessory
 */
export class TrinnovReceiverAccessory {
  private tvService: Service;
  private volumeSliderService?: Service;
  private muteSwitchService?: Service;
  private bypassSwitchService?: Service;
  private inputServices: Map<number, Service> = new Map();
  private presetSwitchServices: Map<number, Service> = new Map();

  constructor(
    private readonly platform: TrinnovAltitudePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: TrinnovClient,
    private readonly deviceConfig: TrinnovDeviceConfig,
  ) {
    const { Service, Characteristic } = this.platform;
    const cleanName = sanitizeHomeKitName(this.deviceConfig.name, 'Trinnov Altitude32');

    // 1. Accessory Information
    const infoService = this.accessory.getService(Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(Characteristic.Name, cleanName)
      .setCharacteristic(Characteristic.Manufacturer, 'Trinnov Audio')
      .setCharacteristic(Characteristic.Model, 'Altitude32')
      .setCharacteristic(Characteristic.SerialNumber, `TRINNOV-${this.deviceConfig.host}`)
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    // 2. Primary Television / Receiver Service
    this.tvService = this.accessory.getService(Service.Television) ||
      this.accessory.addService(Service.Television, cleanName, 'altitude-receiver');
    this.tvService.setPrimaryService(true);

    this.tvService
      .setCharacteristic(Characteristic.Name, cleanName)
      .setCharacteristic(Characteristic.ConfiguredName, cleanName)
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
        this.platform.log.info(`[${cleanName}] HomeKit Power set -> ${targetActive ? 'ON' : 'OFF'}`);
        if (targetActive) {
          await this.client.powerOn();
        } else {
          await this.client.powerOff();
        }
      });

    this.tvService
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.client.state.currentProfileId ?? 0)
      .onSet((value: CharacteristicValue) => {
        this.platform.log.info(`[${cleanName}] HomeKit Input selected -> Profile ${value}`);
        this.client.setProfile(Number(value));
      });

    this.tvService
      .getCharacteristic(Characteristic.RemoteKey)
      .onSet((value: CharacteristicValue) => {
        this.platform.log.debug(`[${cleanName}] HomeKit RemoteKey pressed -> ${value} (volume control via remote disabled)`);
      });

    // 3. Remove any legacy TelevisionSpeaker service so Apple TV Remote does not control volume
    const existingSpeaker = this.accessory.getService(Service.TelevisionSpeaker);
    if (existingSpeaker) {
      this.tvService.removeLinkedService(existingSpeaker);
      this.accessory.removeService(existingSpeaker);
    }

    // 4. Explicitly Named Input Sources (Profiles) in the Receiver's Input Picker
    this.setupInputSources();

    // 5. In-Room Volume Slider & Named Preset Switches on the Receiver Accessory
    // IMPORTANT: Do NOT call tvService.addLinkedService() on Fan/Lightbulb/Switch services!
    // In iOS Home, linking non-InputSource services to Service.Television causes Home.app
    // to treat them as hidden internal TV sub-services and suppresses their tiles!
    this.setupVolumeSlider(cleanName);
    this.setupSwitches(cleanName);

    // 6. Subscribe to Live Client Events
    this.subscribeClientEvents();
  }

  private setupInputSources(): void {
    const configuredInputs = (this.deviceConfig.inputs || []).filter((input) =>
      isExplicitlyNamed(input.name),
    );

    for (const [idx, input] of configuredInputs.entries()) {
      const inputId = typeof input.id === 'number' ? input.id : idx;
      this.registerInputSource(inputId, input.name!, input.type);
    }
  }

  private registerInputSource(id: number, rawName: string, type?: string): void {
    const { Service, Characteristic } = this.platform;
    const subtype = `input-${id}`;
    const safeName = sanitizeHomeKitName(rawName, `Input ${id}`);

    let hapInputType = Characteristic.InputSourceType.HDMI;
    if (type === 'AIRPLAY') {
      hapInputType = Characteristic.InputSourceType.AIRPLAY;
    } else if (type === 'OTHER' || type === 'AUDIO_SYSTEM') {
      hapInputType = Characteristic.InputSourceType.OTHER;
    }

    let inputService = this.accessory.getServiceById(Service.InputSource, subtype);
    if (!inputService) {
      inputService = new Service.InputSource(safeName, subtype);
      inputService
        .setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.Name, safeName)
        .setCharacteristic(Characteristic.ConfiguredName, safeName)
        .setCharacteristic(
          Characteristic.IsConfigured,
          Characteristic.IsConfigured.CONFIGURED,
        )
        .setCharacteristic(Characteristic.InputSourceType, hapInputType)
        .setCharacteristic(
          Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN,
        );
      this.accessory.addService(inputService);
    } else {
      inputService.displayName = safeName;
      inputService
        .setCharacteristic(Characteristic.Identifier, id)
        .setCharacteristic(Characteristic.Name, safeName)
        .setCharacteristic(Characteristic.ConfiguredName, safeName)
        .setCharacteristic(
          Characteristic.IsConfigured,
          Characteristic.IsConfigured.CONFIGURED,
        )
        .setCharacteristic(Characteristic.InputSourceType, hapInputType)
        .setCharacteristic(
          Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN,
        );
    }

    this.tvService.addLinkedService(inputService);
    this.inputServices.set(id, inputService);
  }

  private createOrUpdateSwitch(subtype: string, rawName: string): Service {
    const { Service, Characteristic } = this.platform;
    const safeName = sanitizeHomeKitName(rawName, 'Trinnov Switch');

    let svc = this.accessory.getServiceById(Service.Switch, subtype);
    if (!svc) {
      svc = new Service.Switch(safeName, subtype);
      svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      svc.setCharacteristic(Characteristic.Name, safeName);
      svc.setCharacteristic(Characteristic.ConfiguredName, safeName);
      this.accessory.addService(svc);
    } else {
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

  private setupVolumeSlider(cleanDeviceName: string): void {
    const { Service, Characteristic } = this.platform;
    const fanSubtype = 'companion-volume-fan';
    const lightSubtype = 'companion-volume';

    const enabled = this.deviceConfig.enableVolumeSlider !== false &&
      this.deviceConfig.volumeAccessoryType !== 'none';
    const sliderType = this.deviceConfig.volumeAccessoryType || 'fan';
    const volName = sanitizeHomeKitName(`${cleanDeviceName} Volume`, 'Altitude Volume');

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
        fanSvc.addOptionalCharacteristic(Characteristic.RotationSpeed);
        fanSvc.setCharacteristic(Characteristic.Name, volName);
        fanSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
        this.accessory.addService(fanSvc);
      } else {
        if (!fanSvc.testCharacteristic(Characteristic.ConfiguredName)) {
          fanSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        if (!fanSvc.testCharacteristic(Characteristic.RotationSpeed)) {
          fanSvc.addOptionalCharacteristic(Characteristic.RotationSpeed);
        }
        fanSvc.displayName = volName;
        fanSvc.setCharacteristic(Characteristic.Name, volName);
        fanSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
      }

      fanSvc
        .getCharacteristic(Characteristic.On)
        .onGet(() => !this.client.state.mute && this.client.state.power)
        .onSet((value: CharacteristicValue) => {
          this.platform.log.info(`[${cleanDeviceName}] Volume Slider Mute Toggle -> ${!Boolean(value)}`);
          this.client.setMute(!Boolean(value));
        });

      fanSvc
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() => this.client.dbToPercentage(this.client.state.volume))
        .onSet((value: CharacteristicValue) => {
          this.platform.log.info(`[${cleanDeviceName}] Volume Slider set -> ${value}%`);
          this.client.setVolumePercentage(Number(value));
        });

      this.volumeSliderService = fanSvc;
    } else {
      let lightSvc = this.accessory.getServiceById(Service.Lightbulb, lightSubtype);
      if (!lightSvc) {
        lightSvc = new Service.Lightbulb(volName, lightSubtype);
        lightSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        lightSvc.addOptionalCharacteristic(Characteristic.Brightness);
        lightSvc.setCharacteristic(Characteristic.Name, volName);
        lightSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
        this.accessory.addService(lightSvc);
      } else {
        if (!lightSvc.testCharacteristic(Characteristic.ConfiguredName)) {
          lightSvc.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        if (!lightSvc.testCharacteristic(Characteristic.Brightness)) {
          lightSvc.addOptionalCharacteristic(Characteristic.Brightness);
        }
        lightSvc.displayName = volName;
        lightSvc.setCharacteristic(Characteristic.Name, volName);
        lightSvc.setCharacteristic(Characteristic.ConfiguredName, volName);
      }

      lightSvc
        .getCharacteristic(Characteristic.On)
        .onGet(() => !this.client.state.mute && this.client.state.power)
        .onSet((value: CharacteristicValue) => {
          this.platform.log.info(`[${cleanDeviceName}] Volume Slider Mute Toggle -> ${!Boolean(value)}`);
          this.client.setMute(!Boolean(value));
        });

      lightSvc
        .getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.client.dbToPercentage(this.client.state.volume))
        .onSet((value: CharacteristicValue) => {
          this.platform.log.info(`[${cleanDeviceName}] Volume Slider set -> ${value}%`);
          this.client.setVolumePercentage(Number(value));
        });

      this.volumeSliderService = lightSvc;
    }
  }

  private setupSwitches(cleanDeviceName: string): void {
    const { Characteristic } = this.platform;

    if (this.deviceConfig.enableMuteSwitch) {
      const muteName = sanitizeHomeKitName(`${cleanDeviceName} Mute`, 'Altitude Mute');
      this.muteSwitchService = this.createOrUpdateSwitch('mute-switch', muteName);
      this.muteSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.mute)
        .onSet((value: CharacteristicValue) => {
          this.client.setMute(Boolean(value));
        });
    }

    if (this.deviceConfig.enableBypassSwitch) {
      const bypassName = sanitizeHomeKitName(`${cleanDeviceName} Bypass`, 'Altitude Bypass');
      this.bypassSwitchService = this.createOrUpdateSwitch('bypass-switch', bypassName);
      this.bypassSwitchService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.bypass)
        .onSet((value: CharacteristicValue) => {
          this.client.setBypass(Boolean(value));
        });
    }

    // Named Presets only
    const configuredPresets = (this.deviceConfig.presets || []).filter((preset) =>
      isExplicitlyNamed(preset.name),
    );

    for (const [idx, preset] of configuredPresets.entries()) {
      const presetId = typeof preset.id === 'number' ? preset.id : idx + 1;
      const pSubtype = `preset-${presetId}`;
      const safePresetName = sanitizeHomeKitName(preset.name!, `Preset ${presetId}`);
      const pService = this.createOrUpdateSwitch(pSubtype, safePresetName);

      pService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.client.state.currentPresetId === presetId)
        .onSet((value: CharacteristicValue) => {
          if (Boolean(value)) {
            this.platform.log.info(`[${cleanDeviceName}] HomeKit Preset selected -> Preset ${presetId} (${safePresetName})`);
            this.client.setPreset(presetId);
            for (const [otherId, otherService] of this.presetSwitchServices.entries()) {
              otherService.updateCharacteristic(Characteristic.On, otherId === presetId);
            }
          } else {
            if (this.client.state.currentPresetId === presetId) {
              setTimeout(() => {
                pService.updateCharacteristic(Characteristic.On, true);
              }, 150);
            }
          }
        });

      this.presetSwitchServices.set(presetId, pService);
    }
  }

  private subscribeClientEvents(): void {
    const { Characteristic } = this.platform;

    this.client.on('powerChange', (power: boolean) => {
      this.tvService.updateCharacteristic(
        Characteristic.Active,
        power ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
      if (this.volumeSliderService) {
        this.volumeSliderService.updateCharacteristic(Characteristic.On, power && !this.client.state.mute);
      }
    });

    this.client.on('volumeChange', (_db: number, percent: number) => {
      if (this.volumeSliderService) {
        if (this.volumeSliderService.testCharacteristic(Characteristic.RotationSpeed)) {
          this.volumeSliderService.updateCharacteristic(Characteristic.RotationSpeed, percent);
        } else if (this.volumeSliderService.testCharacteristic(Characteristic.Brightness)) {
          this.volumeSliderService.updateCharacteristic(Characteristic.Brightness, percent);
        }
      }
    });

    this.client.on('muteChange', (muted: boolean) => {
      if (this.muteSwitchService) {
        this.muteSwitchService.updateCharacteristic(Characteristic.On, muted);
      }
      if (this.volumeSliderService) {
        this.volumeSliderService.updateCharacteristic(Characteristic.On, !muted && this.client.state.power);
      }
    });

    this.client.on('profileChange', (profileId: number) => {
      if (this.inputServices.has(profileId)) {
        this.tvService.updateCharacteristic(Characteristic.ActiveIdentifier, profileId);
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
