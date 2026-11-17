-- Safe to rerun. Must be applied before NCAA-aware code starts.
ALTER TABLE games ADD COLUMN IF NOT EXISTS tiebreak_winner VARCHAR(4);
