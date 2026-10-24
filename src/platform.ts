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
  TrinnovReceiverAccessory,
  TrinnovDeviceConfig,
  InputSourceConfig,
  PresetConfig,
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
    this.log.info('Loading cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    // 1. Remove any legacy bridged accessories from cache so ONLY the Receiver exists in HomeKit
    if (this.accessories.length > 0) {
      this.log.info(`Removing ${this.accessories.length} legacy bridged accessory(ies) so only the Receiver is exposed...`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
      this.accessories.length = 0;
    }

    const rawDevices = (this.config.devices as TrinnovDeviceConfig[]) || [];
    const devices: TrinnovDeviceConfig[] = [...rawDevices];

    // Also support top-level single-device configuration
    if (devices.length === 0 && typeof this.config.host === 'string' && this.config.host.trim()) {
      devices.push({
        name: (this.config.name as string) || 'Trinnov Altitude32',
        host: (this.config.host as string).trim(),
        port: (this.config.port as number) || 44100,
        mac: this.config.mac as string | undefined,
        minVolumeDb: this.config.minVolumeDb as number | undefined,
        maxVolumeDb: this.config.maxVolumeDb as number | undefined,
        enableVolumeSlider: this.config.enableVolumeSlider as boolean | undefined,
        volumeAccessoryType: this.config.volumeAccessoryType as 'fan' | 'lightbulb' | 'none' | undefined,
        enableMuteSwitch: this.config.enableMuteSwitch as boolean | undefined,
        enableBypassSwitch: this.config.enableBypassSwitch as boolean | undefined,
        inputs: this.config.inputs as InputSourceConfig[] | undefined,
        presets: this.config.presets as PresetConfig[] | undefined,
      });
    }

    if (devices.length === 0) {
      this.log.warn('No Trinnov Altitude devices configured in Homebridge config.');
      return;
    }

    this.log.info(`Configuring ${devices.length} Trinnov Altitude Receiver(s)...`);

    for (const [index, deviceConfig] of devices.entries()) {
      if (!deviceConfig.host) {
        this.log.warn(`Device #${index + 1} is missing IP / host. Skipping.`);
        continue;
      }

      const deviceName = deviceConfig.name?.trim() || `Trinnov Altitude32`;
      const port = deviceConfig.port || 44100;

      this.log.info(`[${deviceName}] Setting up Receiver at ${deviceConfig.host}:${port}`);

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

      // Publish ONLY the single unified Receiver accessory
      const receiverIdentifier = `trinnov:receiver:${deviceConfig.host}:${port}`;
      const receiverUuid = this.api.hap.uuid.generate(receiverIdentifier);
      const receiverAccessory = new this.api.platformAccessory(
        deviceName,
        receiverUuid,
        Categories.AUDIO_RECEIVER || Categories.TELEVISION,
      );

      new TrinnovReceiverAccessory(this, receiverAccessory, client, {
        ...deviceConfig,
        name: deviceName,
      });

      try {
        this.api.publishExternalAccessories(PLUGIN_NAME, [receiverAccessory]);
        this.log.info(
          `[${deviceName}] Published Receiver accessory to HomeKit.`,
        );
      } catch (err: unknown) {
        const error = err as Error;
        this.log.error(`[${deviceName}] Failed to publish Receiver accessory: ${error.message}`);
      }
    }
  }
}
