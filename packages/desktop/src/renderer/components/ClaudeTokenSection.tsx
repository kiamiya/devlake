import { useState, type FormEvent } from 'react';
import { useClearClaudeToken, useMaskedClaudeToken, useSetClaudeToken } from '../hooks/queries.js';
import { Button } from './ui/button.js';
import { Card, CardDescription, CardTitle, Input, Label } from './ui/primitives.js';

/** Jeton d'abonnement Claude Code, saisi une fois et poussé en secret dans chaque nouveau dépôt. */
export function ClaudeTokenSection() {
  const { data } = useMaskedClaudeToken();
  const setToken = useSetClaudeToken();
  const clearToken = useClearClaudeToken();
  const [value, setValue] = useState('');

  const save = (event: FormEvent) => {
    event.preventDefault();
    setToken.mutate(value, {
      onSuccess: () => {
        setValue('');
      },
    });
  };

  const error = setToken.error ?? clearToken.error;
  return (
    <Card>
      <CardTitle>Jeton Claude Code</CardTitle>
      <CardDescription>
        Généré par <code>claude setup-token</code>. Chiffré par le coffre du système, puis
        enregistré en secret <code>CLAUDE_CODE_OAUTH_TOKEN</code> de chaque nouveau dépôt.
      </CardDescription>
      <p className="mb-4 text-sm">
        Jeton enregistré :{' '}
        <span data-testid="masked-claude-token" className="font-mono">
          {data?.masked ?? 'aucun'}
        </span>
      </p>
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-72 flex-1 flex-col gap-2">
          <Label htmlFor="claude-token">Nouveau jeton Claude Code</Label>
          <Input
            id="claude-token"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </div>
        <Button type="submit" disabled={value.trim() === '' || setToken.isPending}>
          Enregistrer le jeton Claude
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
      {error instanceof Error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error.message}
        </p>
      )}
    </Card>
  );
}
