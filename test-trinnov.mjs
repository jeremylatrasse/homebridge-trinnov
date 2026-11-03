import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TrinnovClient } from './dist/trinnovClient.js';
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

// Test 6: Heartbeat state machine (starts only after ON command; single log per transition)
const infoMessages = [];
const warnMessages = [];
const standbyClient = new TrinnovClient(
  {
    host: '172.16.1.66',
    port: 44100,
    heartbeatInterval: 1,
  },
  {
    info: (msg) => infoMessages.push(msg),
    warn: (msg) => warnMessages.push(msg),
    error: () => {},
    debug: () => {},
  },
);
standbyClient.start();
assert.strictEqual(standbyClient['heartbeatActive'], false, 'Heartbeat must not start before ON command');
assert.strictEqual(standbyClient.isConnected(), false, 'Standby client must not report connected while off');
assert.strictEqual(infoMessages.length, 0);
assert.strictEqual(warnMessages.length, 0);

// Simulate ON command starting heartbeat probing and receiving multiple heartbeat replies
standbyClient['heartbeatActive'] = true;
standbyClient['expectedPowerState'] = 'on';
standbyClient['heartbeatLogState'] = 'awaiting-success';
standbyClient['handleIncomingData']('VOLUME -35.0\nMUTE 0\nVOLUME -34.0\n');
assert.strictEqual(infoMessages.length, 1, 'Should write only one log entry for successful heartbeat in ON state');

// Simulate failed heartbeat in ON state -> logs once, then stays quiet
standbyClient['recordHeartbeatFailure']();
standbyClient['recordHeartbeatFailure']();
standbyClient['recordHeartbeatFailure']();
assert.strictEqual(warnMessages.length, 1, 'Should write only one log entry for failed heartbeat in ON state');

// Simulate OFF command -> in-flight data during shutdown is ignored, then standby confirmed
standbyClient['expectedPowerState'] = 'off';
standbyClient['heartbeatLogState'] = 'awaiting-expected-failure';
standbyClient.state.power = false;

// In-flight data arriving while awaiting-expected-failure must not resurrect power or log unexpected state change
standbyClient['handleIncomingData']('VOLUME -34.0\n');
assert.strictEqual(infoMessages.length, 1, 'In-flight data during shutdown must not trigger unexpected state change');
assert.strictEqual(standbyClient.state.power, false, 'Power must remain false during shutdown');

standbyClient['recordHeartbeatFailure']();
standbyClient['recordHeartbeatFailure']();
assert.strictEqual(infoMessages.length, 2, 'Should write only one log entry for failed heartbeat in expected OFF state');

// Simulate unexpected state change while in OFF state -> logs once
standbyClient['handleIncomingData']('VOLUME -30.0\nVOLUME -29.0\n');
assert.strictEqual(infoMessages.length, 3, 'Should write only one log entry when unexpected state change is discovered');
assert.strictEqual(standbyClient.state.power, true, 'Power should be restored when unexpected data arrives in standby');
standbyClient.stop();

// Test 8: powerOff() method behavior and command dispatch
const poClient = new TrinnovClient(
  {
    host: '127.0.0.1',
    port: 44100,
  },
  mockLogger,
);
poClient.state.power = true;
let powerChangedTo = null;
poClient.on('powerChange', (p) => {
  powerChangedTo = p;
});

let sendPowerOffCommandCalled = false;
poClient.sendPowerOffCommand = async () => {
  sendPowerOffCommandCalled = true;
};

await poClient.powerOff();
assert.strictEqual(poClient.state.power, false, 'powerOff must immediately set power to false');
assert.strictEqual(powerChangedTo, false, 'powerOff must emit powerChange false');
assert.strictEqual(poClient['expectedPowerState'], 'off', 'powerOff must set expectedPowerState to off');
assert.strictEqual(poClient['heartbeatLogState'], 'awaiting-expected-failure', 'powerOff must set heartbeatLogState to awaiting-expected-failure');
assert.strictEqual(sendPowerOffCommandCalled, true, 'powerOff must invoke sendPowerOffCommand');
poClient.stop();

// Test 7: config.schema.json validation checks for Homebridge UI compatibility
const schemaJson = JSON.parse(readFileSync('./config.schema.json', 'utf8'));
const deviceSchema = schemaJson.schema.properties.devices.items;
assert.strictEqual(deviceSchema.properties.host.format, undefined, 'host must not have format:hostname which rejects IPv4 addresses in Homebridge UI');
assert.strictEqual(deviceSchema.properties.inputs.items.required, undefined, 'inputs.items must not mark id/name required (breaks id: 0 and unnamed profiles in Homebridge UI)');
assert.strictEqual(deviceSchema.properties.presets.items.required, undefined, 'presets.items must not mark id/name required (breaks unnamed presets in Homebridge UI)');

console.log('✅ All tests passed successfully!');
