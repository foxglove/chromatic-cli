import { createTask, transitionTo } from '../lib/tasks';
import listingStories from '../ui/messages/info/listingStories';
import storybookPublished from '../ui/messages/info/storybookPublished';
import buildLimited from '../ui/messages/warnings/buildLimited';
import noAncestorBuild from '../ui/messages/warnings/noAncestorBuild';
import paymentRequired from '../ui/messages/warnings/paymentRequired';
import snapshotQuotaReached from '../ui/messages/warnings/snapshotQuotaReached';
import { initial, pending, runOnly, runOnlyFiles, success } from '../ui/tasks/verify';

const TesterCreateBuildMutation = `
  mutation TesterCreateBuildMutation($input: CreateBuildInput!, $isolatorUrl: String!) {
    createBuild(input: $input, isolatorUrl: $isolatorUrl) {
      id
      number
      specCount
      componentCount
      testCount
      actualTestCount: testCount(statuses: [IN_PROGRESS])
      actualCaptureCount
      webUrl
      cachedUrl
      reportToken
      browsers {
        browser
      }
      features {
        uiTests
        uiReview
      }
      wasLimited
      app {
        account {
          exceededThreshold
          paymentRequired
          billingUrl
        }
        repository {
          provider
        }
        setupUrl
      }
      tests {
        spec {
          name
          component {
            name
            displayName
          }
        }
        parameters {
          viewport
          viewportIsDefault
        }
      }
    }
  }
`;

export const setEnvironment = async (ctx) => {
  // We send up all environment variables provided by these complicated systems.
  // We don't want to send up *all* environment vars as they could include sensitive information
  // about the user's build environment
  ctx.environment = JSON.stringify(
    Object.entries(process.env).reduce((acc, [key, value]) => {
      if (ctx.env.ENVIRONMENT_WHITELIST.find((regex) => key.match(regex))) {
        acc[key] = value;
      }
      return acc;
    }, {})
  );

  ctx.log.debug(`Got environment ${ctx.environment}`);
};

export const createBuild = async (ctx, task) => {
  const { list, only, patchBaseRef, patchHeadRef, preserveMissingSpecs } = ctx.options;
  const { version, matchesBranch, changedFiles, ...commitInfo } = ctx.git; // omit some fields
  const { rebuildForBuildId, onlyStoryFiles, turboSnapEnabled, turboSnapBailReason } = ctx;
  const autoAcceptChanges = matchesBranch(ctx.options.autoAcceptChanges);

  // It's not possible to set both --only and --only-changed
  if (only) {
    transitionTo(runOnly)(ctx, task);
  }
  if (onlyStoryFiles) {
    transitionTo(runOnlyFiles)(ctx, task);
  }

  const { createBuild: build } = await ctx.client.runQuery(TesterCreateBuildMutation, {
    input: {
      ...commitInfo,
      rebuildForBuildId,
      ...(only && { only }),
      ...(onlyStoryFiles && { onlyStoryFiles: Object.keys(onlyStoryFiles) }),
      turboSnapEnabled,
      // GraphQL does not support union input types (yet), so we stringify the turboSnapBailReason
      // @see https://github.com/graphql/graphql-spec/issues/488
      ...(turboSnapBailReason && { turboSnapBailReason: JSON.stringify(turboSnapBailReason) }),
      autoAcceptChanges,
      cachedUrl: ctx.cachedUrl,
      environment: ctx.environment,
      patchBaseRef,
      patchHeadRef,
      preserveMissingSpecs,
      packageVersion: ctx.pkg.version,
      storybookVersion: ctx.storybook.version,
      viewLayer: ctx.storybook.viewLayer,
      addons: ctx.storybook.addons,
    },
    isolatorUrl: ctx.isolatorUrl,
  });

  ctx.build = build;
  ctx.isPublishOnly = !build.features.uiReview && !build.features.uiTests;
  ctx.isOnboarding = build.number === 1 || (build.autoAcceptChanges && !autoAcceptChanges);

  if (list) {
    ctx.log.info(listingStories(build.tests));
  }

  if (!ctx.isOnboarding && !ctx.git.parentCommits) {
    ctx.log.warn(noAncestorBuild(ctx));
  }

  if (build.wasLimited) {
    const { account } = build.app;
    if (account.exceededThreshold) {
      ctx.log.warn(snapshotQuotaReached(account));
      ctx.exitCode = 101;
    } else if (account.paymentRequired) {
      ctx.log.warn(paymentRequired(account));
      ctx.exitCode = 102;
    } else {
      // Future proofing for reasons we aren't aware of
      ctx.log.warn(buildLimited(account));
      ctx.exitCode = 100;
    }
  }

  transitionTo(success, true)(ctx, task);

  if (list || ctx.isPublishOnly || matchesBranch(ctx.options.exitOnceUploaded)) {
    ctx.exitCode = 0;
    ctx.skipSnapshots = true;
    ctx.log.info(storybookPublished(ctx));
  }
};

export default createTask({
  title: initial.title,
  skip: (ctx) => ctx.skip,
  steps: [transitionTo(pending), setEnvironment, createBuild],
});
