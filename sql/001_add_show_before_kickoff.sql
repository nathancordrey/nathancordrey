-- Add optional early-reveal setting for each prediction.
-- false = show only "Submitted" before kickoff.
-- true  = reveal this specific score pick before kickoff.
-- At kickoff, all picks reveal automatically regardless of this value.

ALTER TABLE predictions
ADD COLUMN IF NOT EXISTS show_before_kickoff boolean NOT NULL DEFAULT false;
