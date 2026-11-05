import { PROFILE_IDS, type ProfileId } from 'shared';
import { useEffect, useState, type FormEvent } from 'react';
import type { Settings } from '../../shared/settings.js';
import {
  useClearToken,
  useMaskedToken,
  useSetToken,
  useSettings,
  useTestToken,
  useUpdateSettings,
} from '../hooks/queries.js';
import { ClaudeTokenSection } from './ClaudeTokenSection.js';
import { Button } from './ui/button.js';
import { Card, CardDescription, CardTitle, Input, Label, Textarea } from './ui/primitives.js';

function Feedback({ error, success }: { error: unknown; success?: string | undefined }) {
  if (error instanceof Error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  }
  if (success) {
    return (
      <p role="status" className="text-sm text-success">
        {success}
      </p>
    );
  }
  return null;
}

function TokenSection() {
  const { data } = useMaskedToken();
  const setToken = useSetToken();
  const clearToken = useClearToken();
  const testToken = useTestToken();
  const [value, setValue] = useState('');

  const save = (event: FormEvent) => {
    event.preventDefault();
    setToken.mutate(value, {
      onSuccess: () => {
        setValue('');
      },
    });
  };

  const testedLogin = testToken.data as { login: string } | undefined;

  return (
    <Card>
      <CardTitle>Jeton GitHub</CardTitle>
      <CardDescription>
        Jeton à granularité fine, chiffré par le coffre du système. Il n’est jamais affiché en
        clair.
      </CardDescription>
      <p className="mb-4 text-sm">
        Jeton enregistré :{' '}
        <span data-testid="masked-token" className="font-mono">
          {data?.masked ?? 'aucun'}
        </span>
      </p>
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-72 flex-1 flex-col gap-2">
          <Label htmlFor="token">Nouveau jeton GitHub</Label>
          <Input
            id="token"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={value.trim() === '' || setToken.isPending}>
          Enregistrer le jeton GitHub
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!data?.masked || testToken.isPending}
          onClick={() => {
            testToken.mutate(undefined);
          }}
        >
          Tester
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!data?.masked}
          onClick={() => {
            clearToken.mutate(undefined);
          }}
        >
          Supprimer
        </Button>
      </form>
      <div className="mt-3">
        <Feedback
          error={setToken.error ?? testToken.error ?? clearToken.error}
          success={testedLogin ? `Jeton valide : compte ${testedLogin.login}.` : undefined}
        />
      </div>
    </Card>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const update = useUpdateSettings();
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const setModel = (profile: ProfileId, model: string) => {
    const others = Object.entries(form.modelsByProfile).filter(([key]) => key !== profile);
    const next = model.trim() === '' ? others : [...others, [profile, model]];
    set('modelsByProfile', Object.fromEntries(next) as Settings['modelsByProfile']);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(form, {
      onSuccess: () => {
        setSaved(true);
      },
    });
  };

  const number = (text: string) => (text === '' ? Number.NaN : Number(text));

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardTitle>Compte et agents</CardTitle>
        <CardDescription>Plafonds appliqués à tous les projets.</CardDescription>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="githubAccount">Compte GitHub</Label>
            <Input
              id="githubAccount"
              value={form.githubAccount}
              onChange={(e) => {
                set('githubAccount', e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="maxConcurrentAgents">Agents simultanés (plafond global)</Label>
            <Input
              id="maxConcurrentAgents"
              type="number"
              min={1}
              value={Number.isNaN(form.maxConcurrentAgents) ? '' : form.maxConcurrentAgents}
              onChange={(e) => {
                set('maxConcurrentAgents', number(e.target.value));
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="maxAttempts">Tentatives avant escalade</Label>
            <Input
              id="maxAttempts"
              type="number"
              min={1}
              value={Number.isNaN(form.maxAttempts) ? '' : form.maxAttempts}
              onChange={(e) => {
                set('maxAttempts', number(e.target.value));
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workflowsVersion">Version des workflows devlake</Label>
            <Input
              id="workflowsVersion"
              value={form.workflowsVersion}
              onChange={(e) => {
                set('workflowsVersion', e.target.value);
              }}
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Modèles par profil</CardTitle>
        <CardDescription>
          Aucun modèle n’est imposé : laisser vide tant qu’un profil n’est pas utilisé.
        </CardDescription>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {PROFILE_IDS.map((profile) => (
            <div key={profile} className="flex flex-col gap-2">
              <Label htmlFor={`model-${profile}`}>{profile}</Label>
              <Input
                id={`model-${profile}`}
                value={form.modelsByProfile[profile] ?? ''}
                onChange={(e) => {
                  setModel(profile, e.target.value);
                }}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardTitle>Éditeurs et Aura</CardTitle>
        <CardDescription>
          Blocs JSON copiés depuis l’écran « MCP Configuration » d’Aura, collés tels quels.
        </CardDescription>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="editorClonesDir">Dossier des clones d’éditeur</Label>
            <Input
              id="editorClonesDir"
              value={form.editorClonesDir ?? ''}
              onChange={(e) => {
                set('editorClonesDir', e.target.value.trim() === '' ? null : e.target.value);
              }}
            />
          </div>
          {(['unity', 'unreal'] as const).map((editor) => (
            <div key={editor} className="flex flex-col gap-2">
              <Label htmlFor={`aura-${editor}`}>
                Configuration MCP Aura — {editor === 'unity' ? 'Unity' : 'Unreal'}
              </Label>
              <Textarea
                id={`aura-${editor}`}
                value={form.auraMcp[editor] ?? ''}
                onChange={(e) => {
                  set('auraMcp', {
                    ...form.auraMcp,
                    [editor]: e.target.value.trim() === '' ? null : e.target.value,
                  });
                }}
              />
            </div>
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={update.isPending}>
          Enregistrer les réglages
        </Button>
        <Feedback error={update.error} success={saved ? 'Réglages enregistrés.' : undefined} />
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { data, error } = useSettings();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">Réglages</h1>
      <TokenSection />
      <ClaudeTokenSection />
      {data ? <SettingsForm initial={data} /> : <Feedback error={error} />}
    </div>
  );
}
