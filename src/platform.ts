import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  Categories,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings';
import { TrinnovClient } from './trinnovClient';
import {
  TrinnovBridgedAccessory,
  TrinnovTelevisionAccessory,
  TrinnovDeviceConfig,
} from './platformAccessory';

export class TrinnovAltitudePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly clients: TrinnovClient[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.info(
      `Initializing Trinnov Altitude Platform v${PLUGIN_VERSION}: "${this.config.name || 'Trinnov Altitude'}"`,
    );

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      for (const client of this.clients) {
        client.stop();
      }
    });
  }

  /**
   * Homebridge invokes this method for cached accessories restored from disk.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const rawDevices = (this.config.devices as TrinnovDeviceConfig[]) || [];
    const devices: TrinnovDeviceConfig[] = [...rawDevices];

    // Also support top-level single-device configuration in case "host" was put directly on the platform block
    if (devices.length === 0 && typeof this.config.host === 'string' && this.config.host.trim()) {
      devices.push({
        name: (this.config.name as string) || 'Trinnov Altitude32',
        host: (this.config.host as string).trim(),
        port: (this.config.port as number) || 44100,
        mac: this.config.mac as string | undefined,
        minVolumeDb: this.config.minVolumeDb as number | undefined,
        maxVolumeDb: this.config.maxVolumeDb as number | undefined,
        enableVolumeSlider: this.config.enableVolumeSlider as boolean | undefined,
        enableMuteSwitch: this.config.enableMuteSwitch as boolean | undefined,
        enableBypassSwitch: this.config.enableBypassSwitch as boolean | undefined,
        enableTvAccessory: this.config.enableTvAccessory as boolean | undefined,
      });
    }

    const activeUUIDs = new Set<string>();

    if (devices.length === 0) {
      this.log.warn('No Trinnov Altitude devices configured in Homebridge config.');
      return;
    }

    this.log.info(`Configuring ${devices.length} Trinnov Altitude processor(s)...`);

    for (const [index, deviceConfig] of devices.entries()) {
      if (!deviceConfig.host) {
        this.log.warn(`Device #${index + 1} is missing IP / host. Skipping.`);
        continue;
      }

      const deviceName = deviceConfig.name?.trim() || `Trinnov Altitude ${index + 1}`;
      const port = deviceConfig.port || 44100;

      this.log.info(`[${deviceName}] Setting up at ${deviceConfig.host}:${port}`);

      const client = new TrinnovClient(
        {
          host: deviceConfig.host,
          port,
          mac: deviceConfig.mac,
          clientName: deviceConfig.clientName || 'Homebridge',
          minVolumeDb: deviceConfig.minVolumeDb,
          maxVolumeDb: deviceConfig.maxVolumeDb,
        },
        this.log,
      );
      this.clients.push(client);
      client.start();

      // 1. Register Standard Bridged Accessory (Appears automatically in your HomeKit Home!)
      const bridgedIdentifier = `trinnov:bridged:${deviceConfig.host}:${port}`;
      const bridgedUuid = this.api.hap.uuid.generate(bridgedIdentifier);
      activeUUIDs.add(bridgedUuid);

      const existingAccessory = this.accessories.find((acc) => acc.UUID === bridgedUuid);

      if (existingAccessory) {
        this.log.info(`[${deviceName}] Restoring existing bridged accessory from cache: "${existingAccessory.displayName}"`);
        existingAccessory.displayName = deviceName;
        new TrinnovBridgedAccessory(this, existingAccessory, client, {
          ...deviceConfig,
          name: deviceName,
        });
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(`[${deviceName}] Registering new bridged accessory in HomeKit: "${deviceName}"`);
        const accessory = new this.api.platformAccessory(deviceName, bridgedUuid);
        new TrinnovBridgedAccessory(this, accessory, client, {
          ...deviceConfig,
          name: deviceName,
        });
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // 2. Optional Unbridged Television / Receiver Accessory (for Control Center Remote widget)
      if (deviceConfig.enableTvAccessory) {
        const tvIdentifier = `trinnov:tv:${deviceConfig.host}:${port}`;
        const tvUuid = this.api.hap.uuid.generate(tvIdentifier);
        const tvAccessory = new this.api.platformAccessory(
          `${deviceName} Receiver`,
          tvUuid,
          Categories.AUDIO_RECEIVER || Categories.TELEVISION,
        );

        new TrinnovTelevisionAccessory(this, tvAccessory, client, {
          ...deviceConfig,
          name: `${deviceName} Receiver`,
        });

        try {
          this.api.publishExternalAccessories(PLUGIN_NAME, [tvAccessory]);
          this.log.info(`[${deviceName}] Also published external TV/Receiver accessory.`);
        } catch (err: unknown) {
          const error = err as Error;
          this.log.error(`[${deviceName}] Failed to publish external TV accessory: ${error.message}`);
        }
      }
    }

    // Clean up any stale cached accessories that were removed from config
    const staleAccessories = this.accessories.filter((acc) => !activeUUIDs.has(acc.UUID));
    if (staleAccessories.length > 0) {
      this.log.info(`Removing ${staleAccessories.length} stale cached Trinnov accessory(ies)...`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }
}
