import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, validateOptions, checkpoints, report, CHECKPOINT_MINUTES } from '../scripts/persistence-probe.mjs';

const udid = '00008030-0000000000000001';

test('probe argument parsing rejects dangling flags and stray values', () => {
  assert.deepEqual(parseArgs(['dvt-set', '--udid', udid, '--lat', '1', '--lon', '2']),
    { command: 'dvt-set', options: { udid, lat: '1', lon: '2' } });
  assert.throws(() => parseArgs(['dvt-set', '--udid']), /Missing value/);
  assert.throws(() => parseArgs(['dvt-set', 'oops']), /Unexpected argument/);
});

test('every mutating probe command needs an explicit UDID and valid values', () => {
  for (const command of ['facts', 'dvt-set', 'restore', 'legacy-set', 'legacy-clear', 'unmount-ddi']) {
    assert.throws(() => validateOptions(command, { lat: '1', lon: '2' }), /--udid is required/);
  }
  assert.throws(() => validateOptions('dvt-set', { udid, lat: '91', lon: '0' }), /lat/);
  assert.throws(() => validateOptions('dvt-set', { udid, lat: '1', lon: 'x' }), /lat/);
  assert.throws(() => validateOptions('dvt-set', { udid, lat: '1', lon: '2', end: 'clear' }), /--end/);
  assert.throws(() => validateOptions('dvt-set', { udid, lat: '1', lon: '2', hold: '-1' }), /--hold/);
  assert.ok(validateOptions('dvt-set', { udid, lat: '0', lon: '0', hold: '0', end: 'unplug' }));
  assert.throws(() => validateOptions('note', { check: '1m', maps: 'maybe' }), /--maps/);
  assert.ok(validateOptions('note', { check: '1m', maps: 'spoofed', locked: 'yes' }));
});

test('check schedule is 1, 5 and 30 minutes after the last command', () => {
  assert.deepEqual(CHECKPOINT_MINUTES, [1, 5, 30]);
  assert.deepEqual(checkpoints('2026-11-03T12:00:00.000Z'), [
    { label: '1m', at: '2026-11-03T12:01:00.000Z' },
    { label: '5m', at: '2026-11-03T12:05:00.000Z' },
    { label: '30m', at: '2026-11-03T12:30:00.000Z' },
  ]);
});

test('report escapes table separators so pasted results stay intact', () => {
  const lines = report([{ ts: 't', step: 'observation', text: 'a|b\nc' }]).split('\n');
  assert.match(lines[0], /^\| Time \(UTC\) \| Step \| Details \|/);
  assert.equal(lines.length, 3, 'one table row per log entry');
  assert.ok(lines[2].includes('a\\|b'), lines[2]);
});
