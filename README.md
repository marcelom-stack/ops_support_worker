 ops_support_worker

Gmail ingest worker for Blink support dashboard (`ops_support_*` on BCA Supabase).

## Emergency fix 2026-10-07
- Inbound poll no longer restricted to INBOX label (archived mail was invisible)
- Date floor `after:2026/09/01` + 2-day lookback to recover backlog since Friday
