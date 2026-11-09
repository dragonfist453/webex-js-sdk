import 'jsdom-global/register';
import {assert} from '@webex/test-helper-chai';
import MockWebex from '@webex/test-helper-mock-webex';
import sinon from 'sinon';
import Reachability from '@webex/plugin-meetings/src/reachability/';
import MeetingUtil from '@webex/plugin-meetings/src/meeting/util';

import {IP_VERSION} from '@webex/plugin-meetings/src/constants';
import {ReachabilityResultsForBackend} from '@webex/plugin-meetings/src/reachability/reachability.types';

describe('isAnyPublicClusterReachable', () => {
  let webex;

  beforeEach(() => {
    webex = new MockWebex();

    sinon.stub(MeetingUtil, 'getIpVersion').returns(IP_VERSION.unknown);
  });

  afterEach(() => {
    sinon.restore();
  });

  const checkIsClusterReachable = async (mockStorage: any, expectedValue: boolean) => {
    if (mockStorage) {
      await webex.boundedStorage.put(
        'Reachability',
        'reachability.result',
        JSON.stringify(mockStorage)
      );
    }
    const reachability = new Reachability(webex);

    const result = await reachability.isAnyPublicClusterReachable();

    assert.equal(result, expectedValue);
  };

  it('returns true when udp is reachable', async () => {
    await checkIsClusterReachable(
      {x: {udp: {result: 'reachable'}, tcp: {result: 'unreachable'}}},
      true
    );
  });

  it('returns true when tcp is reachable', async () => {
    await checkIsClusterReachable(
      {x: {udp: {result: 'unreachable'}, tcp: {result: 'reachable'}}},
      true
    );
  });

  it('returns true when both tcp and udp are reachable', async () => {
    await checkIsClusterReachable(
      {x: {udp: {result: 'reachable'}, tcp: {result: 'reachable'}}},
      true
    );
  });

  it('returns false when only xtls is reachable', async () => {
    await checkIsClusterReachable(
      {
        x: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'reachable'},
        },
      },
      false
    );
  });

  it('returns false when both tcp and udp are unreachable', async () => {
    await checkIsClusterReachable(
      {x: {udp: {result: 'unreachable'}, tcp: {result: 'unreachable'}}},
      false
    );
  });

  it('returns false when udp, tcp and xtls are all unreachable', async () => {
    await checkIsClusterReachable(
      {
        x: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
      },
      false
    );
  });

  it('returns false when reachability result is empty', async () => {
    await checkIsClusterReachable({x: {}}, false);
  });

  it('returns false when reachability.result item is not there', async () => {
    await checkIsClusterReachable(undefined, false);
  });

  describe('ignores video mesh reachability', () => {
    it('returns false if there are no public cluster results, only video mesh', async () => {
      await checkIsClusterReachable(
        {
          x: {
            udp: {result: 'reachable'},
            tcp: {result: 'reachable'},
            isVideoMesh: true,
          },
          y: {
            udp: {result: 'unreachable'},
            tcp: {result: 'reachable'},
            isVideoMesh: true,
          },
        },
        false
      );
    });

    it('returns false if there public cluster reachability failed, only video mesh succeeded', async () => {
      await checkIsClusterReachable(
        {
          x: {
            udp: {result: 'unreachable'},
            tcp: {result: 'reachable'},
            isVideoMesh: true,
          },
          y: {
            udp: {result: 'reachable'},
            tcp: {result: 'unreachable'},
            isVideoMesh: true,
          },
          publicOne: {
            udp: {result: 'unreachable'},
            tcp: {result: 'unreachable'},
            isVideoMesh: false,
          },
        },
        false
      );
    });

    it('returns true if there is at least 1 public cluster result, while video mesh is not reachable', async () => {
      await checkIsClusterReachable(
        {
          x: {
            udp: {result: 'reachable'},
            tcp: {result: 'reachable'},
            isVideoMesh: true,
          },
          y: {
            udp: {result: 'unreachable'},
            tcp: {result: 'reachable'},
            isVideoMesh: true,
          },
          publicOne: {
            udp: {result: 'unreachable'},
            tcp: {result: 'reachable'},
            isVideoMesh: false,
          },
        },
        true
      );
    });
  });
});

