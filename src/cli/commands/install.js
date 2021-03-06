/* @flow */

import type {Reporter} from '../../reporters/index.js';
import type {ReporterSelectOption} from '../../reporters/types.js';
import type {Manifest, DependencyRequestPatterns} from '../../types.js';
import type Config from '../../config.js';
import type {RegistryNames} from '../../registries/index.js';
import normalizeManifest from '../../util/normalize-manifest/index.js';
import {MessageError} from '../../errors.js';
import InstallationIntegrityChecker from '../../integrity-checker.js';
import Lockfile from '../../lockfile/wrapper.js';
import lockStringify from '../../lockfile/stringify.js';
import PackageFetcher from '../../package-fetcher.js';
import PackageInstallScripts from '../../package-install-scripts.js';
import PackageCompatibility from '../../package-compatibility.js';
import PackageResolver from '../../package-resolver.js';
import PackageLinker from '../../package-linker.js';
import PackageRequest from '../../package-request.js';
import {registries} from '../../registries/index.js';
import {clean} from './clean.js';
import * as constants from '../../constants.js';
import * as fs from '../../util/fs.js';
import map from '../../util/map.js';

const invariant = require('invariant');
const semver = require('semver');
const emoji = require('node-emoji');
const isCI = require('is-ci');
const path = require('path');

const {version: YARN_VERSION, installationMethod: YARN_INSTALL_METHOD} = require('../../../package.json');
const ONE_DAY = 1000 * 60 * 60 * 24;

export type InstallCwdRequest = {
  requests: DependencyRequestPatterns,
  patterns: Array<string>,
  ignorePatterns: Array<string>,
  usedPatterns: Array<string>,
  manifest: Object,
};

type Flags = {
  // install
  har: boolean,
  ignorePlatform: boolean,
  ignoreEngines: boolean,
  ignoreScripts: boolean,
  ignoreOptional: boolean,
  linkDuplicates: boolean,
  force: boolean,
  flat: boolean,
  lockfile: boolean,
  pureLockfile: boolean,
  skipIntegrityCheck: boolean,
  checkFiles: boolean,

  // add
  peer: boolean,
  dev: boolean,
  optional: boolean,
  exact: boolean,
  tilde: boolean,
};

/**
 * Try and detect the installation method for Yarn and provide a command to update it with.
 */

function getUpdateCommand(): ?string {
  if (YARN_INSTALL_METHOD === 'tar') {
    return `curl -o- -L ${constants.YARN_INSTALLER_SH} | bash`;
  }

  if (YARN_INSTALL_METHOD === 'homebrew') {
    return 'brew upgrade yarn';
  }

  if (YARN_INSTALL_METHOD === 'deb') {
    return 'sudo apt-get update && sudo apt-get install yarn';
  }

  if (YARN_INSTALL_METHOD === 'rpm') {
    return 'sudo yum install yarn';
  }

  if (YARN_INSTALL_METHOD === 'npm') {
    return 'npm upgrade --global yarn';
  }

  if (YARN_INSTALL_METHOD === 'chocolatey') {
    return 'choco upgrade yarn';
  }

  if (YARN_INSTALL_METHOD === 'apk') {
    return 'apk update && apk add -u yarn';
  }

  return null;
}

function getUpdateInstaller(): ?string {
  // Windows
  if (YARN_INSTALL_METHOD === 'msi') {
    return constants.YARN_INSTALLER_MSI;
  }

  return null;
}

