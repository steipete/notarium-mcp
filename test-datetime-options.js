import { z } from 'zod';

// Test different datetime options
const schemas = {
  default: z.string().datetime(),
  withOffset: z.string().datetime({ offset: true }),
  withPrecision: z.string().datetime({ precision: 3 }),
  withBoth: z.string().datetime({ offset: true, precision: 3 }),
};

const testStrings = [
  '2023-10-26T10:00:00Z',
  '2023-10-26T10:00:00.123Z',
  '2023-10-26T10:00:00+05:30',
  '2023-10-26T10:00:00-00:00',
  '2023-10-26T10:00:00-05:00',
  '2023-10-26T10:00:00+00:00',
];

Object.entries(schemas).forEach(([name, schema]) => {
  console.log(`\n=== Testing with ${name} schema ===`);
  testStrings.forEach((str) => {
    try {
      schema.parse(str);
      console.log(`✓ VALID: ${str}`);
    } catch (error) {
      console.log(`✗ INVALID: ${str}`);
    }
  });
});
