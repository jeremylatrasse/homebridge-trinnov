import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  TRINNOV_DEFAULT_PORT,
  TRINNOV_DISCOVERY_FILENAME,
} from './settings';
import { TrinnovClient, validateTrinnovHost } from './trinnovClient';
import {
  TrinnovReceiverAccessory,
  TrinnovDeviceConfig,
  InputSourceConfig,
  PresetConfig,
} from './platformAccessory';

export interface NormalizedTrinnovPlatformConfig {
  name: string;
  devices: TrinnovDeviceConfig[];
}

export interface TrinnovDiscoveryFileEntry {
  id: string;
  name: string;
  driver: 'trinnov';
  host: string;
  port: number;
  powered: boolean;
  activeSource?: string;
}

export interface TrinnovDiscoveryFilePayload {
  version: number;
  plugin: string;
  updatedAt: string;
  pid: number;
  processors: TrinnovDiscoveryFileEntry[];
}

export function normalizePlatformConfig(config: PlatformConfig): NormalizedTrinnovPlatformConfig {
  const platformName =
    typeof config.name === 'string' && config.name.trim().length > 0
      ? config.name.trim()
      : 'Trinnov Altitude';

  const rawDevices = Array.isArray(config.devices)
    ? (config.devices as TrinnovDeviceConfig[])
    : [];
  const devices: TrinnovDeviceConfig[] = rawDevices
    .filter((d): d is TrinnovDeviceConfig => Boolean(d && typeof d === 'object'))
    .map((d) => ({
      ...d,
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Trinnov Altitude32',
      host: typeof d.host === 'string' ? d.host.trim() : '',
      port:
        typeof d.port === 'number' && Number.isFinite(d.port) && d.port >= 1 && d.port <= 65535
          ? Math.floor(d.port)
          : TRINNOV_DEFAULT_PORT,
    }));

  // Also support top-level single-device configuration
  if (devices.length === 0 && typeof config.host === 'string' && config.host.trim()) {
    const rawPort = config.port as number | undefined;
    devices.push({
      name: platformName !== 'Trinnov Altitude' ? platformName : 'Trinnov Altitude32',
      host: config.host.trim(),
      port:
        typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535
          ? Math.floor(rawPort)
          : TRINNOV_DEFAULT_PORT,
      mac: config.mac as string | undefined,
      clientName: config.clientName as string | undefined,
      minVolumeDb: config.minVolumeDb as number | undefined,
      maxVolumeDb: config.maxVolumeDb as number | undefined,
      enableVolumeSlider: config.enableVolumeSlider as boolean | undefined,
      volumeAccessoryType: config.volumeAccessoryType as 'fan' | 'lightbulb' | 'none' | undefined,
      enableMuteSwitch: config.enableMuteSwitch as boolean | undefined,
      enableBypassSwitch: config.enableBypassSwitch as boolean | undefined,
      inputs: config.inputs as InputSourceConfig[] | undefined,
      presets: config.presets as PresetConfig[] | undefined,
    });
  }

  return {
    name: platformName,
    devices,
  };
}

interface ManagedDeviceEntry {
  config: TrinnovDeviceConfig;
  client: TrinnovClient;
}

export class TrinnovAltitudePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly clients: TrinnovClient[] = [];
  private readonly managedDevices: ManagedDeviceEntry[] = [];
  private readonly normalizedConfig: NormalizedTrinnovPlatformConfig;
  private readonly registeredPlatformName: string;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.normalizedConfig = normalizePlatformConfig(this.config);
    this.registeredPlatformName = this.config.platform
      ? String(this.config.platform).split('.').pop() || PLATFORM_NAME
      : PLATFORM_NAME;

    this.log.info(
      `Initializing Trinnov Altitude Platform v${PLUGIN_VERSION}: "${this.normalizedConfig.name}"`,
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
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private resolveActiveSourceName(entry: ManagedDeviceEntry): string | undefined {
    const profileId = entry.client.state.currentProfileId;
    if (profileId === null || profileId === undefined) {
      return undefined;
    }
    const configuredInput = (entry.config.inputs || []).find(
      (inp, idx) => (typeof inp.id === 'number' ? inp.id : idx) === profileId,
    );
    if (configuredInput?.name && configuredInput.name.trim()) {
      return configuredInput.name.trim();
    }
    return entry.client.state.profiles.get(profileId);
  }

  private writeDiscoveryFile(): void {
    try {
      const storagePath =
        typeof this.api?.user?.storagePath === 'function'
          ? this.api.user.storagePath()
          : undefined;
      if (!storagePath) {
        return;
      }

      const payload: TrinnovDiscoveryFilePayload = {
        version: 1,
        plugin: PLUGIN_NAME,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        processors: this.managedDevices.map((entry) => ({
          id: `${entry.config.host}:${entry.config.port || TRINNOV_DEFAULT_PORT}`,
          name: entry.config.name,
          driver: 'trinnov',
          host: entry.config.host,
          port: entry.config.port || TRINNOV_DEFAULT_PORT,
          powered: entry.client.state.power,
          activeSource: this.resolveActiveSourceName(entry),
        })),
      };

      const filePath = join(storagePath, TRINNOV_DISCOVERY_FILENAME);
      writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(`Unable to write ${TRINNOV_DISCOVERY_FILENAME}: ${msg}`);
    }
  }

  discoverDevices(): void {
    // 1. Remove any legacy bridged accessories from cache so ONLY the Receiver exists in HomeKit
    if (this.accessories.length > 0) {
      this.log.info(`Removing ${this.accessories.length} legacy bridged accessory(ies) so only the Receiver is exposed...`);
      try {
        this.api.unregisterPlatformAccessories(
          PLUGIN_NAME,
          this.registeredPlatformName,
          this.accessories,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug(`Failed to unregister legacy cached accessories: ${msg}`);
      }
      this.accessories.length = 0;
    }

    const { devices } = this.normalizedConfig;

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

      const hostValidation = validateTrinnovHost(deviceConfig.host);
      if (!hostValidation.valid) {
        this.log.error(`Device #${index + 1} (${deviceConfig.name || 'Trinnov'}): ${hostValidation.reason} Skipping.`);
        continue;
      }

      const deviceName = deviceConfig.name?.trim() || 'Trinnov Altitude32';
      const port = deviceConfig.port || TRINNOV_DEFAULT_PORT;

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

      const managedEntry: ManagedDeviceEntry = {
        config: {
          ...deviceConfig,
          name: deviceName,
          port,
        },
        client,
      };
      this.managedDevices.push(managedEntry);

      client.on('powerChange', () => this.writeDiscoveryFile());
      client.on('profileChange', () => this.writeDiscoveryFile());

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
        port,
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

    this.writeDiscoveryFile();
  }
}
