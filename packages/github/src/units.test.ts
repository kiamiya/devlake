import { describe, expect, it } from 'vitest';
import { readBlockedBy, writeBlockedBy } from './dependencies-block.js';
import { errorFromStatus, isGitHubError } from './errors.js';
import { systemClock } from './http.js';

describe('bloc caché des dépendances', () => {
  it('écrit, relit, remplace et retire le bloc', () => {
    const body = writeBlockedBy('Corps', [5, 3, 5]);
    expect(body).toBe('Corps\n\n<!-- agentlake:blocked-by 3,5 -->\n');
    expect(readBlockedBy(body)).toEqual([3, 5]);
    expect(writeBlockedBy(body, [8])).toBe('Corps\n\n<!-- agentlake:blocked-by 8 -->\n');
    expect(writeBlockedBy(body, [])).toBe('Corps');
    expect(readBlockedBy('Corps')).toEqual([]);
    expect(readBlockedBy('<!-- agentlake:blocked-by  -->')).toEqual([]);
  });
});

describe('erreurs', () => {
  it('type les statuts inattendus', () => {
    expect(errorFromStatus(418, 'théière').kind).toBe('validation');
    expect(isGitHubError(new Error('x'))).toBe(false);
    expect(isGitHubError(errorFromStatus(500, 'x'), 'server')).toBe(true);
  });
});

describe('horloge système', () => {
  it('donne l’heure et attend', async () => {
    const before = systemClock.now();
    await systemClock.sleep(1);
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
  });
});