describe('isAnyClusterReachableViaProtocol', () => {
  let webex;

  beforeEach(() => {
    webex = new MockWebex();
    sinon.stub(MeetingUtil, 'getIpVersion').returns(IP_VERSION.unknown);
  });

  afterEach(() => {
    sinon.restore();
  });

  const checkReachableViaProtocol = async (
    mockStorage: any,
    protocol: 'udp' | 'tcp' | 'xtls',
    expectedValue: boolean
  ) => {
    if (mockStorage) {
      await webex.boundedStorage.put(
        'Reachability',
        'reachability.result',
        JSON.stringify(mockStorage)
      );
    }
    const reachability = new Reachability(webex);

    const result = await reachability.isAnyClusterReachableViaProtocol(protocol);

    assert.equal(result, expectedValue);
  };

  ['udp', 'tcp', 'xtls'].forEach((protocol: 'udp' | 'tcp' | 'xtls') => {
    it(`returns true when at least one cluster is reachable via ${protocol}`, async () => {
      await checkReachableViaProtocol(
        {
          clusterA: {[protocol]: {result: 'reachable'}},
          clusterB: {[protocol]: {result: 'unreachable'}},
        },
        protocol,
        true
      );
    });

    it(`returns false when no cluster is reachable via ${protocol}`, async () => {
      await checkReachableViaProtocol(
        {
          clusterA: {[protocol]: {result: 'unreachable'}},
          clusterB: {[protocol]: {result: 'unreachable'}},
        },
        protocol,
        false
      );
    });
  });

  it('returns false when storage read throws an error', async () => {
    // don't put anything in storage so .get() rejects
    const reachability = new Reachability(webex);

    const result = await reachability.isAnyClusterReachableViaProtocol('xtls');

    assert.equal(result, false);
  });

  it('returns false when stored data is empty', async () => {
    await checkReachableViaProtocol({}, 'xtls', false);
  });
});

