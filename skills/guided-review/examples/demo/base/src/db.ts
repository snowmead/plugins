export interface Endpoint {
  id: string;
  url: string;
  secret: string;
}

export interface Delivery {
  id: string;
  endpointId: string;
  event: unknown;
  status: 'pending' | 'delivered' | 'failed';
  lastCode: number | null;
  createdAt: number;
}

type Where<T> = { [K in keyof T]?: T[K] | T[K][] | { lte: T[K] } };

export interface Db {
  endpoints: { get(id: string): Promise<Endpoint> };
  deliveries: {
    find(where: Where<Delivery>, opts: { limit: number; order: keyof Delivery }): Promise<Delivery[]>;
    update(id: string, fields: Partial<Delivery>): Promise<void>;
  };
}
