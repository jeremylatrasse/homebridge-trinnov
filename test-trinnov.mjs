import assert from 'node:assert';
import { TrinnovClient } from './dist/trinnovClient.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

console.log('Testing TrinnovClient math & protocol logic...');

const client = new TrinnovClient(
  {
    host: '192.168.1.100',
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

// Simulate incoming TCP data
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

console.log('✅ All tests passed successfully!');
