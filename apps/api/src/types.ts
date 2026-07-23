import type { SystemSmokeRequested } from '@worldgraph/contracts';

export interface QueryResult<Row> {
  rows: Row[];
}

export interface SqlProbe {
  query(sql: string): Promise<QueryResult<Record<string, unknown>>>;
}

export interface RedisProbe {
  get(key: string): Promise<string | null>;
  ping(): Promise<string>;
}

export interface SmokeJobView {
  getState(): Promise<string>;
}

export interface SmokeQueue {
  add(
    name: string,
    data: SystemSmokeRequested,
    options: {
      jobId: string;
      removeOnComplete: { age: number; count: number };
      removeOnFail: boolean;
    },
  ): Promise<SmokeJobView>;
  getJob(id: string): Promise<SmokeJobView | undefined>;
}
