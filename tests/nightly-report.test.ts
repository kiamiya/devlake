import { describe, expect, it } from 'vitest';
import { renderNightlyReport, type VitestJsonReport } from '../scripts/nightly-report.js';

const report = (
  tests: { fullName: string; status: string; failureMessages?: string[] }[],
): VitestJsonReport => ({
  testResults: [
    { name: 'D:/devlake/packages/planner/src/regression.live.test.ts', assertionResults: tests },
  ],
});

describe('rapport du @live nocturne', () => {
  it('tout passe : succès, compteurs', () => {
    const result = renderNightlyReport(
      report([
        { fullName: 'planificateur rendez-vous', status: 'passed' },
        { fullName: 'agent Unity', status: 'skipped' },
      ]),
      '2026-11-06',
    );
    expect(result.ok).toBe(true);
    expect(result.markdown).toContain('## ✅ Tests @live nocturnes — 2026-11-06');
    expect(result.markdown).toContain('1 réussi(s), 0 en échec, 1 sauté(s).');
    expect(result.markdown).toContain('Sautés : agent Unity.');
  });

  it('un échec : tableau avec le fichier et la première ligne de l’erreur', () => {
    const result = renderNightlyReport(
      report([
        {
          fullName: 'planificateur inventaire',
          status: 'failed',
          failureMessages: ['\nAssertionError: expected 1 | 2\n    at x'],
        },
      ]),
      '2026-11-06',
    );
    expect(result.ok).toBe(false);
    expect(result.markdown).toContain('❌');
    expect(result.markdown).toContain(
      '| planificateur inventaire | `packages/planner/src/regression.live.test.ts` | AssertionError: expected 1 \\| 2 |',
    );
  });

  it('tout sauté ou rapport absent : échec explicite (configuration ou interruption)', () => {
    const skipped = renderNightlyReport(report([{ fullName: 'a', status: 'skipped' }]), 'd');
    expect(skipped.ok).toBe(false);
    expect(skipped.markdown).toContain('**Aucun test lancé**');
    const missing = renderNightlyReport(null, 'd');
    expect(missing).toMatchObject({ ok: false });
    expect(missing.markdown).toContain('**Rapport absent**');
  });
});
