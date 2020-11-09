import chalk from 'chalk';
import dedent from 'ts-dedent';

import { info, warning } from '../../components/icons';
import link from '../../components/link';

const githubActionNote = dedent`
  In {bold GitHub Actions}, you can enable this by setting \`fetch-depth: 0\`.
  ${info} Read more at ${link('https://www.chromatic.com/docs/ci#github-actions')}
`;
const genericNote = dedent`
  Refer to your CI provider's documentation for details.
`;

export default isGithubAction =>
  dedent(chalk`
    ${warning} {bold Found only one commit}
    This typically means you've checked out a shallow copy of the git repository, which some CI systems do by default.
    In order for Chromatic to correctly determine baseline commits, we need access to the full git history graph.
    ${isGithubAction ? githubActionNote : genericNote}
  `);
