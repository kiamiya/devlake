import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { eventAllowed } from './adapters.js';

/** Séquences d'événements de la bibliothèque de régression (tests/fixtures/regression/events). */
const DIR = fileURLToPath(
  new URL('../../../../tests/fixtures/regression/events/', import.meta.url),
);

const EventsFileSchema = z.object({
  description: z.string(),
  owner: z.string(),
  events: z
    .array(
      z.object({
        name: z.string(),
        event: z.string(),
        payload: z.unknown(),
        allowed: z.boolean(),
      }),
    )
    .min(1),
});

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

describe('bibliothèque de régression : événements du dispatcher', () => {
  it('au moins une séquence', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const sequence = EventsFileSchema.parse(JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')));
    it.each(sequence.events)(`${file} : $name`, ({ event, payload, allowed }) => {
      expect(eventAllowed(event, payload, sequence.owner).allowed).toBe(allowed);
    });
  }
});