function normalizeFlags(config: Config, rawFlags: Object): Flags {
  const flags = {
    // install
    har: !!rawFlags.har,
    ignorePlatform: !!rawFlags.ignorePlatform,
    ignoreEngines: !!rawFlags.ignoreEngines,
    ignoreScripts: !!rawFlags.ignoreScripts,
    ignoreOptional: !!rawFlags.ignoreOptional,
    force: !!rawFlags.force,
    flat: !!rawFlags.flat,
    lockfile: rawFlags.lockfile !== false,
    pureLockfile: !!rawFlags.pureLockfile,
    skipIntegrityCheck: !!rawFlags.skipIntegrityCheck,
    frozenLockfile: !!rawFlags.frozenLockfile,
    linkDuplicates: !!rawFlags.linkDuplicates,
    checkFiles: !!rawFlags.checkFiles,

    // add
    peer: !!rawFlags.peer,
    dev: !!rawFlags.dev,
    optional: !!rawFlags.optional,
    exact: !!rawFlags.exact,
    tilde: !!rawFlags.tilde,
  };

  if (config.getOption('ignore-scripts')) {
    flags.ignoreScripts = true;
  }

  if (config.getOption('ignore-platform')) {
    flags.ignorePlatform = true;
  }

  if (config.getOption('ignore-engines')) {
    flags.ignoreEngines = true;
  }

  if (config.getOption('ignore-optional')) {
    flags.ignoreOptional = true;
  }

  if (config.getOption('force')) {
    flags.force = true;
  }

  return flags;
}

export class Install {
  constructor(
    flags: Object,
    config: Config,
    reporter: Reporter,
    lockfile: Lockfile,
  ) {
    this.rootManifestRegistries = [];
    this.rootPatternsToOrigin = map();
    this.resolutions = map();
    this.lockfile = lockfile;
    this.reporter = reporter;
    this.config = config;
    this.flags = normalizeFlags(config, flags);

    this.resolver = new PackageResolver(config, lockfile);
    this.fetcher = new PackageFetcher(config, this.resolver);
    this.integrityChecker = new InstallationIntegrityChecker(config, this.reporter);
    this.compatibility = new PackageCompatibility(config, this.resolver, this.flags.ignoreEngines);
    this.linker = new PackageLinker(config, this.resolver);
    this.scripts = new PackageInstallScripts(config, this.resolver, this.flags.force);
  }

  flags: Flags;
  rootManifestRegistries: Array<RegistryNames>;
  registries: Array<RegistryNames>;
  lockfile: Lockfile;
  resolutions: { [packageName: string]: string };
  config: Config;
  reporter: Reporter;
  resolver: PackageResolver;
  scripts: PackageInstallScripts;
  linker: PackageLinker;
  compatibility: PackageCompatibility;
  fetcher: PackageFetcher;
  rootPatternsToOrigin: { [pattern: string]: string };
  integrityChecker: InstallationIntegrityChecker;

  /**
   * Create a list of dependency requests from the current directories manifests.
   */

  async fetchRequestFromCwd(
    excludePatterns?: Array<string> = [],
    ignoreUnusedPatterns?: boolean = false,
  ): Promise<InstallCwdRequest> {
    const patterns = [];
    const deps = [];
    const manifest = {};

    const ignorePatterns = [];
    const usedPatterns = [];

    // exclude package names that are in install args
    const excludeNames = [];
    for (const pattern of excludePatterns) {
      // can't extract a package name from this
      if (PackageRequest.getExoticResolver(pattern)) {
        continue;
      }

      // extract the name
      const parts = PackageRequest.normalizePattern(pattern);
      excludeNames.push(parts.name);
    }

    for (const registry of Object.keys(registries)) {
      const {filename} = registries[registry];
      const loc = path.join(this.config.cwd, filename);
      if (!(await fs.exists(loc))) {
        continue;
      }

      this.rootManifestRegistries.push(registry);
      const json = await this.config.readJson(loc);
      await normalizeManifest(json, this.config.cwd, this.config, true);

      Object.assign(this.resolutions, json.resolutions);
      Object.assign(manifest, json);

      const pushDeps = (depType, {hint, optional}, isUsed) => {
        if (ignoreUnusedPatterns && !isUsed) {
          return;
        }
        const depMap = json[depType];
        for (const name in depMap) {
          if (excludeNames.indexOf(name) >= 0) {
            continue;
          }

          let pattern = name;
          if (!this.lockfile.getLocked(pattern, true)) {
            // when we use --save we save the dependency to the lockfile with just the name rather than the
            // version combo
            pattern += '@' + depMap[name];
          }

          if (isUsed) {
            usedPatterns.push(pattern);
          } else {
            ignorePatterns.push(pattern);
          }

          this.rootPatternsToOrigin[pattern] = depType;
          patterns.push(pattern);
          deps.push({pattern, registry, hint, optional});
        }
      };

      pushDeps('dependencies', {hint: null, optional: false}, true);
      pushDeps('devDependencies', {hint: 'dev', optional: false}, !this.config.production);
      pushDeps('optionalDependencies', {hint: 'optional', optional: true}, !this.flags.ignoreOptional);

      break;
    }

    // inherit root flat flag
    if (manifest.flat) {
      this.flags.flat = true;
    }

    return {
      requests: deps,
      patterns,
      manifest,
      usedPatterns,
      ignorePatterns,
    };
  }

