import { describe, expect, it } from 'vitest';
import { PROFILE_IDS } from './ids.js';
import {
  ALL_LABELS,
  INITIAL_TASK_STATE,
  STATE_TRANSITIONS,
  TASK_LABEL,
  TASK_STATES,
  canTransition,
  parseProfileLabel,
  parseStateLabel,
  profileLabel,
  stateLabel,
} from './labels.js';

describe('labels', () => {
  it('nomme les labels selon le cadrage', () => {
    expect(TASK_LABEL).toBe('agentlake:task');
    expect(stateLabel('awaiting-answer')).toBe('agentlake:state/awaiting-answer');
    expect(profileLabel('unity')).toBe('agentlake:profile/unity');
    expect(INITIAL_TASK_STATE).toBe('queued');
  });

  it('relit chaque label d’état et de profil', () => {
    for (const state of TASK_STATES) expect(parseStateLabel(stateLabel(state))).toBe(state);
    for (const profile of PROFILE_IDS)
      expect(parseProfileLabel(profileLabel(profile))).toBe(profile);
  });

  it('ignore les labels étrangers ou inconnus', () => {
    expect(parseStateLabel('bug')).toBeUndefined();
    expect(parseStateLabel('agentlake:state/merged')).toBeUndefined();
    expect(parseProfileLabel('agentlake:state/ready')).toBeUndefined();
    expect(parseProfileLabel('agentlake:profile/designer')).toBeUndefined();
  });

  it('liste tous les labels sans doublon', () => {
    expect(ALL_LABELS).toHaveLength(1 + TASK_STATES.length + PROFILE_IDS.length);
    expect(new Set(ALL_LABELS).size).toBe(ALL_LABELS.length);
  });

  it('suit la table des transitions du cycle de vie', () => {
    expect(STATE_TRANSITIONS).toMatchSnapshot();
    expect(canTransition('queued', 'ready')).toBe(true);
    expect(canTransition('running', 'awaiting-answer')).toBe(true);
    expect(canTransition('fixing', 'escalated')).toBe(true);
    expect(canTransition('queued', 'running')).toBe(false);
    expect(canTransition('awaiting-answer', 'fixing')).toBe(false);
  });

  it('ne cite que des états connus dans la table', () => {
    for (const targets of Object.values(STATE_TRANSITIONS)) {
      for (const target of targets) expect(TASK_STATES).toContain(target);
    }
  });
});
