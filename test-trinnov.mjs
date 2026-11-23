import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  TRINNOV_DEFAULT_PORT,
  TRINNOV_DISCOVERY_FILENAME,
} from './dist/settings.js';
import { TrinnovAltitudePlatform, normalizePlatformConfig } from './dist/platform.js';
import { TrinnovClient, resolvePingPath, validateTrinnovHost } from './dist/trinnovClient.js';
import { sanitizeHomeKitName, isExplicitlyNamed } from './dist/platformAccessory.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

console.log('Testing TrinnovClient math, protocol, discovery & HomeKit sanitization logic...');

const client = new TrinnovClient(
  {
    host: '172.16.1.66',
    port: 44100,
    mac: '00:1E:06:12:34:56',
    minVolumeDb: -90.0,
    maxVolumeDb: 0.0,
  },
  mockLogger,
);

// Test 1: Math conversions (dB <-> Percentage)
assert.strictEqual(client.dbToPercentage(-90.0), 0, 'Min dB should be 0%');
assert.strictEqual(client.dbToPercentage(0.0), 100, 'Max dB should be 100%');
assert.strictEqual(client.dbToPercentage(-45.0), 50, '-45 dB should be 50%');

assert.strictEqual(client.percentageToDb(0), -90.0, '0% should map to min dB');
assert.strictEqual(client.percentageToDb(100), 0.0, '100% should map to max dB');
assert.strictEqual(client.percentageToDb(50), -45.0, '50% should map to -45.0 dB');

// Test 2: Protocol line parsing
let volEmitted = null;
let percentEmitted = null;
client.on('volumeChange', (db, percent) => {
  volEmitted = db;
  percentEmitted = percent;
});

client['handleIncomingData']('VOLUME -32.5\r\n');
assert.strictEqual(volEmitted, -32.5, 'Volume should parse -32.5 dB');
assert.strictEqual(percentEmitted, 64, 'Volume -32.5 should map to 64%');

let muteEmitted = null;
client.on('muteChange', (muted) => {
  muteEmitted = muted;
});
client['handleIncomingData']('MUTE 1\r\n');
assert.strictEqual(muteEmitted, true, 'Mute 1 should parse to true');
client['handleIncomingData']('MUTE 0\r\n');
assert.strictEqual(muteEmitted, false, 'Mute 0 should parse to false');

let profileIdEmitted = null;
client.on('profileChange', (id) => {
  profileIdEmitted = id;
});
client['handleIncomingData']('PROFILE 2: Kaleidescape\r\n');
assert.strictEqual(client.state.profiles.get(2), 'Kaleidescape');

client['handleIncomingData']('PROFILE 2\r\n');
assert.strictEqual(profileIdEmitted, 2);

// Test 3: HomeKit Name Sanitization (fixes HAP-NodeJS WARNING for 'ANALOG BAL IN 1+2 (MIC 4 XLR)')
const sanitized = sanitizeHomeKitName('ANALOG BAL IN 1+2 (MIC 4 XLR)');
assert.strictEqual(sanitized, 'ANALOG BAL IN 1 and 2 MIC 4 XLR');
assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9 '-]*[a-zA-Z0-9]$/.test(sanitized), 'Sanitized name must pass HAP rules');

// Test 4: Unnamed profile / preset filtering
assert.strictEqual(isExplicitlyNamed(''), false);
assert.strictEqual(isExplicitlyNamed('   '), false);
assert.strictEqual(isExplicitlyNamed('Switch 1'), false);
assert.strictEqual(isExplicitlyNamed('Preset 12'), false);
assert.strictEqual(isExplicitlyNamed('Profile 3'), false);
assert.strictEqual(isExplicitlyNamed('Apple TV 4K'), true);
assert.strictEqual(isExplicitlyNamed('Kaleidescape'), true);

// Test 5: Responsiveness check and power state on incoming data
assert.strictEqual(client.state.power, true, 'Power state should become true once unit responds with data');
client.stop();

