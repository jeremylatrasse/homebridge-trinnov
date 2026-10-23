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

import { PLUGIN_NAME } from './settings';
import { TrinnovClient } from './trinnovClient';
import { TrinnovAccessory, TrinnovDeviceConfig } from './platformAccessory';

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

    this.log.info(`Initializing Trinnov Altitude Platform: "${this.config.name || 'Trinnov Altitude'}"`);

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
    const devices = (this.config.devices as TrinnovDeviceConfig[]) || [];

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
      const deviceIdentifier = `trinnov:${deviceConfig.host}:${deviceConfig.port || 44100}`;
      const uuid = this.api.hap.uuid.generate(deviceIdentifier);

      this.log.info(`[${deviceName}] Setting up at ${deviceConfig.host}:${deviceConfig.port || 44100}`);

      const client = new TrinnovClient(
        {
          host: deviceConfig.host,
          port: deviceConfig.port || 44100,
          mac: deviceConfig.mac,
          clientName: deviceConfig.clientName || 'Homebridge',
          minVolumeDb: deviceConfig.minVolumeDb,
          maxVolumeDb: deviceConfig.maxVolumeDb,
        },
        this.log,
      );
      this.clients.push(client);
      client.start();

      // In Apple HomeKit / HAP, Television / Receiver accessories MUST be published
      // as external accessories so Apple Home enables the Remote widget and Input selector.
      const accessory = new this.api.platformAccessory(
        deviceName,
        uuid,
        Categories.AUDIO_RECEIVER || Categories.TELEVISION,
      );

      new TrinnovAccessory(this, accessory, client, {
        ...deviceConfig,
        name: deviceName,
      });

      try {
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
        this.log.info(
          `[${deviceName}] Successfully published as External Audio Receiver accessory. ` +
          `If this is your first time adding it, open the Apple Home app, tap '+' > 'Add Accessory' > 'More options...' ` +
          `and select '${deviceName}'.`,
        );
      } catch (err: unknown) {
        const error = err as Error;
        this.log.error(`[${deviceName}] Failed to publish external accessory: ${error.message}`);
      }
    }
  }
}