  /**
   * TODO description
   */

  prepareRequests(requests: DependencyRequestPatterns): DependencyRequestPatterns {
    return requests;
  }

  preparePatterns(
    patterns: Array<string>,
  ): Array<string> {
    return patterns;
  }

  async bailout(
    patterns: Array<string>,
  ): Promise<boolean> {
    if (this.flags.skipIntegrityCheck || this.flags.force) {
      return false;
    }
    const lockfileCache = this.lockfile.cache;
    if (!lockfileCache) {
      return false;
    }
    const match = await this.integrityChecker.check(patterns, lockfileCache, this.flags);
    if (this.flags.frozenLockfile && match.missingPatterns.length > 0) {
      throw new MessageError(this.reporter.lang('frozenLockfileError'));
    }

    const haveLockfile = await fs.exists(path.join(this.config.cwd, constants.LOCKFILE_FILENAME));

    if (match.integrityMatches && haveLockfile) {
      this.reporter.success(this.reporter.lang('upToDate'));
      return true;
    }

    if (!patterns.length && !match.integrityFileMissing) {
      this.reporter.success(this.reporter.lang('nothingToInstall'));
      await this.createEmptyManifestFolders();
      await this.saveLockfileAndIntegrity(patterns);
      return true;
    }

    return false;
  }

  /**
   * Produce empty folders for all used root manifests.
   */

  async createEmptyManifestFolders(): Promise<void> {
    if (this.config.modulesFolder) {
      // already created
      return;
    }

    for (const registryName of this.rootManifestRegistries) {
      const {folder} = this.config.registries[registryName];
      await fs.mkdirp(path.join(this.config.cwd, folder));
    }
  }

  /**
   * TODO description
   */

  markIgnored(patterns: Array<string>) {
    for (const pattern of patterns) {
      const manifest = this.resolver.getStrictResolvedPattern(pattern);
      const ref = manifest._reference;
      invariant(ref, 'expected package reference');

      if (ref.requests.length === 1) {
        // this module was only depended on once by the root so we can safely ignore it
        // if it was requested more than once then ignoring it would break a transitive
        // dep that resolved to it
        ref.ignore = true;
      }
    }
  }

  /**
   * TODO description
   */

