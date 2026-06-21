-- Seed: one starter template so the Send-email flow has something to pick.
-- Run after 0001_init.sql.

insert into templates (name, subject_template, body_template) values
  (
    'Capricorn intro — what to sell',
    'Quick idea for {{company_name}}: complementary sourcing from Asia',
    'Hi {{contact_name}},

I am writing from Capricorn, a 50-year global sourcing company. We move 20,000+ containers a year out of China and Vietnam and supply European distributors and manufacturers with complementary SKUs they would otherwise tool up to make in-house.

Looking at {{company_name}}, I think there is a clean fit on:
{{what_to_sell_gaps}}

A few quick context bullets on why we think this is worth a 20-minute call:
- {{judge_reason}}

If this is interesting, can we put 20 minutes on the calendar next week?

Best,
[Your name]
Capricorn'
  )
on conflict do nothing;
