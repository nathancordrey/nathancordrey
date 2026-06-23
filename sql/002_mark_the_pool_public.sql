-- Keep the original main pool publicly viewable after private-pool guards
-- are enabled. New/test pools remain private unless explicitly marked public.
UPDATE pools
SET is_public = true
WHERE slug = 'the-pool';