// Test 6: config.schema.json validation & Config UI X slider audit
const schemaJson = JSON.parse(readFileSync('./config.schema.json', 'utf8'));
assert.strictEqual(schemaJson.pluginAlias, PLATFORM_NAME, 'pluginAlias must match PLATFORM_NAME');
assert.strictEqual(schemaJson.pluginType, 'platform');
const deviceSchema = schemaJson.schema.properties.devices.items;
assert.strictEqual(deviceSchema.properties.host.format, undefined, 'host must not have format:hostname which rejects IPv4 addresses in Homebridge UI');
assert.strictEqual(deviceSchema.properties.inputs.items.required, undefined, 'inputs.items must not mark id/name required (breaks id: 0 and unnamed profiles in Homebridge UI)');
assert.strictEqual(deviceSchema.properties.presets.items.required, undefined, 'presets.items must not mark id/name required (breaks unnamed presets in Homebridge UI)');

// Config UI X Slider Audit: Ensure zero bounded numeric fields render as sliders
const sliderHits = [];
function auditSliders(node, path) {
  if (!node || typeof node !== 'object') {
    return;
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const isBounded = Object.hasOwn(node, 'minimum') && Object.hasOwn(node, 'maximum');
  const isSliderType =
    types.includes('integer') ||
    types.includes('number');
  const hasOverride = Boolean(
    node['x-schema-form']?.type ||
    node['x-schema-form']?.widget?.component ||
    typeof node['x-schema-form']?.widget === 'string' ||
    node.widget?.component ||
    typeof node.widget === 'string',
  );
  if (isBounded && isSliderType && !hasOverride && path !== 'schema.properties._bridge.properties.port') {
    sliderHits.push({ path, type: node.type, minimum: node.minimum, maximum: node.maximum });
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [k, v] of Object.entries(node.properties)) {
      auditSliders(v, `${path}.properties.${k}`);
    }
  }
  if (node.items) {
    if (Array.isArray(node.items)) {
      node.items.forEach((v, i) => auditSliders(v, `${path}.items[${i}]`));
    } else {
      auditSliders(node.items, `${path}.items`);
    }
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) {
      node[key].forEach((v, i) => auditSliders(v, `${path}.${key}[${i}]`));
    }
  }
}
auditSliders(schemaJson.schema, 'schema');
assert.deepStrictEqual(
  sliderHits,
  [],
  `config.schema.json contains bounded numeric fields without x-schema-form.type = "number" (would render as sliders): ${JSON.stringify(sliderHits)}`,
);

// Test 6b: normalizePlatformConfig & resolvePingPath
const normalizedSingle = normalizePlatformConfig({
  platform: 'TrinnovAltitude',
  name: 'Theater Trinnov',
  host: ' 172.16.1.66 ',
});
assert.strictEqual(normalizedSingle.devices.length, 1);
assert.strictEqual(normalizedSingle.devices[0].name, 'Theater Trinnov');
assert.strictEqual(normalizedSingle.devices[0].host, '172.16.1.66');
assert.strictEqual(normalizedSingle.devices[0].port, TRINNOV_DEFAULT_PORT);

assert.strictEqual(
  resolvePingPath({
    configuredPath: 'ping',
    envPath: '/nonexistent',
    isExecutable: (p) => p === '/sbin/ping',
  }),
  '/sbin/ping',
  'resolvePingPath must discover /sbin/ping when PATH is restricted in Child Bridges',
);
assert.strictEqual(
  resolvePingPath({
    configuredPath: '/nonexistent/ping',
    isExecutable: () => false,
  }),
  null,
);

// Test 7: ICMP ping and telnet query responsiveness checks
const localClient = new TrinnovClient(
  {
    host: '127.0.0.1',
    port: 44100,
  },
  mockLogger,
);

const localhostPing = await localClient.pingHost(1000);
assert.strictEqual(localhostPing, true, 'pingHost should succeed on 127.0.0.1');

const responding = await localClient.checkIfResponding(1000);
assert.strictEqual(responding, true, 'checkIfResponding should report true if ping succeeds');

