/*!
 * Copyright (c) 2015-2026 Cisco Systems, Inc. See LICENSE file.
 */

import {CapabilityState, WebCapabilities} from '@webex/web-capabilities';
import EventsScope from '../common/events/events-scope';
import LoggerProxy from '../common/logs/logger-proxy';
import {IP_VERSION, REACHABILITY} from '../constants';
import MeetingUtil from '../meeting/util';
import Metrics from '../metrics';
import BEHAVIORAL_METRICS from '../metrics/constants';
import OrpheusLoader from './orpheus-loader';
import type {OrpheusFacade, OrpheusLogLevel} from './orpheus.types';
import ReachabilityRequest from './request';
import type {ClusterList} from './request';
import {NatType} from './reachability.types';
import type {
  ClientMediaPreferences,
  GetClustersTrigger,
  Protocol,
  ReachabilityMetrics,
  ReachabilityReportV0,
  ReachabilityReportV1,
  ReachabilityResults,
  ReachabilityResultsForBackend,
  TransportResult,
} from './reachability.types';
import {isReachabilityEnabled, resolveReachabilityProtocols} from './util';

const protocols: Protocol[] = ['udp', 'tcp', 'xtls'];
const READINESS_TIMEOUT_MS = 3000;

/**
 * Preserves the Meetings reachability contract while Orpheus owns discovery and probes.
 * @class Reachability
 * @export
 */
export default class Reachability extends EventsScope {
  namespace = REACHABILITY.namespace;
  webex: any;
  reachabilityRequest: ReachabilityRequest;
  minRequiredClusters?: number;
  orpheusApiVersion?: number;
  natType = NatType.Unknown;
  totalDuration?: number;
  protected lastTrigger?: string;
  private facade?: OrpheusFacade;
  private loading?: Promise<OrpheusFacade>;
  private run?: Promise<ReachabilityResults>;
  private waiting?: Promise<ReachabilityResults>;
  private settleWaiting?: (value?: ReachabilityResults) => void;
  private readinessTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private closed = false;
  private hybridClusters = new Set<string>();
  private results?: ReachabilityResults;
  private joinCookie?: unknown;
  private readonly discard = () => this.shutdown();

  /**
   * Construct the compatibility controller without starting browser work.
   * @param {*} webex - Webex SDK host.
   */
  constructor(webex: object) {
    super();
    this.webex = webex;
    this.reachabilityRequest = new ReachabilityRequest(webex);
  }

  /**
   * Load one packaged Orpheus facade for this SDK instance.
   * @returns {Promise<OrpheusFacade>} The browser facade.
   */
  private async getFacade(): Promise<OrpheusFacade> {
    if (this.closed) throw new Error('Reachability has been shut down');
    if (!this.loading) {
      const {generation} = this;
      this.loading = OrpheusLoader.load()
        .then(({OrpheusReachability}) => {
          if (this.closed || generation !== this.generation)
            throw new Error('Reachability initialization retired');
          const routeUrl = this.webex.internal.services.get('calliopeDiscovery');
          const browserOrigin = globalThis.location?.origin ?? globalThis.window?.location?.origin;
          const pageOrigin =
            browserOrigin && browserOrigin !== 'null' ? browserOrigin : new URL(routeUrl).origin;
          const appType = this.webex.config?.support?.appType;
          const appVersion = this.webex.config?.support?.appVersion;
          const facade = new OrpheusReachability({
            routeUrl: routeUrl ?? new URL('/calliope/api/', pageOrigin).href,
            pageOrigin,
            getBearer: async () => (await this.webex.credentials.getUserToken()).access_token,
            fetchImpl: (input, init) => this.fetchDiscovery(input, init),
            getIpVersion: () => MeetingUtil.getIpVersion(this.webex),
            getClientEnvironment:
              appType && appVersion ? () => ({components: {[appType]: appVersion}}) : undefined,
            logger: this.webex.logger ?? LoggerProxy.logger,
            logLevel: this.webex.config.meetings.orpheusReachabilityLogLevel ?? 'warn',
          });
          facade.on('reachability:firstResultAvailable', (payload) => {
            this.emit(
              {file: 'reachability', function: 'firstResult'},
              'reachability:firstResultAvailable',
              payload
            );
          });
          this.facade = facade;
          globalThis.window?.addEventListener('pagehide', this.discard, {once: true});

          return facade;
        })
        .catch((error) => {
          this.loading = undefined;
          throw error;
        });
    }

    return this.loading;
  }

