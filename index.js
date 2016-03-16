#!/usr/bin/env node

'use strict';

const github = require('octonode');
const argv = require('minimist')(process.argv.slice(2));
const chalk = require('chalk');
const path = require('path');
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
    `  ${chalk.yellow('--user')}      ${req} name of the org or user you want to search in`,
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

if (!argv.user) {
  exit(new Error('missing user'));
}

const client = github.client(argv.token);
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

function notInSubPackage(file) {
  return file.path.indexOf('bower_components') === -1 &&
    file.path.indexOf('node_modules') === -1;
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

function scheduleSearch(force) {
  if (currentSearches < maxParalelSearch) {
    currentSearches += 1;
    return Promise.resolve();
  } else if (currentSearches === maxParalelSearch) {
    currentSearches += 1;
    startScheduler();
    logRateLimitHint();
  }

  return new Promise((resolve) => {
    pendingSearches[force ? 'unshift' : 'push'](resolve);
  });
}

function find(file, aPage, somePrevCound) {
  const page = aPage || 1;
  const prefCount = somePrevCound || 0;

  return scheduleSearch(page > 1).then(() => {
    debug(`searching for ${file} files`);

    return new Promise((resolve, reject) => {
      ghsearch.code({
        // q: `filename:${file}+repo:Jimdo/jimdo`,
        q: `${argv.search} filename:${file}+user:${argv.user}`,
        per_page: 100,
        page,
      }, (err, result) => {
        if (err) {
          return reject(err);
        }

        if (prefCount + result.items.length < result.total_count) {
          return find(file, page + 1, prefCount + result.items.length)
            .then((moreItems) => {
              resolve(result.items.filter(notInSubPackage).concat(moreItems));
            });
        }

        return resolve(result.items.filter(notInSubPackage));
      });
    });
  });
}

function getProjectUsage(file) {
  const ghrepo = client.repo(file.repository.full_name);
  const ghPath = path.join(file.repository.full_name, file.path);

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
}

function findPkgs() {
  return Promise.all(
    packageFiles.map((file) => find(file))
  )
    .then(concat)
    .then((files) => Promise.all(files.map(getProjectUsage)))
    .then((usages) => usages.filter(notNull));
}

findPkgs().then((usages) => {
  console.log(`\nsearched all repos of ${chalk.yellow(argv.user)} ` +
    `for usage of ${chalk.cyan(argv.search)}\n`);

  if (!usages || !usages.length) {
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
}).catch(exit);
