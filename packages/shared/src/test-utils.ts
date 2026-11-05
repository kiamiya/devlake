import type { AgentProfile } from './agent-profile.js';
import type { PlanTask, ProjectPlan } from './plan.js';
import type { ProjectConfig } from './project-config.js';

/** Fixtures valides réutilisables par les tests des autres paquets. */

export function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 'T01',
    title: 'Écran de connexion',
    description: 'Créer l’écran de connexion avec e-mail et mot de passe.',
    kind: 'code',
    profile: 'frontend',
    complexity: 'M',
    acceptanceCriteria: [
      'Un utilisateur valide se connecte',
      'Un mauvais mot de passe affiche une erreur',
    ],
    requiredTests: {
      unit: ['Validation du formulaire'],
      e2e: ['Parcours de connexion complet'],
    },
    codeZones: ['src/auth/'],
    exclusiveResources: [],
    dependencies: ['T00'],
    ...overrides,
  };
}

export function makeBootstrapTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return makeTask({
    id: 'T00',
    title: 'Bootstrap du dépôt',
    description: 'Structure, conventions et CI complète.',
    profile: 'architect',
    complexity: 'L',
    acceptanceCriteria: ['La CI tourne sur main'],
    requiredTests: { unit: ['Test trivial'] },
    codeZones: ['/'],
    dependencies: [],
    ...overrides,
  });
}

export function makePlan(overrides: Partial<ProjectPlan> = {}): ProjectPlan {
  return {
    summary: 'Application web de prise de rendez-vous.',
    assumptions: ['Supabase pour l’authentification'],
    epics: [{ id: 'E1', title: 'Authentification' }],
    milestones: [{ id: 'J1', title: 'Première version' }],
    tasks: [
      makeBootstrapTask({ milestone: 'J1' }),
      makeTask({ epic: 'E1', milestone: 'J1' }),
      makeTask({
        id: 'T02',
        title: 'README',
        description: 'Documenter l’installation.',
        kind: 'docs',
        profile: 'docs',
        complexity: 'S',
        acceptanceCriteria: ['Le README décrit l’installation'],
        requiredTests: {},
        codeZones: ['README.md'],
        dependencies: ['T00'],
      }),
    ],
    profiles: [
      { profile: 'architect', justification: 'Bootstrap du dépôt.' },
      { profile: 'frontend', justification: 'Interface web.' },
      { profile: 'docs', justification: 'Documentation.' },
    ],
    proposedAgents: 2,
    ...overrides,
  };
}

export function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    type: 'web',
    qualityProfile: 'web',
    limits: { maxConcurrentAgents: 3, maxAttempts: 3, answerReminderHours: 24 },
    profiles: ['architect', 'frontend'],
    exclusiveResources: ['migrations'],
    bridgeRequired: false,
    ...overrides,
  };
}

export function makeAgentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'frontend',
    systemPrompt: 'Tu es l’agent Frontend d’AgentLake.',
    allowedTools: ['Read', 'Edit', 'Bash'],
    maxTurns: 40,
    model: 'claude-sonnet-5-5',
    exclusiveResources: [],
    estimatedMinutes: 20,
    mcpServers: {},
    ...overrides,
  };
}
