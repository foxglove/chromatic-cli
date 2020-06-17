import execa from 'execa';
import fs from 'fs';
import { confirm } from 'node-ask';
import fetch from 'node-fetch';
import kill from 'tree-kill';

import getEnv from './lib/getEnv';
import parseArgs from './lib/parseArgs';
import startApp, { checkResponse } from './lib/startStorybook';
import openTunnel from './lib/tunnel';
import uploadFiles from './lib/uploadFiles';
import { runAll, runBuild } from './main';

let lastBuild;
let mockBuildFeatures;
beforeEach(() => {
  fetch.mockClear();
  mockBuildFeatures = {
    features: { uiTests: true, uiReview: true },
    wasLimited: false,
  };
});

jest.mock('execa');

jest.mock('jsonfile', () => ({
  readFileSync: () => ({
    scripts: {
      storybook: 'start-storybook -p 1337',
      otherStorybook: 'start-storybook -p 7070',
      notStorybook: 'lint',
      'build-storybook': 'build-storybook',
      otherBuildStorybook: 'build-storybook',
    },
  }),
}));

jest.mock('node-ask');

jest.mock('node-fetch', () =>
  jest.fn(async (url, { body } = {}) => ({
    ok: true,
    json: async () => {
      const { query, variables } = JSON.parse(body);

      // Authenticate
      if (query.match('TesterCreateAppTokenMutation')) {
        return { data: { createAppToken: 'token' } };
      }

      if (query.match('TesterCreateBuildMutation')) {
        if (variables.isolatorUrl.startsWith('http://throw-an-error')) {
          throw new Error('fetch error');
        }
        lastBuild = variables;
        return {
          data: {
            createBuild: {
              number: 1,
              specCount: 1,
              componentCount: 1,
              webUrl: 'http://test.com',
              cachedUrl: 'https://5d67dc0374b2e300209c41e7-pfkaemtlit.chromatic.com/iframe.html',
              ...mockBuildFeatures,
              app: {
                account: {
                  billingUrl: 'https://foo.bar',
                  exceededThreshold: false,
                  paymentRequired: false,
                },
              },
              snapshots: [
                {
                  spec: { name: 'name', component: { displayName: 'component' } },
                  parameters: { viewport: 320, viewportIsDefault: false },
                },
              ],
            },
          },
        };
      }

      if (query.match('TesterBuildQuery')) {
        return {
          data: {
            app: { build: { status: 'BUILD_PENDING', changeCount: 1 } },
          },
        };
      }

      if (query.match('TesterFirstCommittedAtQuery')) {
        return { data: { app: { firstBuild: { committedAt: null } } } };
      }

      if (query.match('TesterHasBuildsWithCommitsQuery')) {
        return { data: { app: { hasBuildsWithCommits: [] } } };
      }

      if (query.match('TesterGetUploadUrlsMutation')) {
        return {
          data: {
            getUploadUrls: {
              domain: 'https://chromatic.com',
              urls: [
                {
                  path: 'one.js',
                  url: 'https://cdn.example.com/one.js',
                  contentType: 'text/javascript',
                },
                {
                  path: 'two.js',
                  url: 'https://cdn.example.com/two.js',
                  contentType: 'text/javascript',
                },
              ],
            },
          },
        };
      }

      throw new Error(`Unknown Query: ${query}`);
    },
  }))
);

jest.mock('tree-kill');

jest.mock('fs-extra', () => ({
  pathExists: async () => true,
  readFileSync: require.requireActual('fs-extra').readFileSync,
}));

fs.readdirSync = jest.fn(() => ['one.js', 'two.js']);
const fsStatSync = fs.statSync;
fs.statSync = jest.fn(path => {
  if (path.endsWith('/package.json')) return fsStatSync(path); // for meow
  return { isDirectory: () => false, size: 42 };
});

jest.mock('./git/git', () => ({
  getCommit: () => ({
    commit: 'commit',
    committedAt: 1234,
    committerEmail: 'test@test.com',
    committerName: 'tester',
  }),
  getBranch: () => 'branch',
  getBaselineCommits: () => ['baseline'],
  getVersion: () => '2.24.1',
}));

jest.mock('./lib/startStorybook');
jest.mock('./lib/getStorybookInfo', () => () => ({
  version: '5.1.0',
  viewLayer: 'viewLayer',
  addons: [],
}));
jest.mock('./lib/tunnel');
jest.mock('./lib/uploadFiles');