  async init(): Promise<Array<string>> {
    this.checkUpdate();

    // warn if we have a shrinkwrap
    if (await fs.exists(path.join(this.config.cwd, 'npm-shrinkwrap.json'))) {
      this.reporter.warn(this.reporter.lang('shrinkwrapWarning'));
    }


    let flattenedTopLevelPatterns: Array<string> = [];
    const steps: Array<(curr: number, total: number) => Promise<{bailout: boolean} | void>> = [];
    const {
      requests: depRequests,
      patterns: rawPatterns,
      ignorePatterns,
      usedPatterns,
    } = await this.fetchRequestFromCwd();
    let topLevelPatterns: Array<string> = [];

    steps.push(async (curr: number, total: number) => {
      this.reporter.step(curr, total, this.reporter.lang('resolvingPackages'), emoji.get('mag'));
      await this.resolver.init(this.prepareRequests(depRequests), this.flags.flat);
      topLevelPatterns = this.preparePatterns(rawPatterns);
      flattenedTopLevelPatterns = await this.flatten(topLevelPatterns);
      return {bailout: await this.bailout(usedPatterns)};
    });

    steps.push(async (curr: number, total: number) => {
      this.markIgnored(ignorePatterns);
      this.reporter.step(curr, total, this.reporter.lang('fetchingPackages'), emoji.get('truck'));
      await this.fetcher.init();
      await this.compatibility.init();
    });

    steps.push(async (curr: number, total: number) => {
      // remove integrity hash to make this operation atomic
      await this.integrityChecker.removeIntegrityFile();
      this.reporter.step(curr, total, this.reporter.lang('linkingDependencies'), emoji.get('link'));
      await this.linker.init(flattenedTopLevelPatterns, this.flags.linkDuplicates);
    });

    steps.push(async (curr: number, total: number) => {
      this.reporter.step(
        curr,
        total,
        this.flags.force ? this.reporter.lang('rebuildingPackages') : this.reporter.lang('buildingFreshPackages'),
        emoji.get('page_with_curl'),
      );

      if (this.flags.ignoreScripts) {
        this.reporter.warn(this.reporter.lang('ignoredScripts'));
      } else {
        await this.scripts.init(flattenedTopLevelPatterns);
      }
    });

    if (this.flags.har) {
      steps.push(async (curr: number, total: number) => {
        const formattedDate = new Date().toISOString().replace(/:/g, '-');
        const filename = `yarn-install_${formattedDate}.har`;
        this.reporter.step(
          curr,
          total,
          this.reporter.lang('savingHar', filename),
          emoji.get('black_circle_for_record'),
        );
        await this.config.requestManager.saveHar(filename);
      });
    }

    if (await this.shouldClean()) {
      steps.push(async (curr: number, total: number) => {
        this.reporter.step(curr, total, this.reporter.lang('cleaningModules'), emoji.get('recycle'));
        await clean(this.config, this.reporter);
      });
    }

    let currentStep = 0;
    for (const step of steps) {
      const stepResult = await step(++currentStep, steps.length);
      if (stepResult && stepResult.bailout) {
        return flattenedTopLevelPatterns;
      }
    }

    // fin!
    await this.saveLockfileAndIntegrity(topLevelPatterns);
    this.maybeOutputUpdate();
    this.config.requestManager.clearCache();
    return flattenedTopLevelPatterns;
  }

  /**
   * Check if we should run the cleaning step.
   */

  shouldClean(): Promise<boolean> {
    return fs.exists(path.join(this.config.cwd, constants.CLEAN_FILENAME));
  }

  /**
   * TODO
   */

  async flatten(patterns: Array<string>): Promise<Array<string>> {
    if (!this.flags.flat) {
      return patterns;
    }

    const flattenedPatterns = [];

    for (const name of this.resolver.getAllDependencyNamesByLevelOrder(patterns)) {
      const infos = this.resolver.getAllInfoForPackageName(name).filter((manifest: Manifest): boolean => {
        const ref = manifest._reference;
        invariant(ref, 'expected package reference');
        return !ref.ignore;
      });

      if (infos.length === 0) {
        continue;
      }

      if (infos.length === 1) {
        // single version of this package
        // take out a single pattern as multiple patterns may have resolved to this package
        flattenedPatterns.push(this.resolver.patternsByPackage[name][0]);
        continue;
      }

      const options = infos.map((info): ReporterSelectOption => {
        const ref = info._reference;
        invariant(ref, 'expected reference');
        return {
          // TODO `and is required by {PARENT}`,
          name: this.reporter.lang('manualVersionResolutionOption', ref.patterns.join(', '), info.version),

          value: info.version,
        };
      });
      const versions = infos.map((info): string => info.version);
      let version: ?string;

      const resolutionVersion = this.resolutions[name];
      if (resolutionVersion && versions.indexOf(resolutionVersion) >= 0) {
        // use json `resolution` version
        version = resolutionVersion;
      } else {
        version = await this.reporter.select(
          this.reporter.lang('manualVersionResolution', name),
          this.reporter.lang('answer'),
          options,
        );
        this.resolutions[name] = version;
      }

      flattenedPatterns.push(this.resolver.collapseAllVersionsOfPackage(name, version));
    }

    // save resolutions to their appropriate root manifest
    if (Object.keys(this.resolutions).length) {
      const manifests = await this.config.getRootManifests();

      for (const name in this.resolutions) {
        const version = this.resolutions[name];

        const patterns = this.resolver.patternsByPackage[name];
        if (!patterns) {
          continue;
        }

        let manifest;
        for (const pattern of patterns) {
          manifest = this.resolver.getResolvedPattern(pattern);
          if (manifest) {
            break;
          }
        }
        invariant(manifest, 'expected manifest');

        const ref = manifest._reference;
        invariant(ref, 'expected reference');

        const object = manifests[ref.registry].object;
        object.resolutions = object.resolutions || {};
        object.resolutions[name] = version;
      }

      await this.config.saveRootManifests(manifests);
    }

    return flattenedPatterns;
  }

