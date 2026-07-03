import test from 'node:test';
import assert from 'node:assert/strict';

import { initiateSTKPush, querySTKStatus } from '../mpesaService.js';

test('service module exports STK helpers', () => {
  assert.equal(typeof initiateSTKPush, 'function');
  assert.equal(typeof querySTKStatus, 'function');
});