let processEnv;
beforeEach(() => {
  processEnv = process.env;
  process.env = {
    DISABLE_LOGGING: true,
    CHROMATIC_APP_CODE: undefined,
    CHROMATIC_PROJECT_TOKEN: undefined,
  };
  execa.mockReset();
});
afterEach(() => {
  process.env = processEnv;
});

class TestLogger {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  error(...args) {
    this.errors.push(...args);
  }

  warn(...args) {
    this.warnings.push(...args);
  }

  info() {
    // do nothing
  }

  log() {
    // do nothing
  }

  debug() {
    // do nothing
  }

  queue() {
    // do nothing
  }

  flush() {
    // do nothing
  }
}

const getContext = argv => {
  const env = getEnv();
  const log = new TestLogger();
  return { env, log, sessionId: ':sessionId', ...parseArgs(argv) };
};

it('fails on missing project token', async () => {
  const ctx = getContext([]);
  ctx.env.CHROMATIC_PROJECT_TOKEN = '';
  await runBuild(ctx);
  expect(ctx.exitCode).toBe(254);
  expect(ctx.log.errors[0]).toMatch(/Missing project token/);
});

it('runs in simple situations', async () => {
  const ctx = getContext(['--project-token=asdf1234']);
  await runBuild(ctx);

  expect(ctx.exitCode).toBe(1);
  expect(lastBuild).toMatchObject({
    input: {
      branch: 'branch',
      commit: 'commit',
      committedAt: 1234,
      baselineCommits: ['baseline'],
      fromCI: false,
      isTravisPrBuild: false,
      packageVersion: expect.any(String),
      storybookVersion: '5.1.0',
      viewLayer: 'viewLayer',
      committerEmail: 'test@test.com',
      committerName: 'tester',
    },
    isolatorUrl: `https://chromatic.com/iframe.html`,
  });
});

it('returns 0 with exit-zero-on-changes', async () => {
  const ctx = getContext(['--project-token=asdf1234', '--exit-zero-on-changes']);
  await runBuild(ctx);
  expect(ctx.exitCode).toBe(0);
});

it('returns 0 with exit-once-uploaded', async () => {
  const ctx = getContext(['--project-token=asdf1234', '--exit-once-uploaded']);
  await runBuild(ctx);
  expect(ctx.exitCode).toBe(0);
});

it('returns 0 when the build is publish only', async () => {
  mockBuildFeatures = {
    features: { uiTests: false, uiReview: false },
    wasLimited: false,
  };
  const ctx = getContext(['--project-token=asdf1234']);
  await runBuild(ctx);
  expect(ctx.exitCode).toBe(0);
});

it('calls out to npm build script passed and uploads files', async () => {
  const ctx = getContext(['--project-token=asdf1234', '--build-script-name=build-storybook']);
  await runBuild(ctx);
  expect(ctx.exitCode).toBe(1);
  expect(uploadFiles).toHaveBeenCalledWith(
    expect.any(Object),
    [
      {
        contentLength: 42,
        contentType: 'text/javascript',
        path: expect.stringMatching(/\/one\.js$/),
        url: 'https://cdn.example.com/one.js',
      },
      {
        contentLength: 42,
        contentType: 'text/javascript',
        path: expect.stringMatching(/\/two\.js$/),
        url: 'https://cdn.example.com/two.js',
      },
    ],
    expect.any(Function)
  );
});

it('skips building and uploads directly with storybook-build-dir', async () => {
  const ctx = getContext(['--project-token=asdf1234', '--storybook-build-dir=dirname']);
  await runBuild(ctx);
  expect(ctx.exitCode).toBe(1);
  expect(execa).not.toHaveBeenCalled();
  expect(uploadFiles).toHaveBeenCalledWith(
    expect.any(Object),
    [
      {
        contentLength: 42,
        contentType: 'text/javascript',
        path: expect.stringMatching(/\/one\.js$/),
        url: 'https://cdn.example.com/one.js',
      },
      {
        contentLength: 42,
        contentType: 'text/javascript',
        path: expect.stringMatching(/\/two\.js$/),
        url: 'https://cdn.example.com/two.js',
      },
    ],
    expect.any(Function)
  );
});

it('passes autoAcceptChanges to the index', async () => {
  const ctx = getContext(['--project-token=asdf1234', '--auto-accept-changes']);
  await runBuild(ctx);
  expect(lastBuild).toMatchObject({ input: { autoAcceptChanges: true } });
});

