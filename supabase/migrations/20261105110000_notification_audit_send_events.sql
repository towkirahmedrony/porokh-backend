-- Distinguish a provider send attempt and a failed send from a successful send
-- in the admin audit trail. The original constraint only allowed lifecycle
-- actions, so failure entries could not be recorded honestly.

alter table public.notification_admin_audit
  drop constraint if exists notification_admin_audit_action_check;

alter table public.notification_admin_audit
  add constraint notification_admin_audit_action_check
  check (action in (
    'created', 'updated', 'scheduled', 'send_attempted', 'sent', 'failed',
    'cancelled', 'retried', 'delivery_refreshed', 'deleted'
  ));