assert.strictEqual(typeof localClient.sendPowerOffCommand, 'function', 'sendPowerOffCommand should be a function');
const reachability = await localClient.probeUnitReachability(1000);
assert.strictEqual(typeof reachability.responding, 'boolean');
assert.strictEqual(typeof reachability.ping, 'boolean');
assert.strictEqual(typeof reachability.telnet, 'boolean');
assert.strictEqual(typeof reachability.http, 'boolean');
assert.strictEqual(reachability.responding, true, 'Reachability responding should be true on localhost');
localClient.stop();

// Test 8: Strict 4-octet IPv4 validation and schema pattern checks
assert.strictEqual(validateTrinnovHost('172.16.66').valid, false, '172.16.66 has 3 octets and must be rejected');
assert.strictEqual(validateTrinnovHost('10.0.0').valid, false, '10.0.0 has 3 octets and must be rejected');
assert.strictEqual(validateTrinnovHost('172.16.1.1.1').valid, false, '5-octet IP must be rejected');
assert.strictEqual(validateTrinnovHost('256.1.1.1').valid, false, 'out-of-range octet must be rejected');
assert.strictEqual(validateTrinnovHost('172.16.1.66').valid, true, '172.16.1.66 has 4 valid octets and must be accepted');
assert.strictEqual(validateTrinnovHost('trinnov.local').valid, true, 'valid hostname must be accepted');

// Verify config.schema.json requires host and enforces 4-octet pattern
const hostPattern = new RegExp(deviceSchema.properties.host.pattern);
assert.strictEqual(hostPattern.test('172.16.66'), false, 'Schema pattern must reject 3-octet IPv4 172.16.66');
assert.strictEqual(hostPattern.test('10.0.0'), false, 'Schema pattern must reject 3-octet IPv4 10.0.0');
assert.strictEqual(hostPattern.test('256.1.1.1'), false, 'Schema pattern must reject out of range IPv4');
assert.strictEqual(hostPattern.test('172.16.1.66'), true, 'Schema pattern must accept 4-octet IPv4 172.16.1.66');
assert.strictEqual(hostPattern.test('trinnov.local'), true, 'Schema pattern must accept hostname');
assert.ok(deviceSchema.required && deviceSchema.required.includes('host'), 'Schema must require host');

// Verify TrinnovClient constructor throws if an invalid 3-octet IP is supplied
assert.throws(
  () => {
    new TrinnovClient({ host: '172.16.66' }, mockLogger);
  },
  /Invalid IPv4 address/,
  'Constructor must reject 3-octet IP',
);

// Test 9: WoL Magic Packet generation & burst transmission
const testClient = new TrinnovClient({ host: '127.0.0.1', mac: '00:1E:06:12:34:56' }, mockLogger);
assert.strictEqual(typeof testClient.sendWakeOnLan, 'function');
await testClient.sendWakeOnLan('00:1E:06:12:34:56');
await assert.rejects(
  () => testClient.sendWakeOnLan('invalid-mac'),
  /Invalid MAC address/,
);
testClient.stop();

// Test 10: Mock TCP server handshake, graceful 'bye' on shutdown, and homebridge-trinnov-discovery.json output
const receivedCommands = [];
const mockServer = net.createServer((socket) => {
  socket.write('Welcome on Trinnov Optimizer (Version 4.3.2, ID 1042)\r\n');
  socket.on('data', (chunk) => {
    const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      receivedCommands.push(line);
      if (line.startsWith('id ')) {
        socket.write('OK\r\n');
      } else if (line === 'send_volume') {
        socket.write('VOLUME -28.0\r\nMUTE 0\r\n');
      } else if (line === 'send_profile') {
        socket.write('CURRENT_PROFILE 0\r\n');
      }
    }
  });
});

await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
const mockPort = mockServer.address().port;
const tmpStorage = mkdtempSync(join(tmpdir(), 'hb-trinnov-test-'));

