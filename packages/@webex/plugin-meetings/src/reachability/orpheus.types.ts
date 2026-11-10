import type {ClientMediaPreferences, ReachabilityResultsForBackend} from './reachability.types';

export type OrpheusLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface OrpheusOptions {
  routeUrl: string;
  pageOrigin: string;
  getBearer: () => Promise<string>;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getIpVersion: () => number | undefined;
  getClientEnvironment?: () => {components: Record<string, string>};
  logger: object;
  logLevel: OrpheusLogLevel;
}

export interface OrpheusFacade {
  gatherReachability(trigger: string): Promise<unknown>;
  getClientMediaPreferences(
    isMultistream: boolean,
    ipVersion?: number
  ): Promise<ClientMediaPreferences>;
  getReachabilityResults(): Promise<ReachabilityResultsForBackend | undefined>;
  isSubnetReachable(subnet: string): boolean;
  stopReachability(): void;
  shutdown(): void;
  getDiagnostics(): Record<string, unknown>;
  setLogLevel(level: OrpheusLogLevel): unknown;
  getLogLevel(): OrpheusLogLevel;
  on(event: string, listener: (payload: {protocol?: string}) => void): unknown;
}
