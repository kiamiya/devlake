import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPE_RULES,
  effectiveScope,
  filesOutsideScope,
  globToRegExp,
  matchesAny,
  toolAllowed,
} from './scope.js';

describe('périmètre d’une tâche', () => {
  it('motifs : **, *, ?, dossier, fichier exact', () => {
    expect(matchesAny('src/api/routes/a.ts', ['src/api/**'])).toBe(true);
    expect(matchesAny('src/apis/a.ts', ['src/api/**'])).toBe(false);
    expect(matchesAny('Assets/Scripts/Joueur/Saut.cs', ['Assets/Scripts/Joueur/*.cs'])).toBe(true);
    expect(matchesAny('Assets/Scripts/Joueur/IA/Saut.cs', ['Assets/Scripts/Joueur/*.cs'])).toBe(
      false,
    );
    expect(matchesAny('docs/guide/a.md', ['**/*.md'])).toBe(true);
    expect(matchesAny('README.md', ['**/*.md'])).toBe(true);
    // Sans joker : le fichier ou tout ce qui est dessous.
    expect(matchesAny('supabase/migrations/1.sql', ['supabase'])).toBe(true);
    expect(matchesAny('supabase/migrations/1.sql', ['supabase/'])).toBe(true);
    expect(matchesAny('src\\x.ts', ['./src/**'])).toBe(true);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
  });

  it('outils : nom exact ou serveur entier', () => {
    expect(toolAllowed('unity__manage_scene', ['unity__*'])).toBe(true);
    expect(toolAllowed('unity__manage_scene', ['unity__manage_scene'])).toBe(true);
    expect(toolAllowed('aura__run', ['unity__*'])).toBe(false);
  });

  it('périmètre effectif : tâche + règles du profil ; rien de défini → null', () => {
    expect(
      effectiveScope(
        { profile: 'blender', scope: { paths: ['Art/caisse/**'], tools: ['blender__*'] } },
        DEFAULT_SCOPE_RULES,
      ),
    ).toEqual({ paths: ['Art/caisse/**', 'Art/**', 'Assets/Art/**'], tools: ['blender__*'] });
    expect(effectiveScope({ profile: 'docs' }, DEFAULT_SCOPE_RULES)).toEqual({
      paths: ['docs/**', '**/*.md'],
      tools: null,
    });
    expect(effectiveScope({ profile: 'backend' }, DEFAULT_SCOPE_RULES)).toBeNull();
    expect(effectiveScope({ profile: 'backend', scope: { paths: ['api/**'] } }, undefined)).toEqual(
      {
        paths: ['api/**'],
        tools: null,
      },
    );
  });

  it('fichiers liés permis : tests des fichiers de la zone, .meta, lockfiles, décisions', () => {
    const scope = { paths: ['src/booking/**', 'Assets/Scripts/Joueur.cs'], tools: null };
    expect(
      filesOutsideScope(
        [
          'src/booking/slots.ts',
          'tests/booking/slots.test.ts',
          'test/autre.test.ts',
          'Assets/Scripts/Joueur.cs',
          'Assets/Scripts/Joueur.cs.meta',
          'Assets/Tests/JoueurTests.cs',
          'Assets/Scripts.meta',
          'Assets/Autre.cs.meta',
          '.agentlake/decisions.md',
          'docs/booking.md',
          'package-lock.json',
        ],
        scope,
      ),
    ).toEqual([
      'test/autre.test.ts',
      'Assets/Autre.cs.meta',
      'docs/booking.md',
      'package-lock.json',
    ]);
    // Lockfile permis quand le manifeste du même dossier est dans la zone.
    expect(
      filesOutsideScope(['package.json', 'package-lock.json'], {
        paths: ['package.json'],
        tools: null,
      }),
    ).toEqual([]);
  });
});
