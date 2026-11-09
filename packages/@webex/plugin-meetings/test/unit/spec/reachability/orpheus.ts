import 'jsdom-global/register';
import {assert} from '@webex/test-helper-chai';
import {CapabilityState, WebCapabilities} from '@webex/web-capabilities';
import {EventEmitter} from 'events';
import sinon from 'sinon';
import Reachability from '../../../../src/reachability';
import OrpheusLoader from '../../../../src/reachability/orpheus-loader';
import MeetingUtil from '../../../../src/meeting/util';
import LoggerProxy from '../../../../src/common/logs/logger-proxy';
import Metrics from '../../../../src/metrics';

describe('Orpheus-backed Meetings reachability', () => {
  let webex;
  let reachability;
  let facade;
  let options;
  let preferences;
  let discovery;
  let originalWorker;
  let loader;
  let storage;

  beforeEach(() => {
    facade = undefined;
    options = undefined;
    originalWorker = globalThis.Worker;
    globalThis.Worker = function Worker() {} as any;
    storage = new Map();
    const logger = {
      debug: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };
    sinon.stub(LoggerProxy, 'logger').value(logger);
    sinon.stub(MeetingUtil, 'getIpVersion').returns(4);
    sinon.stub(WebCapabilities, 'supportsRTCPeerConnection').returns(CapabilityState.CAPABLE);
    sinon.stub(Metrics, 'sendBehavioralMetric');
    webex = {
      config: {
        meetings: {enableReachabilityChecks: true, reachabilityGetClusterTimeout: 5000},
        support: {appType: 'WebClient', appVersion: 'test'},
      },
      logger,
      boundedStorage: {
        put: sinon.stub().callsFake(async (_namespace, key, value) => {
          storage.set(key, value);
        }),
        get: sinon.stub().callsFake(async (_namespace, key) => storage.get(key)),
      },
      credentials: {getUserToken: sinon.stub().resolves({access_token: 'synthetic-token'})},
      internal: {
        services: {get: sinon.stub().returns('https://discovery.example.test/calliope/api/')},
        device: {ipNetworkDetector: {detect: sinon.stub().resolves()}},
      },
      request: sinon.stub(),
    };
    const tests = Object.fromEntries(
      Array.from({length: 22}, (_, index) => [
        `c${index}`,
        {
          udp: {reachable: 'true', latencyInMilliseconds: '12'},
          tcp: {reachable: 'false'},
          xtls: {untested: 'true'},
        },
      ])
    );
    preferences = {
      ipver: 4,
      preferTranscoding: false,
      joinCookie: {id: 'synthetic-cookie'},
      reachability: {
        version: 1,
        result: {
          usedDiscoveryOptions: {'early-call-min-clusters': 1},
          metrics: {'total-duration-ms': 100},
          tests,
        },
      },
    };
    discovery = {
      clusters: {
        c0: {
          udp: ['stun:192.0.2.1:3478'],
          tcp: ['stun:192.0.2.1:5004'],
          xtls: ['stun:tls.example.test:443'],
        },
      },
      clusterClasses: {hybridMedia: ['c0']},
      discoveryOptions: {'report-version': 1, 'early-call-min-clusters': 1},
      joinCookie: preferences.joinCookie,
    };
    webex.request.resolves({statusCode: 200, body: discovery});
    class FakeFacade extends EventEmitter {
      constructor(value) {
        super();
        options = value;
        facade = this;
      }
      gatherReachability = sinon.stub().callsFake(async () => {
        await options.fetchImpl('https://app.example.test/calliope/api/discovery/v1/clusters', {
          method: 'POST',
          body: JSON.stringify({'supported-options': {'report-version': 1}, trigger: 'startup'}),
        });
      });
      getClientMediaPreferences = sinon.stub().callsFake(async (isMultistream, ipver) => ({
        ...preferences,
        ipver,
        preferTranscoding: !isMultistream,
      }));
      getReachabilityResults = sinon.stub().resolves(tests);
      stopReachability = sinon.stub();
      shutdown = sinon.stub();
      isSubnetReachable = sinon.stub().returns(true);
      getDiagnostics = sinon
        .stub()
        .returns({implementation: 'OrpheusReachability', ready: true, reportClusterCount: 22});
      getLogLevel = sinon.stub().returns('warn');
      setLogLevel = sinon.stub();
    }
    loader = sinon.stub(OrpheusLoader, 'load').resolves({OrpheusReachability: FakeFacade} as any);
    reachability = new Reachability(webex);
  });

  afterEach(() => {
    reachability.shutdown();
    globalThis.Worker = originalWorker;
    sinon.restore();
  });

  it('does not create a Worker or load Wasm merely by constructing Meetings reachability', () => {
    assert.notCalled(loader);
    assert.deepEqual(reachability.getDiagnostics(), {
      implementation: 'OrpheusReachability',
      ready: false,
    });
  });

  it('delegates discovery and gathering to Orpheus and stores all 22 clusters before completion', async () => {
    const completed = sinon.spy();
    reachability.on('reachability:done', completed);
    assert.isUndefined(await reachability.gatherReachability('registration'));
    assert.calledOnceWithExactly(facade.gatherReachability, 'registration');
    assert.calledOnce(completed);
    assert.equal(Object.keys(await reachability.getReachabilityResults()).length, 22);
    assert.equal(options.logLevel, 'warn');
    assert.strictEqual(options.logger, webex.logger);
    assert.equal(await options.getBearer(), 'synthetic-token');
    assert.deepEqual(options.getClientEnvironment(), {components: {WebClient: 'test'}});
  });

  it('forwards the SDK-owned request body through authenticated Webex routing', async () => {
    await reachability.gatherReachability('registration');
    const body = {
      'supported-options': {'test-repetitions': 3},
      'previous-report': {id: 'synthetic'},
      trigger: 'early-call/no-min-reached',
    };
    const controller = new AbortController();
    await options.fetchImpl('https://app.example.test/calliope/api/discovery/v1/clusters', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    assert.calledWithExactly(webex.request, {
      api: 'calliopeDiscovery',
      resource: 'clusters',
      method: 'POST',
      headers: {},
      body,
      signal: controller.signal,
      shouldRefreshAccessToken: false,
      timeout: 5000,
    });
  });

  it('preserves real preferences, cookie, IP-version and transcoding semantics without losing clusters', async () => {
    await reachability.gatherReachability('registration');
    const result = await reachability.getClientMediaPreferences(false, undefined);
    assert.equal(Object.keys(result.reachability.result.tests).length, 22);
    assert.deepEqual(result.joinCookie, preferences.joinCookie);
    assert.isTrue(result.preferTranscoding);
    assert.isUndefined(result.ipver);
    assert.isUndefined(await reachability.getReachabilityReportToAttachToRoap());
    assert.calledWithExactly(facade.getClientMediaPreferences, false, undefined);
  });

  it('keeps version-zero reports on ROAP rather than putting them in clientMediaPreferences', async () => {
    discovery.discoveryOptions['report-version'] = 0;
    await reachability.gatherReachability('registration');
    const result = await reachability.getClientMediaPreferences(true, 4);
    assert.notProperty(result, 'reachability');
    assert.equal(Object.keys(await reachability.getReachabilityReportToAttachToRoap()).length, 22);
  });

  it('preserves public/video-mesh metric distinctions and untested versus measured failure', async () => {
    await reachability.gatherReachability('registration');
    const metrics = await reachability.getReachabilityMetrics();
    assert.equal(metrics.reachability_vmn_udp_success, 1);
    assert.equal(metrics.reachability_public_udp_success, 21);
    assert.equal(metrics.reachability_public_tcp_failed, 21);
    assert.equal(metrics.reachability_public_xtls_failed, 0);
    assert.isTrue(await reachability.isAnyPublicClusterReachable());
    assert.isTrue(await reachability.isAnyClusterReachableViaProtocol('udp'));
    assert.isFalse(await reachability.isWebexMediaBackendUnreachable());
  });

  it('forwards first-result events on the existing event scope', async () => {
    await reachability.gatherReachability('registration');
    const first = sinon.spy();
    reachability.on('reachability:firstResultAvailable', first);
    facade.emit('reachability:firstResultAvailable', {protocol: 'udp'});
    assert.calledOnceWithExactly(first, {protocol: 'udp'});
  });

  it('honors disabled TCP/TLS policy without changing UDP endpoints', async () => {
    webex.config.meetings.enableReachabilityChecks = {tcp: false, tls: false};
    await reachability.gatherReachability('registration');
    const response = await options.fetchImpl(
      'https://app.example.test/calliope/api/discovery/v1/clusters'
    );
    const body = await response.json();
    assert.deepEqual(body.clusters.c0.udp, discovery.clusters.c0.udp);
    assert.deepEqual(body.clusters.c0.tcp, []);
    assert.deepEqual(body.clusters.c0.xtls, []);
    assert.deepEqual(discovery.clusters.c0.tcp, ['stun:192.0.2.1:5004']);
  });

  it('rejects disabled reachability and skips unsupported browsers before loading the runtime', async () => {
    webex.config.meetings.enableReachabilityChecks = false;
    await assert.isRejected(reachability.gatherReachability('registration'), /disabled in config/);
    webex.config.meetings.enableReachabilityChecks = true;
    globalThis.Worker = undefined;
    assert.deepEqual(await reachability.gatherReachability('registration'), {});
    assert.notCalled(loader);
  });

  it('coalesces overlapping gather calls and suppresses completion after stop', async () => {
    let finish;
    let started;
    const waitForStart = new Promise((resolve) => {
      started = resolve;
    });
    await reachability.gatherReachability('initial');
    facade.gatherReachability.callsFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        })
    );
    const done = sinon.spy();
    const stopped = sinon.spy();
    reachability.on('reachability:done', done);
    reachability.on('reachability:stopped', stopped);
    const first = reachability.gatherReachability('first');
    const second = reachability.gatherReachability('second');
    await waitForStart;
    reachability.stopReachability();
    finish({});
    await Promise.all([first, second]);
    assert.equal(facade.gatherReachability.callCount, 2);
    assert.calledOnce(stopped);
    assert.notCalled(done);
  });

  it('returns the legacy empty sentinel on runtime failure without logging sensitive exception text', async () => {
    loader.rejects(new Error('synthetic-secret-must-not-be-logged'));
    assert.deepEqual(await reachability.gatherReachability('registration'), {});
    assert.calledWithExactly(LoggerProxy.logger.warn, 'Reachability: Orpheus gathering failed');
  });

  it('retains live results and cookies when bounded storage is unavailable', async () => {
    webex.boundedStorage.put.rejects(new Error('cache unavailable'));
    webex.boundedStorage.get.rejects(new Error('cache unavailable'));
    await reachability.gatherReachability('registration');
    const result = await reachability.getClientMediaPreferences(true, 4);
    assert.equal(Object.keys(result.reachability.result.tests).length, 22);
    assert.deepEqual(result.joinCookie, preferences.joinCookie);
  });

  it('releases registration within the readiness window while the full gather continues', async () => {
    await reachability.gatherReachability('initial');
    const clock = sinon.useFakeTimers();
    let finish;
    facade.gatherReachability.callsFake(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const completed = sinon.spy();
    reachability.on('reachability:done', completed);
    const ready = reachability.gatherReachability('registration');
    await clock.tickAsync(3000);
    assert.isUndefined(await ready);
    assert.notCalled(completed);
    const done = new Promise((resolve) => reachability.once('reachability:done', resolve));
    finish({});
    await done;
    assert.calledOnce(completed);
  });

  it('does not start retired browser work when stopped during the module load', async () => {
    const module = await loader();
    let finishLoad;
    loader.callsFake(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    const pending = reachability.gatherReachability('registration');
    reachability.stopReachability();
    finishLoad(module);
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.isUndefined(facade);
  });

  it('shuts down the Worker on page disposal only once', async () => {
    await reachability.gatherReachability('registration');
    window.dispatchEvent(new window.Event('pagehide'));
    reachability.shutdown();
    assert.calledOnce(facade.shutdown);
  });

  it('does not let an aborted discovery response overwrite the current cookie', async () => {
    await reachability.gatherReachability('initial');
    let respond;
    webex.request.callsFake(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        })
    );
    const controller = new AbortController();
    const response = options.fetchImpl(
      'https://app.example.test/calliope/api/discovery/v1/clusters',
      {signal: controller.signal}
    );
    controller.abort();
    respond({statusCode: 200, body: {...discovery, joinCookie: {id: 'retired-cookie'}}});
    await assert.isRejected(response, /aborted/);
    assert.deepEqual(await reachability.getJoinCookie(), preferences.joinCookie);
  });

  it('allows explicit debug without changing the Webex logger and rejects invalid thresholds', async () => {
    reachability.setLogLevel('debug');
    await reachability.gatherReachability('registration');
    assert.equal(options.logLevel, 'debug');
    assert.strictEqual(options.logger, webex.logger);
    assert.throws(() => reachability.setLogLevel('invalid'), /Invalid Orpheus log level/);
  });
});
