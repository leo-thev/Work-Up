create table if not exists push_reminder_runs (
  run_key text primary key,
  reminder_type text not null,
  sent_at timestamptz not null default now()
);

alter table push_reminder_runs enable row level security;

-- No client policy: only the service role used by the Edge Function can write here.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace CRON_SECRET_VALUE with the same value configured as the CRON_SECRET
-- Edge Function secret. This schedule runs every 15 minutes; the function only
-- sends at 12:00 and 20:00 Europe/Paris and prevents duplicate sends.
select vault.create_secret('CRON_SECRET_VALUE', 'work_up_cron_secret');

select cron.schedule(
  'work-up-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://vqpnagvvxnilxipwqmjd.supabase.co/functions/v1/scheduled-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'work_up_cron_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