  /**
   * Route the SDK-owned discovery request through Webex authentication and interceptors.
   * @param {*} input - Logical discovery URL.
   * @param {*} init - Fetch request options.
   * @returns {Promise<Response>} Discovery response with configured transport policy applied.
   */
  private async fetchDiscovery(
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> {
    const {generation} = this;
    const resource = new URL(String(input)).pathname.split('/').pop();
    if (resource !== 'clusters' && resource !== 'publicClusters')
      throw new Error('Unsupported discovery resource');
    const body =
      init.body == null
        ? undefined
        : JSON.parse(
            init.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : String(init.body)
          );
    const request = () =>
      this.webex.request({
        api: 'calliopeDiscovery',
        resource,
        method: init.method ?? 'POST',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body,
        signal: init.signal,
        shouldRefreshAccessToken: false,
        timeout: this.webex.config.meetings.reachabilityGetClusterTimeout,
      });
    const latency = this.webex.internal.newMetrics?.callDiagnosticLatencies;
    const response =
      body?.trigger === 'startup' && latency
        ? await latency.measureLatency(request, 'internal.get.cluster.time')
        : await request();
    if (init.signal?.aborted || generation !== this.generation || this.closed) {
      throw new DOMException('Discovery request aborted', 'AbortError');
    }
    const data = response.body ?? {};
    if ((response.statusCode ?? response.status ?? 200) === 200) {
      this.minRequiredClusters = data.discoveryOptions?.['early-call-min-clusters'];
      this.orpheusApiVersion = data.discoveryOptions?.['report-version'];
      this.hybridClusters = new Set(data.clusterClasses?.hybridMedia ?? []);
      if (data.joinCookie !== undefined)
        await this.writeStorage(REACHABILITY.localStorageJoinCookie, data.joinCookie);
    }
    const enabled = resolveReachabilityProtocols(
      this.webex.config.meetings.enableReachabilityChecks
    );
    const clusters =
      data.clusters &&
      Object.fromEntries(
        Object.entries(data.clusters).map(([id, cluster]) => [
          id,
          {
            ...(cluster as object),
            ...(!enabled.tcp && {tcp: []}),
            ...(!enabled.tls && {xtls: []}),
          },
        ])
      );

    return new Response(JSON.stringify({...data, ...(clusters && {clusters})}), {
      status: response.statusCode ?? response.status ?? 200,
      headers: response.headers,
    });
  }

  /**
   * Gather reachability, retaining disabled, unsupported and completion semantics.
   * @param {*} trigger - Caller reason for the run.
   * @returns {Promise<Object>} Empty object on skipped/failed work; undefined on completed work.
   */
  public async gatherReachability(trigger: string): Promise<ReachabilityResults> {
    if (!isReachabilityEnabled(this.webex.config.meetings.enableReachabilityChecks)) {
      throw new Error('enableReachabilityChecks is disabled in config');
    }
    if (
      WebCapabilities.supportsRTCPeerConnection() !== CapabilityState.CAPABLE ||
      typeof globalThis.Worker !== 'function'
    )
      return {};
    if (this.run) return this.waiting ?? this.run;
    this.lastTrigger = trigger;
    this.generation += 1;
    const {generation} = this;
    this.waiting = new Promise((resolve) => {
      this.settleWaiting = resolve;
    });
    const {waiting} = this;
    this.readinessTimer = setTimeout(() => {
      if (generation === this.generation) this.releaseWaiting();
    }, READINESS_TIMEOUT_MS);
    this.run = this.gather(trigger, generation).then((value) => {
      if (generation === this.generation) {
        this.run = undefined;
        this.releaseWaiting(value);
      }

      return value;
    });

    return waiting;
  }

  /**
   * Release registration readiness while allowing the SDK's full gather to continue.
   * @param {*} value - Legacy gather completion value.
   * @returns {void}
   */
  private releaseWaiting(value?: ReachabilityResults): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = undefined;
    this.settleWaiting?.(value);
    this.settleWaiting = undefined;
  }