  /**
   * Remove offline tarballs that are no longer required
   */

  async pruneOfflineMirror(lockfile: Object): Promise<void> {
    const mirror = this.config.getOfflineMirrorPath();
    if (!mirror) {
      return;
    }

    const requiredTarballs = new Set();
    for (const dependency in lockfile) {
      const resolved = lockfile[dependency].resolved;
      if (resolved) {
        requiredTarballs.add(path.basename(resolved.split('#')[0]));
      }
    }

    const mirrorTarballs = await fs.walk(mirror);
    for (const tarball of mirrorTarballs) {
      if (!requiredTarballs.has(tarball.basename)) {
        await fs.unlink(tarball.absolute);
      }
    }
  }

  /**
   * Save updated integrity and lockfiles.
   */

  async saveLockfileAndIntegrity(patterns: Array<string>): Promise<void> {
    // --no-lockfile or --pure-lockfile flag
    if (this.flags.lockfile === false || this.flags.pureLockfile) {
      return;
    }

    const lockfileBasedOnResolver = this.lockfile.getLockfile(this.resolver.patterns);

    if (this.config.pruneOfflineMirror) {
      await this.pruneOfflineMirror(lockfileBasedOnResolver);
    }

    // write integrity hash
    await this.integrityChecker.save(patterns, lockfileBasedOnResolver, this.flags, this.resolver.usedRegistries);

    const lockFileHasAllPatterns = patterns.filter((p) => !this.lockfile.getLocked(p)).length === 0;
    const resolverPatternsAreSameAsInLockfile = Object.keys(lockfileBasedOnResolver)
      .filter((pattern) => {
        const manifest = this.lockfile.getLocked(pattern);
        return !manifest || manifest.resolved !== lockfileBasedOnResolver[pattern].resolved;
      },
    ).length === 0;

    // remove command is followed by install with force, lockfile will be rewritten in any case then
    if (lockFileHasAllPatterns && resolverPatternsAreSameAsInLockfile && patterns.length && !this.flags.force) {
      return;
    }

    // build lockfile location
    const loc = path.join(this.config.cwd, constants.LOCKFILE_FILENAME);

    // write lockfile
    const lockSource = lockStringify(lockfileBasedOnResolver);
    await fs.writeFilePreservingEol(loc, lockSource);

    this._logSuccessSaveLockfile();
  }

  _logSuccessSaveLockfile() {
    this.reporter.success(this.reporter.lang('savedLockfile'));
  }

  /**
   * Load the dependency graph of the current install. Only does package resolving and wont write to the cwd.
   */
  async hydrate(fetch?: boolean, ignoreUnusedPatterns?: boolean): Promise<InstallCwdRequest> {
    const request = await this.fetchRequestFromCwd([], ignoreUnusedPatterns);
    const {requests: depRequests, patterns: rawPatterns, ignorePatterns} = request;

    await this.resolver.init(depRequests, this.flags.flat);
    await this.flatten(rawPatterns);
    this.markIgnored(ignorePatterns);

    if (fetch) {
      // fetch packages, should hit cache most of the time
      await this.fetcher.init();
      await this.compatibility.init();

      // expand minimal manifests
      for (const manifest of this.resolver.getManifests()) {
        const ref = manifest._reference;
        invariant(ref, 'expected reference');

        const loc = this.config.generateHardModulePath(ref);
        const newPkg = await this.config.readManifest(loc);
        await this.resolver.updateManifest(ref, newPkg);
      }
    }

    return request;
  }

  /**
   * Check for updates every day and output a nag message if there's a newer version.
   */

