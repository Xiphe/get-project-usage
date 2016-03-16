#!/usr/bin/env node

'use strict';

const github = require('octonode');
const argv = require('minimist')(process.argv.slice(2));
const chalk = require('chalk');
const path = require('path');
const perPage = 100;
const maxPages = -1;
const packageFiles = [
  'package.json',
  'bower.json',
];
const dependencyKeys = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
];
const searchLimitTimeout = 1000 * 21;
const maxParalelSearch = 10;
const countDownInterval = 1000 * 7;

let countDown = searchLimitTimeout;
let currentSearches = 0;
let pendingSearches = [];
let schedulerStarted = false;

const req = chalk.red('*');

function help() {
  console.log([
    '',
    'search usage of package across all your owned repos',
    'or repos of a org.',
    '',
    'usage:',
    chalk.cyan('  get-project-usage --token=foobarmytoken --search=babel'),
    '',
    'arguments:',
    `  ${chalk.yellow('--token')}     ${req} OAuth token with repo access`,
    `  ${chalk.yellow('--search')}    ${req} the package name you want to search`,
    '              as used in package.json or bower.json',
    `  ${chalk.yellow('--org')}       name of the org you want to search in`,
    '              your owned repos are searched if not set',
    `  ${chalk.yellow('--verbose')}   log a lot`,
    `  ${chalk.yellow('--help')}      show this help`,
    '',
    ` ${chalk.red('* required')}`,
    '',
    `Create an OAuth token here: ${chalk.cyan('https://github.com/settings/tokens')}`,
  ].join('\n'));
}

function exit(err) {
  let code = 0;

  if (err) {
    console.error(chalk.red(err));
    help();
    code = 1;
  }

  process.exit(code);
}

if (argv.help) {
  help();
  exit();
}


function debug(msg) {
  if (argv.verbose) {
    console.log(chalk.magenta('DEBUG: ') + msg);
  }
}

if (!argv.token) {
  exit(new Error('missing token'));
}

if (!argv.search) {
  exit(new Error('missing search'));
}

const client = github.client(argv.token);
const ghorg = argv.org ? client.org(argv.org) : null;
const ghsearch = client.search();

function concat(args) {
  return args.reduce((concated, thing) => concated.concat(thing), []);
}

function isPkg(file) {
  return packageFiles.indexOf(file.name) !== -1;
}

function notNull(thing) {
  return thing !== null;
}

function logRateLimitHint() {
  setTimeout(() => {
    const timeLeft = pendingSearches.length / maxParalelSearch * searchLimitTimeout;

    debug(`waiting ${searchLimitTimeout / 1000} seconds because of search rate limit`);
    debug(chalk.yellow(`aprox ${Math.round(timeLeft / 6000) / 10} minutes left...`));
  }, 100);
}

function startScheduler() {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;

  setInterval(() => {
    if (pendingSearches.length) {
      countDown -= countDownInterval;

      if (countDown <= 0) {
        countDown = searchLimitTimeout;
        currentSearches = 0;

        pendingSearches = pendingSearches.map((search) => {
          if (currentSearches < maxParalelSearch) {
            currentSearches += 1;
            search();

            return null;
          }

          return search;
        }).filter(notNull);

        debug(`executing next ${maxParalelSearch} searches. ${pendingSearches.length} left...`);
        logRateLimitHint();
      } else {
        debug(`${countDown / 1000} seconds until next search batch`);
      }
    }
  }, countDownInterval);
}

function scheduleSearch() {
  if (currentSearches < maxParalelSearch) {
    currentSearches += 1;
    return Promise.resolve();
  } else if (currentSearches === maxParalelSearch) {
    currentSearches += 1;
    startScheduler();
    logRateLimitHint();
  }

  return new Promise((resolve) => {
    pendingSearches.push(resolve);
  });
}

function find(repo, file) {
  return scheduleSearch().then(() => {
    debug(`searching "${repo.full_name}" for ${file} files`);

    return new Promise((resolve, reject) => {
      ghsearch.code({
        // q: `filename:${file}+repo:Jimdo/siteadmin`,
        q: `filename:${file}+repo:${repo.full_name}`,
        sort: 'created',
        order: 'asc',
      }, (err, result) => {
        if (err) {
          return reject(err);
        }

        return resolve(result.items);
      });
    });
  });
}

function getProjectUsage(ghrepo) {
  return function mapper(file) {
    const ghPath = path.join(ghrepo.name, file.path);

    return new Promise((resolve, reject) => {
      debug(`searching for usage in ${ghPath}`);

      ghrepo.contents(file.path, (err, contents) => {
        if (err) {
          return reject(err);
        }

        const packageJson = JSON.parse(
          new Buffer(contents.content, contents.encoding).toString()
        );

        return resolve(
          dependencyKeys.map((dependencyKey) => {
            if (packageJson[dependencyKey] && packageJson[dependencyKey][argv.search]) {
              return {
                type: dependencyKey,
                version: packageJson[dependencyKey][argv.search],
              };
            }

            return null;
          })
          .filter(notNull)
          .reduce((result, usage) => {
            if (result === null) {
              return {
                ghPath,
                usages: [usage],
              };
            }

            result.usages.push(usage);

            return result;
          }, null)
        );
      });
    }).then((result) => {
      if (!result) {
        debug(`not used in ${ghPath}`);
      } else {
        debug(chalk.green(`usage found in ${ghPath}`));
      }

      return result;
    });
  };
}

function findPkgs(repo) {
  return Promise.all(
    packageFiles.map((file) => find(repo, file))
  ).then(concat).then((files) => {
    // const ghrepo = client.repo('Jimdo/siteadmin');
    const ghrepo = client.repo(repo.full_name);

    if (!files.length) {
      debug(`no package files found for ${repo.full_name}`);
    }

    return Promise.all(files.filter(isPkg).map(getProjectUsage(ghrepo)));
  });
}

function getRepos(page, cb) {
  if (ghorg) {
    return ghorg.repos(page, perPage, cb);
  }

  return client.get(
    '/user/repos',
    {
      type: 'owner',
      page,
      per_page: perPage,
    },
    (err, res, repos) => {
      cb(err, repos);
    }
  );
}

let totalRepos = 0;
function getUsage(aPage) {
  const page = aPage || 1;

  if (maxPages > -1 && page >= maxPages) {
    debug(`aborting repo fetching after ${maxPages} pages`);
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    debug(`fetching repos page: ${page}`);
    getRepos(page, (err, repos) => {
      if (err) {
        return reject(err);
      }

      totalRepos += repos.length;
      debug(
        `got ${repos.length} new repos ` +
        `(total: ${totalRepos})`
      );

      const promises = [
        Promise
          .all(repos.map(findPkgs))
          .then((usages) => concat(usages).filter(notNull)),
      ];

      if (repos.length === perPage) {
        promises.push(getUsage(page + 1));
      }

      return Promise.all(promises)
        .then(
          (allUsages) => resolve(concat(allUsages)),
          reject
        );
    });
  });
}

getUsage().then((usages) => {
  console.log(`\nsearched ${chalk.yellow(totalRepos)} repos ` +
    `for usage of ${chalk.cyan(argv.search)}\n`);

  if (!usages) {
    console.log('...no usage found');
  } else {
    usages.forEach((usage) => {
      console.log(`used in ${chalk.cyan(usage.ghPath)}:`);
      usage.usages.forEach((as) => {
        console.log(`  under ${chalk.yellow(as.type)} in version ${chalk.green(as.version)}`);
      });
    });
  }

  exit();
}, (err) => {
  exit(err);
});