  /**
   * Run and persist one correlated gather, ignoring work retired by stop.
   * @param {*} trigger - Caller reason.
   * @param {*} generation - Local run generation.
   * @returns {Promise<Object>} Legacy gather completion.
   */
  private async gather(trigger: string, generation: number): Promise<ReachabilityResults> {
    try {
      const detector = this.webex.internal.device?.ipNetworkDetector;
      Promise.resolve(detector?.detect(true)).catch(() => {});
      const facade = await this.getFacade();
      if (generation !== this.generation) return undefined;
      await facade.gatherReachability(trigger);
      if (generation !== this.generation) return undefined;
      const preferences = await facade.getClientMediaPreferences(
        true,
        MeetingUtil.getIpVersion(this.webex)
      );
      if (generation !== this.generation) return undefined;
      await this.storePreferences(preferences);
      if (generation !== this.generation) return undefined;
      this.emit({file: 'reachability', function: 'gatherReachability'}, 'reachability:done', {});
      await this.sendMetric();

      return undefined;
    } catch {
      if (generation !== this.generation) return undefined;
      LoggerProxy.logger.warn('Reachability: Orpheus gathering failed');

      return {};
    }
  }

  /**
   * Retain the direct discovery helper for existing advanced consumers.
   * @param {*} trigger - Discovery reason.
   * @param {*} previousReport - Previous report context.
   * @param {*} isRetry - Whether the single retry has already been attempted.
   * @returns {Promise<Object>} Cluster list and join cookie.
   */
  public async getClusters(
    trigger: GetClustersTrigger,
    previousReport?: unknown,
    isRetry = false
  ): Promise<{clusters: ClusterList; joinCookie: unknown}> {
    try {
      const response = await this.reachabilityRequest.getClusters(
        trigger,
        MeetingUtil.getIpVersion(this.webex),
        previousReport
      );
      this.minRequiredClusters = response.discoveryOptions?.['early-call-min-clusters'];
      this.orpheusApiVersion = response.discoveryOptions?.['report-version'];
      await this.writeStorage(REACHABILITY.localStorageJoinCookie, response.joinCookie);

      return response;
    } catch (error) {
      if (isRetry) throw error;

      return this.getClusters(trigger, previousReport, true);
    }
  }

  /**
   * Request a fresh SDK-owned discovery run after stopping prior work.
   * @returns {Promise<void>} Completion of the fallback attempt.
   */
  public async gatherReachabilityFallback(): Promise<void> {
    this.stopReachability();
    await this.gatherReachability('early-call/no-min-reached').catch(() => {});
  }

  /**
   * Stop active probes and refresh work without discarding completed results.
   * @returns {void}
   */
  public stopReachability(): void {
    const active = !!this.run;
    this.generation += 1;
    this.run = undefined;
    this.releaseWaiting();
    this.waiting = undefined;
    this.facade?.stopReachability();
    if (active) {
      this.emit({file: 'reachability', function: 'stopReachability'}, 'reachability:stopped', {});
      this.sendMetric(true).catch(() => {});
    }
  }

  /**
   * Dispose the browser runtime and page listener exactly once.
   * @returns {void}
   */
  public shutdown(): void {
    if (this.closed) return;
    this.stopReachability();
    this.closed = true;
    this.facade?.shutdown();
    globalThis.window?.removeEventListener('pagehide', this.discard);
  }