try {
  const lifecycleEvents = {};
  const publishedAccessories = [];
  const fakeCharacteristic = () => ({
    onGet() { return this; },
    onSet() { return this; },
  });
  const fakeService = function (displayName, subtype) {
    this.displayName = displayName;
    this.subtype = subtype;
    this.setPrimaryService = () => this;
    this.setCharacteristic = () => this;
    this.updateCharacteristic = () => this;
    this.getCharacteristic = () => fakeCharacteristic();
    this.addOptionalCharacteristic = () => this;
    this.testCharacteristic = () => true;
    this.addLinkedService = () => this;
    this.removeLinkedService = () => this;
  };
  const mockApi = {
    hap: {
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        Television: fakeService,
        TelevisionSpeaker: 'TelevisionSpeaker',
        InputSource: fakeService,
        Fan: fakeService,
        Lightbulb: fakeService,
        Switch: fakeService,
      },
      Characteristic: {
        Name: 'Name',
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        FirmwareRevision: 'FirmwareRevision',
        ConfiguredName: 'ConfiguredName',
        SleepDiscoveryMode: { ALWAYS_DISCOVERABLE: 1 },
        Active: { ACTIVE: 1, INACTIVE: 0 },
        ActiveIdentifier: 'ActiveIdentifier',
        RemoteKey: 'RemoteKey',
        Identifier: 'Identifier',
        IsConfigured: { CONFIGURED: 1 },
        InputSourceType: { HDMI: 3, AIRPLAY: 8, OTHER: 0 },
        CurrentVisibilityState: { SHOWN: 0 },
        On: 'On',
        RotationSpeed: 'RotationSpeed',
        Brightness: 'Brightness',
      },
      Categories: { AUDIO_RECEIVER: 34, TELEVISION: 31 },
      uuid: { generate: (s) => `uuid-${s}` },
    },
    user: {
      storagePath: () => tmpStorage,
    },
    on: (evt, cb) => {
      lifecycleEvents[evt] = cb;
    },
    unregisterPlatformAccessories: () => {},
    platformAccessory: function (name, uuid, category) {
      this.displayName = name;
      this.UUID = uuid;
      this.category = category;
      this.services = new Map();
      const infoSvc = new fakeService(name, 'info');
      this.getService = (type) => (type === 'AccessoryInformation' ? infoSvc : null);
      this.getServiceById = (_type, subtype) => this.services.get(subtype) || null;
      this.addService = (svc, ...args) => {
        const instance = typeof svc === 'function' ? new svc(...args) : svc;
        if (instance && instance.subtype) {
          this.services.set(instance.subtype, instance);
        }
        return instance;
      };
      this.removeService = () => {};
    },
    publishExternalAccessories: (_plugin, accs) => {
      publishedAccessories.push(...accs);
    },
  };

  new TrinnovAltitudePlatform(
    mockLogger,
    {
      platform: `${PLUGIN_NAME}.${PLATFORM_NAME}`,
      name: 'Trinnov Altitude',
      devices: [
        {
          name: 'Theater Altitude32',
          host: '127.0.0.1',
          port: mockPort,
          inputs: [{ id: 0, name: 'Apple TV 4K', type: 'HDMI' }],
        },
      ],
    },
    mockApi,
  );

  lifecycleEvents.didFinishLaunching();
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.strictEqual(publishedAccessories.length, 1, 'Should publish 1 external Receiver accessory');
  assert.ok(receivedCommands.includes('id Homebridge'), 'Should send id handshake on connect');

  const discoveryFile = join(tmpStorage, TRINNOV_DISCOVERY_FILENAME);
  assert.ok(existsSync(discoveryFile), 'Should write homebridge-trinnov-discovery.json to storagePath');
  const discoveryJson = JSON.parse(readFileSync(discoveryFile, 'utf8'));
  assert.strictEqual(discoveryJson.plugin, PLUGIN_NAME);
  assert.strictEqual(discoveryJson.processors.length, 1);
  assert.strictEqual(discoveryJson.processors[0].host, '127.0.0.1');
  assert.strictEqual(discoveryJson.processors[0].port, mockPort);
  assert.strictEqual(discoveryJson.processors[0].powered, true);
  assert.strictEqual(discoveryJson.processors[0].activeSource, 'Apple TV 4K');

  lifecycleEvents.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(receivedCommands.includes('bye'), 'Should send graceful bye command on Homebridge shutdown');
} finally {
  mockServer.close();
  rmSync(tmpStorage, { recursive: true, force: true });
}

console.log('✅ All tests passed successfully!');
