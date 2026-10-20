create table deliveries (
  id text primary key,
  endpoint_id text not null references endpoints (id),
  event jsonb not null,
  status text not null default 'pending',
  last_code integer,
  created_at bigint not null,
  constraint deliveries_status_check check (status in ('pending', 'delivered', 'failed'))
);
create index deliveries_pending on deliveries (created_at) where status = 'pending';