it('passes autoAcceptChanges to the index based on branch', async () => {
  await runBuild(getContext(['--project-token=asdf1234', '--auto-accept-changes=branch']));
  expect(lastBuild).toMatchObject({ input: { autoAcceptChanges: true } });

  await runBuild(getContext(['--project-token=asdf1234', '--auto-accept-changes=wrong-branch']));
  expect(lastBuild).toMatchObject({ input: { autoAcceptChanges: false } });
});

describe('tunneled build', () => {
  beforeEach(() => {
    startApp.mockReset().mockReturnValue({
      on: jest.fn(),
      stderr: { on: jest.fn(), resume: jest.fn() },
      stdout: { on: jest.fn(), resume: jest.fn() },
    });
    checkResponse.mockReset();
    openTunnel.mockReset().mockReturnValue({
      url: 'http://tunnel.com/?clientId=foo',
      cachedUrl: 'http://cached.tunnel.com?foo=bar#hash',
      close: jest.fn,
    });
    kill.mockReset().mockImplementation((pid, sig, cb) => cb());
  });

  it('properly deals with updating the isolatorUrl/cachedUrl in complex situations', async () => {
    const ctx = getContext(['--project-token=asdf1234', '--script-name=storybook']);
    await runBuild(ctx);

    expect(ctx.exitCode).toBe(1);
    expect(ctx.closeTunnel).toBeDefined();
    expect(lastBuild).toMatchObject({
      input: { cachedUrl: 'http://cached.tunnel.com/iframe.html?foo=bar' },
      isolatorUrl: `http://tunnel.com/?clientId=foo&path=${encodeURIComponent('/iframe.html')}`,
    });
  });

  it('calls out to npm script passed', async () => {
    const ctx = getContext(['--project-token=asdf1234', '--script-name=storybook']);
    await runBuild(ctx);
    expect(startApp).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptName: 'storybook',
        url: 'http://localhost:1337/iframe.html',
        args: ['--', '--ci'],
      })
    );
  });

  it('calls out to the exec command passed', async () => {
    const ctx = getContext([
      '--project-token=asdf1234',
      '--exec=./run.sh',
      '--storybook-port=9001',
    ]);
    await runBuild(ctx);
    expect(startApp).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: './run.sh',
        url: 'http://localhost:9001/iframe.html',
      })
    );
    expect(openTunnel).toHaveBeenCalledWith(expect.objectContaining({ port: '9001' }));
  });

  it('skips start when already running', async () => {
    checkResponse.mockReturnValue(true);
    const ctx = getContext(['--project-token=asdf1234', '--script-name=storybook']);
    await runBuild(ctx);
    expect(startApp).not.toHaveBeenCalled();
    expect(openTunnel).toHaveBeenCalledWith(expect.objectContaining({ port: '1337' }));
  });

  it('fails when trying to use --do-not-start while not running', async () => {
    checkResponse.mockReturnValueOnce(false);
    const ctx = getContext([
      '--project-token=asdf1234',
      '--script-name=storybook',
      '--do-not-start',
    ]);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(255);
    expect(startApp).not.toHaveBeenCalled();
  });

  it('skips tunnel when using --storybook-url', async () => {
    checkResponse.mockReturnValue(true);
    const ctx = getContext([
      '--project-token=asdf1234',
      '--storybook-url=http://localhost:1337/iframe.html?foo=bar#hash',
    ]);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(1);
    expect(ctx.closeTunnel).toBeUndefined();
    expect(openTunnel).not.toHaveBeenCalled();
    expect(lastBuild).toMatchObject({
      isolatorUrl: 'http://localhost:1337/iframe.html?foo=bar#hash',
    });
  });

  it('stops the running Storybook if something goes wrong', async () => {
    openTunnel.mockImplementation(() => {
      throw new Error('tunnel error');
    });
    startApp.mockReturnValueOnce({ pid: 'childpid' });
    const ctx = getContext(['--project-token=asdf1234', '--script-name=storybook']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(255);
    expect(ctx.log.errors[0]).toMatch('tunnel error');
    expect(kill).toHaveBeenCalledWith('childpid', 'SIGHUP', expect.any(Function));
  });

  it('stops the tunnel if something goes wrong', async () => {
    const close = jest.fn();
    openTunnel.mockReturnValueOnce({
      url: 'http://throw-an-error',
      cachedUrl: 'http://tunnel.com/',
      close,
    });
    const ctx = getContext(['--project-token=asdf1234', '--script-name=storybook']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(255);
    expect(ctx.log.errors[0]).toMatch('fetch error');
    expect(close).toHaveBeenCalled();
  });
});

