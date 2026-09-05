import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { contentHash } from '../task-format.js';

test('contentHash is short, stable, and indifferent to line endings and trailing whitespace', () => {
  const a = contentHash('# Goal\n::ship::\n\n# Log\n- next: test');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(contentHash('# Goal\r\n::ship::\r\n\r\n# Log\r\n- next: test  \r\n'), a);
  assert.notEqual(contentHash('# Goal\n::ship::\n\n# Log\n- next: tests'), a);
  assert.equal(contentHash(''), contentHash(undefined));
});
