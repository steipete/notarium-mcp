import { z } from 'zod';

const ISO8601DateTimeStringSchema = z
  .string()
  .datetime({ message: 'Invalid ISO8601 datetime string' });

const testStrings = [
  '2023-10-26T10:00:00Z',
  '2023-10-26T10:00:00.123Z',
  '2023-10-26T10:00:00+05:30',
  '2023-10-26T10:00:00-00:00',
  '2023-10-26T10:00:00-05:00',
  '2023-10-26T10:00:00+00:00',
];

testStrings.forEach((str) => {
  try {
    ISO8601DateTimeStringSchema.parse(str);
    console.log(`✓ VALID: ${str}`);
  } catch (error) {
    console.log(`✗ INVALID: ${str}`);
    console.log(`  Error: ${error.errors?.[0]?.message || error.message}`);
  }
});