describe('in CI', () => {
  it('detects standard CI environments', async () => {
    process.env = { CI: 'true', DISABLE_LOGGING: 'true' };
    const ctx = getContext(['--project-token=asdf1234']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(1);
    expect(lastBuild).toMatchObject({
      input: {
        fromCI: true,
        isTravisPrBuild: false,
      },
    });
    expect(ctx.options.interactive).toBe(false);
  });

  it('detects CI passed as option', async () => {
    process.env = { DISABLE_LOGGING: 'true' };
    const ctx = getContext(['--project-token=asdf1234', '--ci']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(1);
    expect(lastBuild).toMatchObject({
      input: {
        fromCI: true,
        isTravisPrBuild: false,
      },
    });
    expect(ctx.options.interactive).toBe(false);
  });

  it('detects Netlify CI', async () => {
    process.env = { REPOSITORY_URL: 'foo', DISABLE_LOGGING: 'true' };
    const ctx = getContext(['--project-token=asdf1234']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(1);
    expect(lastBuild).toMatchObject({
      input: {
        fromCI: true,
        isTravisPrBuild: false,
      },
    });
    expect(ctx.options.interactive).toBe(false);
  });

  it('detects Travis PR build, external', async () => {
    process.env = {
      CI: 'true',
      TRAVIS_EVENT_TYPE: 'pull_request',
      TRAVIS_PULL_REQUEST_SLUG: 'a',
      TRAVIS_REPO_SLUG: 'b',
      TRAVIS_PULL_REQUEST_SHA: 'travis-commit',
      TRAVIS_PULL_REQUEST_BRANCH: 'travis-branch',
      DISABLE_LOGGING: 'true',
    };
    const ctx = getContext(['--project-token=asdf1234']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(1);
    expect(lastBuild).toMatchObject({
      input: {
        commit: 'travis-commit',
        branch: 'travis-branch',
        fromCI: true,
        isTravisPrBuild: true,
      },
    });
    expect(ctx.options.interactive).toBe(false);
    expect(ctx.log.warnings.length).toBe(0);
  });

  it('detects Travis PR build, internal', async () => {
    process.env = {
      CI: 'true',
      TRAVIS_EVENT_TYPE: 'pull_request',
      TRAVIS_PULL_REQUEST_SLUG: 'a',
      TRAVIS_REPO_SLUG: 'a',
      TRAVIS_PULL_REQUEST_SHA: 'travis-commit',
      TRAVIS_PULL_REQUEST_BRANCH: 'travis-branch',
      DISABLE_LOGGING: 'true',
    };
    const ctx = getContext(['--project-token=asdf1234']);
    await runBuild(ctx);
    expect(ctx.exitCode).toBe(1);
    expect(lastBuild).toMatchObject({
      input: {
        commit: 'travis-commit',
        branch: 'travis-branch',
        fromCI: true,
        isTravisPrBuild: true,
      },
    });
    expect(ctx.options.interactive).toBe(false);
    expect(ctx.log.warnings.length).toBe(1);
    expect(ctx.log.warnings[0]).toMatch(
      /Running Chromatic on a Travis PR build from an internal branch/
    );
  });
});

it('checks for updates', async () => {
  const ctx = getContext(['--project-token=asdf1234']);
  ctx.pkg.version = '4.3.2';
  fetch.mockReturnValueOnce(
    Promise.resolve({ json: () => ({ 'dist-tags': { latest: '5.0.0' } }) })
  );
  await runAll(ctx);
  expect(ctx.exitCode).toBe(1);
  expect(fetch).toHaveBeenCalledWith('https://registry.npmjs.org/chromatic');
  expect(ctx.log.warnings[0]).toMatch('Using outdated package');
});

it('prompts you to add a script to your package.json', async () => {
  process.stdout.isTTY = true; // enable interactive mode
  const ctx = getContext(['--project-token=asdf1234']);
  await runAll(ctx);
  expect(ctx.exitCode).toBe(1);
  expect(confirm).toHaveBeenCalled();
});