  /**
   * Expose the SDK's sanitized diagnostics without raw results or credentials.
   * @returns {Object} Diagnostic counters and status.
   */
  public getDiagnostics(): Record<string, unknown> {
    return this.facade?.getDiagnostics() ?? {implementation: 'OrpheusReachability', ready: false};
  }

  /**
   * Configure Orpheus verbosity without bypassing the Webex logger.
   * @param {*} level - SDK diagnostic threshold.
   * @returns {void}
   */
  public setLogLevel(level: OrpheusLogLevel): void {
    if (!['silent', 'error', 'warn', 'info', 'debug'].includes(level)) {
      throw new TypeError('Invalid Orpheus log level');
    }
    this.webex.config.meetings.orpheusReachabilityLogLevel = level;
    this.facade?.setLogLevel(level);
  }

  /**
   * Read the configured Orpheus diagnostic threshold.
   * @returns {string} Current threshold, defaulting to warn.
   */
  public getLogLevel(): OrpheusLogLevel {
    return (
      this.facade?.getLogLevel() ?? this.webex.config.meetings.orpheusReachabilityLogLevel ?? 'warn'
    );
  }

  /**
   * Persist compatibility data without making cache availability a probe prerequisite.
   * @param {*} key - Reachability storage key.
   * @param {*} value - Value to serialize.
   * @returns {Promise<void>} Cache write completion.
   */
  private async writeStorage(key: string, value: unknown): Promise<void> {
    if (key === REACHABILITY.localStorageJoinCookie) this.joinCookie = value;
    try {
      await this.webex.boundedStorage.put(this.namespace, key, JSON.stringify(value));
    } catch {
      LoggerProxy.logger.warn('Reachability: unable to persist cached data');
    }
  }

  /**
   * Read live results first, then previously persisted legacy-compatible results.
   * @returns {Promise<Object>} Cached cluster results.
   */
  private async readResults(): Promise<ReachabilityResults> {
    if (this.results) return this.results;
    try {
      return (
        JSON.parse(
          await this.webex.boundedStorage.get(this.namespace, REACHABILITY.localStorageResult)
        ) ?? {}
      );
    } catch {
      return {};
    }
  }

  /**
   * Project the complete SDK report into the existing storage contract.
   * @param {*} preferences - SDK media preferences.
   * @returns {Promise<void>} Projection and cache write completion.
   */
  private async storePreferences(preferences: ClientMediaPreferences): Promise<void> {
    if (preferences.joinCookie !== undefined)
      await this.writeStorage(REACHABILITY.localStorageJoinCookie, preferences.joinCookie);
    const report = preferences.reachability;
    if (!report) return;
    this.totalDuration = report.result.metrics['total-duration-ms'];
    const results: ReachabilityResults = {};
    for (const [id, cluster] of Object.entries(report.result.tests)) {
      const convert = (protocol: Protocol): TransportResult => {
        const value = cluster[protocol];

        let result: TransportResult['result'] = 'untested';
        if (value.reachable === 'true') result = 'reachable';
        if (value.reachable === 'false') result = 'unreachable';

        return {
          result,
          ...(value.latencyInMilliseconds !== undefined && {
            latencyInMilliseconds: Number(value.latencyInMilliseconds),
          }),
          ...(value.clientMediaIPs && {clientMediaIPs: value.clientMediaIPs}),
        };
      };
      results[id] = {
        udp: convert('udp'),
        tcp: convert('tcp'),
        xtls: convert('xtls'),
        isVideoMesh: this.hybridClusters.has(id),
      };
    }
    this.results = results;
    await this.writeStorage(REACHABILITY.localStorageResult, results);
  }

