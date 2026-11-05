import fc from 'fast-check';
import { HIDDEN_MARKER } from '../common.js';
import { PROFILE_IDS } from '../ids.js';
import { TASK_KINDS, type PlanTask } from '../plan.js';

/** Générateurs fast-check partagés par les tests de propriétés (hors build). */

const isClean = (s: string) =>
  s.trim().length > 0 && s === s.trim() && !s.includes('\r') && !s.includes(HIDDEN_MARKER);

/** Texte libre propre, y compris caractères spéciaux, « < », « > », « --> », emoji. */
export const cleanTextArb = fc
  .string({ minLength: 1, maxLength: 40, unit: 'binary' })
  .filter(isClean);
export const cleanLineArb = cleanTextArb.filter((s) => !s.includes('\n'));

export const taskIdArb = fc
  .integer({ min: 0, max: 999 })
  .map((n) => `T${String(n).padStart(2, '0')}`);

export const taskArb: fc.Arbitrary<PlanTask> = fc.record(
  {
    id: taskIdArb,
    title: cleanLineArb,
    description: cleanTextArb,
    kind: fc.constantFrom(...TASK_KINDS),
    profile: fc.constantFrom(...PROFILE_IDS),
    complexity: fc.constantFrom('S' as const, 'M' as const, 'L' as const),
    acceptanceCriteria: fc.array(cleanLineArb, { minLength: 1, maxLength: 4 }),
    requiredTests: fc.record(
      {
        unit: fc.array(cleanLineArb, { maxLength: 3 }),
        integration: fc.array(cleanLineArb, { maxLength: 3 }),
        contract: fc.array(cleanLineArb, { maxLength: 3 }),
        e2e: fc.array(cleanLineArb, { maxLength: 3 }),
        regression: fc.array(cleanLineArb, { maxLength: 3 }),
      },
      { requiredKeys: [] },
    ),
    codeZones: fc.array(cleanLineArb, { maxLength: 3 }),
    exclusiveResources: fc.array(cleanLineArb, { maxLength: 3 }),
    dependencies: fc.array(taskIdArb, { maxLength: 4 }),
    epic: cleanLineArb,
    milestone: cleanLineArb,
  },
  {
    requiredKeys: [
      'id',
      'title',
      'description',
      'kind',
      'profile',
      'complexity',
      'acceptanceCriteria',
      'requiredTests',
      'codeZones',
      'exclusiveResources',
      'dependencies',
    ],
  },
);
