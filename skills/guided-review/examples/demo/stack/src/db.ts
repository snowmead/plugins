export interface Endpoint {
  id: string;
  url: string;
  secret: string;
}

export interface Delivery {
  id: string;
  endpointId: string;
  event: unknown;
  status: 'pending' | 'retrying' | 'delivered' | 'failed';
  lastCode: number | null;
  /** Posts so far, failed or not. */
  attempts: number;
  /** When the worker may post it next, in ms since the epoch. */
  nextAttemptAt: number;
  createdAt: number;
}

type Where<T> = { [K in keyof T]?: T[K] | T[K][] | { lte: T[K] } };

export interface Db {
  endpoints: { get(id: string): Promise<Endpoint> };
  deliveries: {
    find(where: Where<Delivery>, opts: { limit: number; order: keyof Delivery }): Promise<Delivery[]>;
    count(where: Where<Delivery>): Promise<number>;
    update(id: string, fields: Partial<Delivery>): Promise<void>;
  };
}
