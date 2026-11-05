import { FakeGitHub } from './fake-github.js';
import { OctokitGitHub } from './octokit-github.js';
import { describeGitHubContract } from './testing/contract-suite.js';
import { githubEmulator } from './testing/github-emulator.js';
import { mswFetch } from './testing/msw-fetch.js';

describeGitHubContract('FakeGitHub', ({ issueDependencies }) => {
  const fake = new FakeGitHub({ issueDependencies });
  return { port: fake, fake };
});

describeGitHubContract('OctokitGitHub via msw', ({ issueDependencies }) => {
  const fake = new FakeGitHub({ issueDependencies });
  const handlers = githubEmulator(fake);
  const port = new OctokitGitHub({
    token: 'jeton-de-test',
    retry: { maxRetries: 0 },
    fetch: mswFetch(() => handlers),
  });
  return { port, fake };
});