describe('isWebexMediaBackendUnreachable', () => {
  let webex;

  beforeEach(() => {
    webex = new MockWebex();

    sinon.stub(MeetingUtil, 'getIpVersion').returns(IP_VERSION.unknown);
  });

  afterEach(() => {
    sinon.restore();
  });

  const runCheck = async (mockStorage: any, expectedValue: boolean) => {
    if (mockStorage) {
      await webex.boundedStorage.put(
        'Reachability',
        'reachability.result',
        JSON.stringify(mockStorage)
      );
    }
    const reachability = new Reachability(webex);

    const result = await reachability.isWebexMediaBackendUnreachable();

    assert.equal(result, expectedValue);
  };

  [
    {
      title: 'no clusters at all',
      mockStorage: {},
      expectedResult: false,
    },
    {
      title: 'clusters without results',
      mockStorage: {a: {}, b: {}},
      expectedResult: false,
    },
    {
      title: 'all clusters untested',
      mockStorage: {
        a: {udp: 'untested'},
        b: {udp: 'untested', tcp: 'untested'},
      },
      expectedResult: false,
    },
    {
      title: 'one cluster with udp reachable',
      mockStorage: {x: {udp: {result: 'reachable'}, tcp: {result: 'unreachable'}}},
      expectedResult: false,
    },
    {
      title: 'one cluster with tcp reachable',
      mockStorage: {x: {tcp: {result: 'reachable'}}},
      expectedResult: false,
    },
    {
      title: 'one cluster with xtls reachable',
      mockStorage: {x: {xtls: {result: 'reachable'}}, y: {xtls: {result: 'unreachable'}}},
      expectedResult: false,
    },
    {
      title: 'multiple clusters with various protocols reachable',
      mockStorage: {
        a: {udp: {result: 'reachable'}, tcp: {result: 'reachable'}},
        b: {udp: {result: 'unreachable'}, tcp: {result: 'reachable'}},
        c: {tcp: {result: 'reachable'}},
        d: {xtls: {result: 'reachable'}},
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with all protocols unreachable',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
      },
      expectedResult: true,
    },
    {
      title: 'multiple clusters with UDP and TCP protocols unreachable, but TLS not tested',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with UDP and TCP protocols unreachable, but TLS missing',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with UDP and TLS protocols unreachable, but TCP not tested',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'untested'},
          xtls: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'untested'},
          xtls: {result: 'unreachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'untested'},
          xtls: {result: 'unreachable'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with UDP and TLS protocols unreachable, but TCP missing',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with all protocols unreachable, some untested',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        b: {udp: {result: 'unreachable'}, tcp: {result: 'untested'}, xtls: {result: 'unreachable'}},
        c: {udp: {result: 'unreachable'}, tcp: {result: 'unreachable'}, xtls: {result: 'untested'}},
      },
      expectedResult: true,
    },
    {
      title: 'multiple clusters with all protocols unreachable, except for 1 reachable on udp',
      mockStorage: {
        a: {
          udp: {result: 'reachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with all protocols unreachable, except for 1 reachable on tcp',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'reachable'},
          xtls: {result: 'unreachable'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with all protocols unreachable, except for 1 reachable on xtls',
      mockStorage: {
        a: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
        b: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'reachable'},
        },
        c: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
        },
      },
      expectedResult: false,
    },
    {
      title: 'multiple clusters with some missing results',
      mockStorage: {
        a: {udp: {result: 'unreachable'}},
        b: {tcp: {result: 'unreachable'}},
        c: {xtls: {result: 'unreachable'}},
        d: {},
      },
      expectedResult: true,
    },
  ].forEach(({mockStorage, expectedResult, title}) => {
    it(`returns ${expectedResult} when ${title}`, async () => {
      await runCheck(mockStorage, expectedResult);
    });
  });
});

describe('getReachabilityResults', () => {
  let webex;

  beforeEach(() => {
    webex = new MockWebex();
  });

  afterEach(() => {
    sinon.restore();
  });

  const runCheck = async (mockStorage: any, expectedResult: ReachabilityResultsForBackend) => {
    if (mockStorage) {
      await webex.boundedStorage.put(
        'Reachability',
        'reachability.result',
        JSON.stringify(mockStorage)
      );
    }
    const reachability = new Reachability(webex);

    const result = await reachability.getReachabilityResults();

    assert.deepEqual(result, expectedResult);
  };

  it('returns undefined if reading from local storage fails', async () => {
    sinon.stub(webex.boundedStorage, 'get').rejects(new Error('fake error'));

    const reachability = new Reachability(webex);

    const result = await reachability.getReachabilityResults();

    assert.isUndefined(result);
  });

  it('returns results from local storage, converted to the backend data format', async () => {
    await runCheck(
      // mock storage:
      {
        cluster1: {
          udp: {result: 'reachable', latencyInMilliseconds: 100},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
        },
        cluster2: {
          udp: {result: 'reachable', latencyInMilliseconds: 200},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          isVideoMesh: true,
        },
        cluster3: {
          udp: {result: 'unreachable'},
          tcp: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.10']},
          xtls: {result: 'untested'},
          isVideoMesh: true,
          someOtherField: 'any value',
        },
        cluster4: {
          udp: {result: 'reachable', latencyInMilliseconds: 300},
          tcp: {result: 'untested'},
          xtls: {result: 'untested'},
          someOtherField: 'any value',
        },
      },
      // expected result (same as above, but with values converted and isVideoMesh and someOtherField stripped out):
      {
        cluster1: {
          udp: {reachable: 'true', latencyInMilliseconds: '100'},
          tcp: {reachable: 'false'},
          xtls: {untested: 'true'},
        },
        cluster2: {
          udp: {reachable: 'true', latencyInMilliseconds: '200'},
          tcp: {reachable: 'false'},
          xtls: {untested: 'true'},
        },
        cluster3: {
          udp: {reachable: 'false'},
          tcp: {reachable: 'true', latencyInMilliseconds: '100', clientMediaIPs: ['10.10.10.10']},
          xtls: {untested: 'true'},
        },
        cluster4: {
          udp: {reachable: 'true', latencyInMilliseconds: '300'},
          tcp: {untested: 'true'},
          xtls: {untested: 'true'},
        },
      }
    );
  });
});

