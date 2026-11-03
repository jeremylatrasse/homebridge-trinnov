import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TrinnovClient, validateTrinnovHost } from './dist/trinnovClient.js';
import { sanitizeHomeKitName, isExplicitlyNamed } from './dist/platformAccessory.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

console.log('Testing TrinnovClient math, protocol & HomeKit sanitization logic...');

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

// Test 6: config.schema.json validation checks for Homebridge UI compatibility
const schemaJson = JSON.parse(readFileSync('./config.schema.json', 'utf8'));
const deviceSchema = schemaJson.schema.properties.devices.items;
assert.strictEqual(deviceSchema.properties.host.format, undefined, 'host must not have format:hostname which rejects IPv4 addresses in Homebridge UI');
assert.strictEqual(deviceSchema.properties.inputs.items.required, undefined, 'inputs.items must not mark id/name required (breaks id: 0 and unnamed profiles in Homebridge UI)');
assert.strictEqual(deviceSchema.properties.presets.items.required, undefined, 'presets.items must not mark id/name required (breaks unnamed presets in Homebridge UI)');

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

console.log('✅ All tests passed successfully!');
