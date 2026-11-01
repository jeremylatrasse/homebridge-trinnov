import assert from 'node:assert';
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

// Test 6: First dropped heartbeat when powered off suppresses further logging until powered on again
const logs = [];
const countingLogger = {
  info: (msg) => logs.push(msg),
  warn: (msg) => logs.push(msg),
  error: (msg) => logs.push(msg),
  debug: (msg) => logs.push(msg),
};
const quietClient = new TrinnovClient({ host: '172.16.1.66', port: 44100 }, countingLogger);
quietClient['handleIncomingData']('VOLUME -30.0\r\n');
assert.strictEqual(quietClient.state.power, true);
assert.strictEqual(quietClient['standbyQuietMode'], false);

logs.length = 0;
quietClient['handleFirstDroppedHeartbeat']();
assert.strictEqual(quietClient['standbyQuietMode'], true, 'Should enter standbyQuietMode after first dropped heartbeat');
assert.strictEqual(logs.length, 1, 'Should log the first dropped heartbeat exactly once');

// Subsequent dropped heartbeats or disconnected sends while powered off should produce zero logs
quietClient['handleFirstDroppedHeartbeat']();
quietClient.sendRaw('send_volume');
assert.strictEqual(logs.length, 1, 'No further logging should occur while powered off after first dropped heartbeat');

// Powering on / receiving response re-enables logging
quietClient['handleIncomingData']('VOLUME -30.0\r\n');
assert.strictEqual(quietClient['standbyQuietMode'], false, 'standbyQuietMode should clear when powered on again');
assert.ok(logs.length > 1, 'Logging should resume once unit is powered on again');

// Test 7: Start state logs heartbeats until unit starts, then stops logging them;
// Stop state updates power state, sends/logs heartbeats until unit stops, then suppresses logging
quietClient['isWakingUp'] = true;
quietClient['logHeartbeats'] = true;
quietClient['handleIncomingData']('VOLUME -28.0\r\n');
assert.strictEqual(quietClient['logHeartbeats'], false, 'Heartbeat logging should stop once unit starts responding');
assert.strictEqual(quietClient.state.power, true, 'Power state should be true once unit starts');

let powerChangedToFalse = false;
quietClient.once('powerChange', (p) => {
  if (p === false) {
    powerChangedToFalse = true;
  }
});
quietClient.powerOff();
assert.strictEqual(quietClient.state.power, false, 'Power state should immediately update to false when stop is sent');
assert.strictEqual(powerChangedToFalse, true, 'powerChange(false) should emit when stop is sent');
assert.strictEqual(quietClient['isStopping'], true, 'isStopping should be true while verifying unit has stopped');
assert.strictEqual(quietClient['logHeartbeats'], true, 'logHeartbeats should be true while verifying unit has stopped');

// Once the unit stops responding (first dropped heartbeat), all logging stops until state changes again
logs.length = 0;
quietClient['handleFirstDroppedHeartbeat']();
assert.strictEqual(quietClient['isStopping'], false, 'isStopping should clear once unit is confirmed stopped');
assert.strictEqual(quietClient['logHeartbeats'], false, 'logHeartbeats should be false once unit is stopped');
assert.strictEqual(quietClient['standbyQuietMode'], true, 'standbyQuietMode should be true once unit is stopped');
assert.strictEqual(logs.length, 1, 'Should log confirmation that unit stopped and suppress further logs');

quietClient.stop();
client.stop();

console.log('✅ All tests passed successfully!');