  checkUpdate() {
    if (!process.stdout.isTTY || isCI) {
      // don't show upgrade dialog on CI or non-TTY terminals
      return;
    }

    // don't check if disabled
    if (this.config.getOption('disable-self-update-check')) {
      return;
    }

    // only check for updates once a day
    const lastUpdateCheck = Number(this.config.getOption('lastUpdateCheck')) || 0;
    if (lastUpdateCheck && Date.now() - lastUpdateCheck < ONE_DAY) {
      return;
    }

    // don't bug for updates on tagged releases
    if (YARN_VERSION.indexOf('-') >= 0) {
      return;
    }

    this._checkUpdate().catch(() => {
      // swallow errors
    });
  }

  async _checkUpdate(): Promise<void> {
    let latestVersion = await this.config.requestManager.request({
      url: constants.SELF_UPDATE_VERSION_URL,
    });
    invariant(typeof latestVersion === 'string', 'expected string');
    latestVersion = latestVersion.trim();
    if (!semver.valid(latestVersion)) {
      return;
    }

    // ensure we only check for updates periodically
    this.config.registries.yarn.saveHomeConfig({
      lastUpdateCheck: Date.now(),
    });

    if (semver.gt(latestVersion, YARN_VERSION)) {
      this.maybeOutputUpdate = () => {
        this.reporter.warn(this.reporter.lang('yarnOutdated', latestVersion, YARN_VERSION));

        const command = getUpdateCommand();
        if (command) {
          this.reporter.info(this.reporter.lang('yarnOutdatedCommand'));
          this.reporter.command(command);
        } else {
          const installer = getUpdateInstaller();
          if (installer) {
            this.reporter.info(this.reporter.lang('yarnOutdatedInstaller', installer));
          }
        }
      };
    }
  }

  /**
   * Method to override with a possible upgrade message.
   */

  maybeOutputUpdate() {}
  maybeOutputUpdate: any;
}

export function setFlags(commander: Object) {
  commander.usage('install [flags]');
  commander.option('-g, --global', 'DEPRECATED');
  commander.option('-S, --save', 'DEPRECATED - save package to your `dependencies`');
  commander.option('-D, --save-dev', 'DEPRECATED - save package to your `devDependencies`');
  commander.option('-P, --save-peer', 'DEPRECATED - save package to your `peerDependencies`');
  commander.option('-O, --save-optional', 'DEPRECATED - save package to your `optionalDependencies`');
  commander.option('-E, --save-exact', 'DEPRECATED');
  commander.option('-T, --save-tilde', 'DEPRECATED');
}

export async function run(
  config: Config,
  reporter: Reporter,
  flags: Object,
  args: Array<string>,
): Promise<void> {
  let lockfile;
  if (flags.lockfile === false) {
    lockfile = new Lockfile();
  } else {
    lockfile = await Lockfile.fromDirectory(config.cwd, reporter);
  }

  if (args.length) {
    const exampleArgs = args.slice();
    if (flags.saveDev) {
      exampleArgs.push('--dev');
    }
    if (flags.savePeer) {
      exampleArgs.push('--peer');
    }
    if (flags.saveOptional) {
      exampleArgs.push('--optional');
    }
    if (flags.saveExact) {
      exampleArgs.push('--exact');
    }
    if (flags.saveTilde) {
      exampleArgs.push('--tilde');
    }
    let command = 'add';
    if (flags.global) {
      command = 'global add';
    }
    throw new MessageError(reporter.lang('installCommandRenamed', `yarn ${command} ${exampleArgs.join(' ')}`));
  }

  await wrapLifecycle(config, flags, async () => {
    const install = new Install(flags, config, reporter, lockfile);
    await install.init();
  });
}

export async function wrapLifecycle(config: Config, flags: Object, factory: () => Promise<void>): Promise<void> {
  await config.executeLifecycleScript('preinstall');

  await factory();

  // npm behaviour, seems kinda funky but yay compatibility
  await config.executeLifecycleScript('install');
  await config.executeLifecycleScript('postinstall');

  if (!config.production) {
    await config.executeLifecycleScript('prepublish');
    await config.executeLifecycleScript('prepare');
  }
}
