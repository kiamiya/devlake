import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AnswerSchema,
  QuestionSchema,
  parseAnswerComment,
  parseQuestionComment,
  renderAnswerComment,
  renderQuestionComment,
  type Answer,
  type Question,
} from './questions.js';
import { cleanLineArb, cleanTextArb } from './testing/arbitraries.js';

const questionIdArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/);

const questionArb: fc.Arbitrary<Question> = fc.record(
  {
    id: questionIdArb,
    blocking: fc.boolean(),
    text: cleanTextArb,
    context: cleanTextArb,
    options: fc.array(cleanLineArb, { maxLength: 5 }),
  },
  { requiredKeys: ['id', 'blocking', 'text', 'options'] },
);

const answerArb: fc.Arbitrary<Answer> = fc.record({
  id: questionIdArb,
  decision: fc.boolean(),
  text: cleanTextArb,
});

const sampleQuestion: Question = {
  id: 'Q-T04-1',
  blocking: true,
  text: 'Faut-il gérer la connexion par lien magique ?',
  context: 'Le brief ne mentionne que l’e-mail et le mot de passe.',
  options: ['Oui, dès cette tâche', 'Non, plus tard'],
};

describe('protocole de questions', () => {
  it('produit des questions et réponses valides pour les tests de propriétés', () => {
    fc.assert(fc.property(questionArb, (q) => QuestionSchema.safeParse(q).success));
    fc.assert(fc.property(answerArb, (a) => AnswerSchema.safeParse(a).success));
  });

  it('aller-retour question sans perte', () => {
    fc.assert(
      fc.property(questionArb, (question) => {
        expect(parseQuestionComment(renderQuestionComment(question))).toEqual({
          ok: true,
          value: question,
        });
      }),
      { numRuns: 300 },
    );
  });

  it('aller-retour réponse sans perte', () => {
    fc.assert(
      fc.property(answerArb, (answer) => {
        expect(parseAnswerComment(renderAnswerComment(answer))).toEqual({
          ok: true,
          value: answer,
        });
      }),
      { numRuns: 300 },
    );
  });

  it('relit une réponse écrite à la main sur GitHub (CRLF, sans decision)', () => {
    const body = '<!-- agentlake:answer id=Q-T04-1 -->\r\nNon, plus tard.\r\n';
    expect(parseAnswerComment(body)).toEqual({
      ok: true,
      value: { id: 'Q-T04-1', decision: true, text: 'Non, plus tard.' },
    });
  });

  it('accepte les attributs dans n’importe quel ordre', () => {
    const body = '<!-- agentlake:answer decision=false id=Q1 -->\nOui.';
    expect(parseAnswerComment(body)).toEqual({
      ok: true,
      value: { id: 'Q1', decision: false, text: 'Oui.' },
    });
  });

  it.each([
    ['en-tête absent', 'Bonjour', 'En-tête « <!-- agentlake:question … --> » absent.'],
    [
      'blocking invalide',
      '<!-- agentlake:question id=Q1 blocking=peut-etre -->\n<!-- agentlake:text -->\n**Q**\n\nTexte',
      'blocking doit valoir true ou false (reçu « peut-etre »).',
    ],
    [
      'blocking absent',
      '<!-- agentlake:question id=Q1 -->\n<!-- agentlake:text -->\n**Q**\n\nTexte',
      'blocking doit valoir true ou false.',
    ],
    ['texte absent', '<!-- agentlake:question id=Q1 blocking=true -->', 'text :'],
    [
      'identifiant invalide',
      '<!-- agentlake:question id=-x blocking=true -->\n<!-- agentlake:text -->\n**Q**\n\nTexte',
      'Identifiant de question invalide',
    ],
  ])('refuse une question : %s', (_name, body, message) => {
    const result = parseQuestionComment(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it.each([
    ['en-tête absent', 'Oui', 'En-tête « <!-- agentlake:answer … --> » absent.'],
    [
      'decision invalide',
      '<!-- agentlake:answer id=Q1 decision=oui -->\nOui',
      'decision doit valoir true ou false (reçu « oui »).',
    ],
    ['réponse vide', '<!-- agentlake:answer id=Q1 -->\n   ', 'La réponse ne peut pas être vide.'],
  ])('refuse une réponse : %s', (_name, body, message) => {
    const result = parseAnswerComment(body);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it('rendu d’une question complète (régression)', () => {
    expect(renderQuestionComment(sampleQuestion)).toMatchSnapshot();
  });

  it('rendu d’une question non bloquante sans contexte ni options (régression)', () => {
    expect(
      renderQuestionComment({
        id: 'Q2',
        blocking: false,
        text: 'Couleur du bouton ?',
        options: [],
      }),
    ).toMatchSnapshot();
  });

  it('rendu d’une réponse (régression)', () => {
    expect(
      renderAnswerComment({ id: 'Q-T04-1', decision: true, text: 'Non, plus tard.' }),
    ).toMatchSnapshot();
  });
});