describe('getReachabilityMetrics', () => {
  let webex;

  beforeEach(() => {
    webex = new MockWebex();
  });

  afterEach(() => {
    sinon.restore();
  });

  const runCheck = async (mockStorage: any, expectedResult: any) => {
    if (mockStorage) {
      await webex.boundedStorage.put(
        'Reachability',
        'reachability.result',
        JSON.stringify(mockStorage)
      );
    }
    const reachability = new Reachability(webex);
    const result = await reachability.getReachabilityMetrics();

    assert.deepEqual(result, expectedResult);
  };

  it('returns all zeros if reading from local storage fails', async () => {
    sinon.stub(webex.boundedStorage, 'get').rejects(new Error('fake error'));

    const reachability = new Reachability(webex);

    const result = await reachability.getReachabilityMetrics();

    assert.deepEqual(result, {
      reachability_public_udp_success: 0,
      reachability_public_udp_failed: 0,
      reachability_public_tcp_success: 0,
      reachability_public_tcp_failed: 0,
      reachability_public_xtls_success: 0,
      reachability_public_xtls_failed: 0,
      reachability_vmn_udp_success: 0,
      reachability_vmn_udp_failed: 0,
      reachability_vmn_tcp_success: 0,
      reachability_vmn_tcp_failed: 0,
      reachability_vmn_xtls_success: 0,
      reachability_vmn_xtls_failed: 0,
      natType: 'unknown',
    });
  });

  it('returns correct stats based on local storage results', async () => {
    await runCheck(
      // mock storage:
      {
        public1: {
          udp: {result: 'reachable', latencyInMilliseconds: 100},
          tcp: {result: 'untested'},
          xtls: {result: 'untested'},
        },
        vmn1: {
          udp: {result: 'reachable', latencyInMilliseconds: 200},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          isVideoMesh: true,
        },
        vmn2: {
          udp: {result: 'untested'},
          tcp: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.10']},
          xtls: {result: 'untested'},
          isVideoMesh: true,
          someOtherField: 'any value',
        },
        public2: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          someOtherField: 'any value',
        },
        public3: {
          udp: {result: 'reachable', latencyInMilliseconds: 400, clientMediaIPs: ['10.10.10.10']},
          tcp: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.10']},
          xtls: {result: 'untested'},
          isVideoMesh: false,
          someOtherField: 'any value',
        },
        public4: {
          udp: {result: 'reachable', latencyInMilliseconds: 40, clientMediaIPs: ['10.10.10.11']},
          tcp: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.11']},
          xtls: {result: 'untested'},
          isVideoMesh: false,
          someOtherField: 'any value',
        },
        public5: {
          udp: {result: 'unreachable'},
          tcp: {result: 'untested'},
          xtls: {result: 'untested'},
          isVideoMesh: false,
          someOtherField: 'any value',
        },
      },
      // expected result:
      {
        reachability_public_udp_success: 3,
        reachability_public_udp_failed: 2,
        reachability_public_tcp_success: 2,
        reachability_public_tcp_failed: 1,
        reachability_public_xtls_success: 0,
        reachability_public_xtls_failed: 0,
        reachability_vmn_udp_success: 1,
        reachability_vmn_udp_failed: 0,
        reachability_vmn_tcp_success: 1,
        reachability_vmn_tcp_failed: 1,
        reachability_vmn_xtls_success: 0,
        reachability_vmn_xtls_failed: 0,
        natType: 'unknown',
      }
    );
  });

  it('returns correct stats when only public nodes were tested', async () => {
    await runCheck(
      // mock storage:
      {
        public1: {
          udp: {result: 'reachable', latencyInMilliseconds: 400, clientMediaIPs: ['10.10.10.10']},
          tcp: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.10']},
          xtls: {result: 'untested'},
          isVideoMesh: false,
        },
        public2: {
          udp: {result: 'reachable', latencyInMilliseconds: 100},
          tcp: {result: 'untested'},
          xtls: {result: 'untested'},
        },
        public3: {
          udp: {result: 'unreachable'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          someOtherField: 'any value',
        },
        public4: {
          udp: {result: 'untested'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          isVideoMesh: false,
          someOtherField: 'any value',
        },
        public5: {
          udp: {result: 'reachable', latencyInMilliseconds: '400', clientMediaIPs: ['10.10.10.10']},
          tcp: {result: 'untested'},
          xtls: {result: 'unreachable'},
        },
        public6: {
          udp: {result: 'untested'},
          tcp: {result: 'untested'},
          xtls: {
            result: 'reachable',
            latencyInMilliseconds: '200',
            clientMediaIPs: ['10.10.10.10'],
          },
        },
      },
      // expected result:
      {
        reachability_public_udp_success: 3,
        reachability_public_udp_failed: 1,
        reachability_public_tcp_success: 1,
        reachability_public_tcp_failed: 2,
        reachability_public_xtls_success: 1,
        reachability_public_xtls_failed: 1,
        reachability_vmn_udp_success: 0,
        reachability_vmn_udp_failed: 0,
        reachability_vmn_tcp_success: 0,
        reachability_vmn_tcp_failed: 0,
        reachability_vmn_xtls_success: 0,
        reachability_vmn_xtls_failed: 0,
        natType: 'unknown',
      }
    );
  });

  it('returns correct stats when only video mesh nodes were tested', async () => {
    await runCheck(
      // mock storage:
      {
        vmn1: {
          udp: {result: 'unreachable'},
          tcp: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.10']},
          xtls: {result: 'untested'},
          isVideoMesh: true,
        },
        vmn2: {
          udp: {result: 'reachable', latencyInMilliseconds: 200, clientMediaIPs: ['10.10.10.10']},
          tcp: {result: 'untested'},
          xtls: {result: 'untested'},
          isVideoMesh: true,
        },
        vmn3: {
          udp: {result: 'reachable', latencyInMilliseconds: 300, clientMediaIPs: ['10.10.10.10']},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          isVideoMesh: true,
        },
        vmn4: {
          udp: {result: 'untested'},
          tcp: {result: 'unreachable'},
          xtls: {result: 'untested'},
          isVideoMesh: true,
          someOtherField: 'any value',
        },
        vmn5: {
          udp: {result: 'reachable', latencyInMilliseconds: 200, clientMediaIPs: ['10.10.10.10']},
          tcp: {result: 'unreachable'},
          xtls: {result: 'unreachable'},
          isVideoMesh: true,
          someOtherField: 'any value',
        },
        vmn6: {
          udp: {result: 'untested'},
          tcp: {result: 'untested'},
          xtls: {result: 'reachable', latencyInMilliseconds: 100, clientMediaIPs: ['10.10.10.10']},
          isVideoMesh: true,
        },
      },
      // expected result:
      {
        reachability_public_udp_success: 0,
        reachability_public_udp_failed: 0,
        reachability_public_tcp_success: 0,
        reachability_public_tcp_failed: 0,
        reachability_public_xtls_success: 0,
        reachability_public_xtls_failed: 0,
        reachability_vmn_udp_success: 3,
        reachability_vmn_udp_failed: 1,
        reachability_vmn_tcp_success: 1,
        reachability_vmn_tcp_failed: 3,
        reachability_vmn_xtls_success: 1,
        reachability_vmn_xtls_failed: 1,
        natType: 'unknown',
      }
    );
  });
});