  /**
   * Read the current discovery cookie or a previously persisted cookie.
   * @returns {Promise<*>} Join cookie, if available.
   */
  public async getJoinCookie(): Promise<unknown> {
    if (this.joinCookie !== undefined) return this.joinCookie;
    try {
      return JSON.parse(
        await this.webex.boundedStorage.get(this.namespace, REACHABILITY.localStorageJoinCookie)
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Convert cached transport outcomes into the backend's string-valued format.
   * @returns {Promise<Object>} Complete cluster matrix, or undefined when no result exists.
   */
  public async getReachabilityResults(): Promise<ReachabilityResultsForBackend | undefined> {
    const results = await this.readResults();
    if (!Object.keys(results).length) return undefined;

    return Object.fromEntries(
      Object.entries(results).map(([id, cluster]) => [
        id,
        Object.fromEntries(
          protocols.map((protocol) => {
            const value = cluster[protocol] ?? {result: 'untested'};

            return [
              protocol,
              {
                ...(value.result === 'untested'
                  ? {untested: 'true'}
                  : {reachable: value.result === 'reachable' ? 'true' : 'false'}),
                ...(value.latencyInMilliseconds !== undefined && {
                  latencyInMilliseconds: String(value.latencyInMilliseconds),
                }),
                ...(value.clientMediaIPs && {clientMediaIPs: value.clientMediaIPs}),
              },
            ];
          })
        ),
      ])
    ) as ReachabilityResultsForBackend;
  }

  /**
   * Format the negotiated version-zero or version-one report.
   * @returns {Promise<Object>} Versioned reachability report.
   */
  public async getReachabilityReport(): Promise<{
    joinCookie?: unknown;
    reachability?: ReachabilityReportV0 | ReachabilityReportV1;
  }> {
    const tests = await this.getReachabilityResults();
    if (!this.orpheusApiVersion) return {reachability: tests};

    return {
      joinCookie: await this.getJoinCookie(),
      reachability: {
        version: 1,
        result: {
          usedDiscoveryOptions: {'early-call-min-clusters': this.minRequiredClusters},
          metrics: {'total-duration-ms': this.totalDuration},
          tests,
        },
      },
    };
  }

  /**
   * Read real SDK preferences and preserve the negotiated report placement.
   * @param {*} isMultistream - Whether multistream is enabled.
   * @param {*} ipver - Detected IP version, if known.
   * @returns {Promise<Object>} Client media preferences for Locus.
   */
  public async getClientMediaPreferences(
    isMultistream: boolean,
    ipver?: IP_VERSION
  ): Promise<ClientMediaPreferences> {
    if (this.facade && isReachabilityEnabled(this.webex.config.meetings.enableReachabilityChecks)) {
      const preferences = await this.facade.getClientMediaPreferences(isMultistream, ipver);
      await this.storePreferences(preferences);
    }
    if (!this.orpheusApiVersion)
      return {ipver, preferTranscoding: !isMultistream, joinCookie: await this.getJoinCookie()};

    return {
      ipver,
      preferTranscoding: !isMultistream,
      ...(await this.getReachabilityReport()),
    } as ClientMediaPreferences;
  }

  /**
   * Attach reachability to ROAP only for version-zero discovery.
   * @returns {Promise<Object>} Version-zero report or undefined.
   */
  public async getReachabilityReportToAttachToRoap(): Promise<ReachabilityReportV0 | undefined> {
    return this.orpheusApiVersion ? undefined : this.getReachabilityResults();
  }

  /**
   * Check successful SDK probes for a selected subnet.
   * @param {*} subnet - Selected server's first IPv4 octet.
   * @returns {boolean} Whether a matching endpoint was reached.
   */
  public isSubnetReachable(subnet: string): boolean | null {
    return this.facade?.isSubnetReachable(subnet) ?? false;
  }

  /**
   * Check public UDP/TCP success, excluding video-mesh-only results.
   * @returns {Promise<boolean>} Whether any public cluster is reachable.
   */
  public async isAnyPublicClusterReachable(): Promise<boolean> {
    return Object.values(await this.readResults()).some(
      (cluster) =>
        !cluster.isVideoMesh &&
        (cluster.udp?.result === 'reachable' || cluster.tcp?.result === 'reachable')
    );
  }

  /**
   * Check measured success for the requested transport.
   * @param {*} protocol - UDP, TCP or xTLS transport.
   * @returns {Promise<boolean>} Whether any cluster was reached using the transport.
   */
  public async isAnyClusterReachableViaProtocol(protocol: Protocol): Promise<boolean> {
    return Object.values(await this.readResults()).some(
      (cluster) => cluster[protocol]?.result === 'reachable'
    );
  }

  /**
   * Report a fully unreachable backend only when every transport was tested.
   * @returns {Promise<boolean>} Whether every tested transport failed.
   */
  public async isWebexMediaBackendUnreachable(): Promise<boolean> {
    const results = Object.values(await this.readResults());

    return protocols.every(
      (protocol) =>
        results.some((cluster) =>
          ['reachable', 'unreachable'].includes(cluster[protocol]?.result)
        ) && results.every((cluster) => cluster[protocol]?.result !== 'reachable')
    );
  }

  /**
   * Preserve public/video-mesh outcome counts and the NAT-type metric.
   * @returns {Promise<Object>} Existing metric fields.
   */
  public async getReachabilityMetrics(): Promise<ReachabilityMetrics> {
    const metrics = {natType: this.natType} as ReachabilityMetrics;
    for (const clusterType of ['public', 'vmn']) {
      for (const protocol of protocols) {
        metrics[`reachability_${clusterType}_${protocol}_success`] = 0;
        metrics[`reachability_${clusterType}_${protocol}_failed`] = 0;
      }
    }
    for (const cluster of Object.values(await this.readResults())) {
      for (const protocol of protocols) {
        if (cluster[protocol] && cluster[protocol].result !== 'untested') {
          const outcome = cluster[protocol].result === 'reachable' ? 'success' : 'failed';
          metrics[
            `reachability_${cluster.isVideoMesh ? 'vmn' : 'public'}_${protocol}_${outcome}`
          ] += 1;
        }
      }
    }

    return metrics;
  }

  /**
   * Publish the existing completion statistics without sensitive discovery data.
   * @param {*} aborted - Whether the run was stopped.
   * @returns {Promise<void>} Metric submission attempt.
   */
  protected async sendMetric(aborted = false): Promise<void> {
    try {
      const results = Object.values(await this.readResults());
      const statistics = (protocol: Protocol, isVideoMesh: boolean) => {
        const values = results
          .filter(
            (result) =>
              !!result.isVideoMesh === isVideoMesh && result[protocol]?.result === 'reachable'
          )
          .map((result) => result[protocol].latencyInMilliseconds)
          .filter(Number.isFinite);

        return values.length
          ? {
              min: Math.min(...values),
              max: Math.max(...values),
              average: values.reduce((a, b) => a + b, 0) / values.length,
            }
          : {min: -1, max: -1, average: -1};
      };
      const detector = this.webex.internal.device?.ipNetworkDetector;
      Metrics.sendBehavioralMetric(
        BEHAVIORAL_METRICS.REACHABILITY_COMPLETED,
        Metrics.prepareMetricFields({
          aborted,
          vmn: {udp: statistics('udp', true)},
          public: {
            udp: statistics('udp', false),
            tcp: statistics('tcp', false),
            xtls: statistics('xtls', false),
          },
          ipver: {
            firstIpV4: detector?.firstIpV4,
            firstIpV6: detector?.firstIpV6,
            firstMdns: detector?.firstMdns,
            totalTime: detector?.totalTime,
          },
          trigger: this.lastTrigger,
        })
      );
    } catch {
      LoggerProxy.logger.warn('Reachability: unable to record completion metric');
    }
  }
}
