import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('desktop', () => {
  it('expose le nom du paquet', () => {
    expect(PACKAGE_NAME).toBe('desktop');
  });
});
