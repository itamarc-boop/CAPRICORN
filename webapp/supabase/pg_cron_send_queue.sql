-- Send-queue scheduler: Supabase pg_cron + pg_net hit the webapp's tick
-- endpoint once a minute. Apply in the Supabase SQL editor AT DEPLOY TIME —
-- it needs the real app URL and CRON_SECRET, so it is not part of the
-- numbered migrations.
--
-- 1. Replace <APP_URL> with the deployed app origin (e.g. https://capricorn-leadops.vercel.app)
--    and <CRON_SECRET> with the same value set in the Vercel env.
-- 2. Run this whole file once. Re-running replaces the job safely.
--
-- For local testing you don't need this — hit the endpoint by hand:
--   curl -X POST http://localhost:3000/api/send-queue/tick \
--        -H "Authorization: Bearer $CRON_SECRET"

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('capricorn-send-queue-tick')
where exists (select 1 from cron.job where jobname = 'capricorn-send-queue-tick');

select cron.schedule(
  'capricorn-send-queue-tick',
  '* * * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/send-queue/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <CRON_SECRET>'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Check it's running:
--   select jobname, schedule, active from cron.job;
--   select status, created from net._http_response order by created desc limit 5;
