alter table deliveries add column attempts integer not null default 0;
alter table deliveries add column next_attempt_at bigint not null default 0;
alter table deliveries drop constraint deliveries_status_check;
alter table deliveries add constraint deliveries_status_check
  check (status in ('pending', 'retrying', 'delivered', 'failed'));
drop index deliveries_pending;
create index deliveries_due on deliveries (next_attempt_at) where status in ('pending', 'retrying');
