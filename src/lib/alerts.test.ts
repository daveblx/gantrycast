import * as assert from 'node:assert';
import { test } from 'node:test';
import {
  ALERT_THRESHOLDS_KEY,
  DEFAULT_THRESHOLDS,
  alertLabel,
  alertTone,
  cloneThresholds,
  evaluateHost,
  normaliseThresholds,
  readThresholds,
  summariseBreaches,
  thresholdsFor,
  writeThresholds,
} from './alerts';
import type { ThresholdMap, ThresholdStorage, Thresholds } from './alerts';

/** In-memory stand-in for window.localStorage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const storage: ThresholdStorage = {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
  return { data, storage };
}

const custom: Thresholds = {
  cpu: { warn: 50, critical: 70 },
  ram: { warn: 60, critical: 80 },
  disk: { warn: 85, critical: 95 },
};

test('DEFAULT_THRESHOLDS', async (t) => {
  await t.test('should keep warn below critical for every metric', () => {
    for (const metric of ['cpu', 'ram', 'disk'] as const) {
      assert.ok(DEFAULT_THRESHOLDS[metric].warn < DEFAULT_THRESHOLDS[metric].critical);
    }
  });

  await t.test('should use a single namespaced storage key', () => {
    assert.strictEqual(ALERT_THRESHOLDS_KEY, 'gantrycast:alert-thresholds');
  });
});

test('normaliseThresholds', async (t) => {
  await t.test('should accept a complete config unchanged', () => {
    assert.deepStrictEqual(normaliseThresholds(custom), custom);
  });

  await t.test('should fall back to defaults for a non-object', () => {
    for (const input of [null, undefined, 'nope', 42, true]) {
      assert.deepStrictEqual(normaliseThresholds(input), DEFAULT_THRESHOLDS);
    }
  });

  await t.test('should fall back to defaults for an array', () => {
    assert.deepStrictEqual(normaliseThresholds([1, 2, 3]), DEFAULT_THRESHOLDS);
  });

  await t.test('should fill missing metrics from the defaults', () => {
    const result = normaliseThresholds({ cpu: { warn: 10, critical: 20 } });
    assert.deepStrictEqual(result.cpu, { warn: 10, critical: 20 });
    assert.deepStrictEqual(result.ram, DEFAULT_THRESHOLDS.ram);
    assert.deepStrictEqual(result.disk, DEFAULT_THRESHOLDS.disk);
  });

  await t.test('should fill a missing level from the defaults', () => {
    const result = normaliseThresholds({ cpu: { warn: 10 } });
    assert.deepStrictEqual(result.cpu, { warn: 10, critical: DEFAULT_THRESHOLDS.cpu.critical });
  });

  await t.test('should clamp levels into 1..100', () => {
    const result = normaliseThresholds({
      cpu: { warn: -20, critical: 400 },
      ram: { warn: 0, critical: 0 },
    });
    assert.deepStrictEqual(result.cpu, { warn: 1, critical: 100 });
    assert.deepStrictEqual(result.ram, { warn: 1, critical: 1 });
  });

  await t.test('should swap an inverted pair instead of dropping it', () => {
    const result = normaliseThresholds({ cpu: { warn: 95, critical: 60 } });
    assert.deepStrictEqual(result.cpu, { warn: 60, critical: 95 });
  });

  await t.test('should parse numeric strings', () => {
    const result = normaliseThresholds({ disk: { warn: '70', critical: '88.5' } });
    assert.deepStrictEqual(result.disk, { warn: 70, critical: 88.5 });
  });

  await t.test('should round to one decimal place', () => {
    const result = normaliseThresholds({ ram: { warn: 70.04, critical: 90.06 } });
    assert.deepStrictEqual(result.ram, { warn: 70, critical: 90.1 });
  });

  await t.test('should ignore non-numeric levels', () => {
    const result = normaliseThresholds({ ram: { warn: 'abc', critical: null } });
    assert.deepStrictEqual(result.ram, DEFAULT_THRESHOLDS.ram);
  });
});

test('cloneThresholds', async (t) => {
  await t.test('should not share nested objects with the source', () => {
    const copy = cloneThresholds(custom);
    copy.cpu.warn = 5;
    assert.strictEqual(custom.cpu.warn, 50);
  });
});

test('readThresholds / writeThresholds', async (t) => {
  await t.test('should round-trip a map through storage', () => {
    const { storage } = fakeStorage();
    const map: ThresholdMap = { 'host-1': custom };
    writeThresholds(map, storage);
    assert.deepStrictEqual(readThresholds(storage), map);
  });

  await t.test('should write under the single documented key', () => {
    const { data, storage } = fakeStorage();
    writeThresholds({ 'host-1': custom }, storage);
    assert.deepStrictEqual(Object.keys(data), [ALERT_THRESHOLDS_KEY]);
  });

  await t.test('should return an empty map when nothing is stored', () => {
    const { storage } = fakeStorage();
    assert.deepStrictEqual(readThresholds(storage), {});
  });

  await t.test('should return an empty map for malformed JSON', () => {
    const { storage } = fakeStorage({ [ALERT_THRESHOLDS_KEY]: '{not json' });
    assert.deepStrictEqual(readThresholds(storage), {});
  });

  await t.test('should return an empty map when the payload is not an object', () => {
    for (const payload of ['null', '42', '"text"', '[1,2]']) {
      const { storage } = fakeStorage({ [ALERT_THRESHOLDS_KEY]: payload });
      assert.deepStrictEqual(readThresholds(storage), {});
    }
  });

  await t.test('should normalise stored garbage per host', () => {
    const { storage } = fakeStorage({
      [ALERT_THRESHOLDS_KEY]: JSON.stringify({ 'host-1': { cpu: { warn: 500 } }, 'host-2': null }),
    });
    const map = readThresholds(storage);
    // 500 clamps to 100, which is above the default critical of 90, so the
    // pair is swapped rather than left unreachable.
    assert.deepStrictEqual(map['host-1'].cpu, { warn: 90, critical: 100 });
    assert.deepStrictEqual(map['host-2'], DEFAULT_THRESHOLDS);
  });

  await t.test('should skip entries with an empty host id', () => {
    const { storage } = fakeStorage({
      [ALERT_THRESHOLDS_KEY]: JSON.stringify({ '': custom, 'host-1': custom }),
    });
    assert.deepStrictEqual(Object.keys(readThresholds(storage)), ['host-1']);
  });

  await t.test('should degrade to an empty map without storage', () => {
    assert.deepStrictEqual(readThresholds(undefined), {});
    assert.doesNotThrow(() => writeThresholds({ 'host-1': custom }, undefined));
  });

  await t.test('should survive a storage that throws', () => {
    const throwing: ThresholdStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    assert.deepStrictEqual(readThresholds(throwing), {});
    assert.doesNotThrow(() => writeThresholds({ 'host-1': custom }, throwing));
  });
});

test('thresholdsFor', async (t) => {
  await t.test('should return the defaults for an unknown host', () => {
    assert.deepStrictEqual(thresholdsFor({}, 'missing'), DEFAULT_THRESHOLDS);
  });

  await t.test('should return the stored thresholds for a known host', () => {
    assert.deepStrictEqual(thresholdsFor({ 'host-1': custom }, 'host-1'), custom);
  });

  await t.test('should return a copy so callers cannot mutate the store', () => {
    const map: ThresholdMap = { 'host-1': custom };
    const result = thresholdsFor(map, 'host-1');
    result.ram.warn = 1;
    assert.strictEqual(map['host-1'].ram.warn, 60);
    assert.strictEqual(DEFAULT_THRESHOLDS.cpu.warn, 75);
  });
});

test('evaluateHost', async (t) => {
  await t.test('should report no data when every metric is missing', () => {
    const result = evaluateHost({}, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.hasData, false);
    assert.strictEqual(result.level, 'ok');
    assert.deepStrictEqual(result.breaches, []);
  });

  await t.test('should stay ok below the warn level', () => {
    const result = evaluateHost({ cpu: 10, ram: 20, disk: 30 }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.hasData, true);
    assert.strictEqual(result.level, 'ok');
    assert.deepStrictEqual(result.breaches, []);
    assert.strictEqual(result.summary, 'All metrics within thresholds.');
  });

  await t.test('should warn exactly at the warn level', () => {
    const result = evaluateHost({ cpu: DEFAULT_THRESHOLDS.cpu.warn }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.level, 'warn');
    assert.strictEqual(result.breaches.length, 1);
    assert.strictEqual(result.breaches[0].metric, 'cpu');
    assert.strictEqual(result.breaches[0].threshold, DEFAULT_THRESHOLDS.cpu.warn);
  });

  await t.test('should go critical exactly at the critical level', () => {
    const result = evaluateHost({ ram: DEFAULT_THRESHOLDS.ram.critical }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.level, 'critical');
    assert.strictEqual(result.breaches[0].level, 'critical');
  });

  await t.test('should let the worst metric win', () => {
    const result = evaluateHost({ cpu: 80, ram: 95, disk: 10 }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.level, 'critical');
    assert.deepStrictEqual(
      result.breaches.map((breach) => breach.metric),
      ['cpu', 'ram'],
    );
  });

  await t.test('should ignore metrics that were not reported', () => {
    const result = evaluateHost({ disk: 91 }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.level, 'critical');
    assert.strictEqual(result.breaches.length, 1);
    assert.strictEqual(result.breaches[0].metric, 'disk');
  });

  await t.test('should ignore non-finite values', () => {
    const result = evaluateHost({ cpu: Number.NaN, ram: Number.POSITIVE_INFINITY }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.hasData, false);
    assert.strictEqual(result.level, 'ok');
  });

  await t.test('should honour custom thresholds', () => {
    const result = evaluateHost({ cpu: 55, ram: 55, disk: 55 }, custom);
    assert.strictEqual(result.level, 'warn');
    assert.deepStrictEqual(
      result.breaches.map((breach) => breach.metric),
      ['cpu'],
    );
  });

  await t.test('should describe each breach in the summary', () => {
    const result = evaluateHost({ cpu: 92.34, disk: 81 }, DEFAULT_THRESHOLDS);
    assert.strictEqual(result.summary, 'CPU 92.3% ≥ 90% · Disk 81.0% ≥ 80%');
  });
});

test('summariseBreaches', async (t) => {
  await t.test('should describe an empty breach list', () => {
    assert.strictEqual(summariseBreaches([]), 'All metrics within thresholds.');
  });
});

test('alertTone / alertLabel', async (t) => {
  await t.test('should map levels onto the existing badge tones', () => {
    assert.strictEqual(alertTone('ok'), 'ok');
    assert.strictEqual(alertTone('warn'), 'warn');
    assert.strictEqual(alertTone('critical'), 'err');
  });

  await t.test('should map levels onto short labels', () => {
    assert.strictEqual(alertLabel('ok'), 'OK');
    assert.strictEqual(alertLabel('warn'), 'Warn');
    assert.strictEqual(alertLabel('critical'), 'Critical');
  });
});
