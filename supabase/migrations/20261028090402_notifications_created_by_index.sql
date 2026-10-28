-- Cover the notifications.created_by foreign key reported by the performance advisor.
create index if not exists idx_notifications_created_by
  on public.notifications (created_by)
  where created_by is not null;
