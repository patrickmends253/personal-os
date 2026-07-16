// Supabase client + auth. Loaded from CDN (no build step, per project.md §2).
// The anon/public key is SAFE to commit: it is designed to live in client code and
// is protected by row-level security (RLS) so only the logged-in account sees its data.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://uxtaxbxdhejocolzpirz.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4dGF4YnhkaGVqb2NvbHpwaXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNTE5MjYsImV4cCI6MjA5OTcyNzkyNn0.oGYIDSOmv1FoEqB7QLuVhnzJBc09uYHIRqMqX4J-Id8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,      // keep the session on the device...
    autoRefreshToken: true,    // ...and refresh it silently, so it's "log in once per device"
  },
});
