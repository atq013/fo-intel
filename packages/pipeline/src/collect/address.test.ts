import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sameBuilding, postcodeOf } from './uk-director-address.js';

/**
 * The registered-office test compares buildings, not strings.
 *
 * An audit of all 276 postal routes found 132 where the service address was the
 * company's own premises filed a different way, walking through an exact-string
 * check. These are the shapes that mattered.
 */

test('address · the same building filed two ways is caught', () => {
  assert.equal(
    sameBuilding('DEVONSHIRE STREET|GROUND FLOOR|LONDON|W1G 7AJ', '41 DEVONSHIRE STREET|LONDON|W1G 7AJ'),
    true,
  );
  assert.equal(
    sameBuilding('UNIT 3|KINGS COURT|MANCHESTER|M2 4WU', 'KINGS COURT, 12 QUEEN ST|MANCHESTER|M2 4WU'),
    true,
  );
});

test('address · a different building in the same postcode is not a match', () => {
  // Same postcode, no shared distinctive street word.
  assert.equal(
    sameBuilding('12 ALBERT ROAD|LONDON|W1G 7AJ', '41 DEVONSHIRE STREET|LONDON|W1G 7AJ'),
    false,
  );
});

test('address · a different postcode is never a match', () => {
  assert.equal(
    sameBuilding('41 DEVONSHIRE STREET|LONDON|W1G 7AJ', '41 DEVONSHIRE STREET|LONDON|EC2A 4NE'),
    false,
  );
});

test('address · generic words alone cannot match two addresses', () => {
  // "Street", "House", "Floor" appear everywhere and must not carry a match.
  assert.equal(
    sameBuilding('THE HOUSE|HIGH STREET|LEEDS|LS1 4AP', 'GROUND FLOOR|LOW STREET|LEEDS|LS1 4AP'),
    false,
  );
});

test('address · an address with no postcode is never assumed to match', () => {
  assert.equal(sameBuilding('DEVONSHIRE STREET|LONDON', '41 DEVONSHIRE STREET|LONDON|W1G 7AJ'), false);
  assert.equal(postcodeOf('DEVONSHIRE STREET|LONDON'), '');
});
