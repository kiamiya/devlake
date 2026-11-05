# T06 — Ingestion des documents

**Jalon :** J1  
**Dépend de :** T02, T03  
**Branche :** `task/T06-ingestion`

## Objectif

Transformer brief, GDD et annexes en Markdown normalisé et les verser dans le dépôt du projet.

## Contexte

Lire `CLAUDE.md` et les sections concernées de `docs/cadrage.md` avant de commencer. Rappel : aucun agent ne tourne sur le poste ; GitHub est la source de vérité.

## Périmètre

- `packages/desktop/src/main/services/ingestion/`

## Spécifications

1. Formats : docx (mammoth → HTML → turndown), html (DOMPurify puis turndown), md, txt, pdf (pdf-parse ; texte vide → signalé « OCR nécessaire »).
2. Images autonomes et images embarquées extraites, référencées dans le Markdown.
3. Versement en un seul commit dans `.agentlake/context/` : `brief.md` ou `gdd.md`, annexes, `assets/` (Git LFS), et un index `context.json` (fichier, rôle, hash, date).
4. Déduplication par hash SHA-256 ; taille max configurable (50 Mo par défaut).
5. Interface `DocumentParser` par format, enregistrée dans un registre.

## Critères d'acceptation

- [ ] Un docx avec titres, listes, tableaux et images donne un Markdown fidèle et des liens d'images valides dans le dépôt.
- [ ] Réimporter le même fichier ne crée pas de commit.

## Tests exigés

- Unitaires par parseur sur fixtures réelles ; sécurité (scripts HTML neutralisés).
- Régression : snapshots Markdown des fixtures.
- Intégration : versement avec `FakeGitHub`.

## Définition de terminé

La définition de terminé commune de `CLAUDE.md` s'applique en plus des critères ci-dessus.

## Hors périmètre

- OCR.
