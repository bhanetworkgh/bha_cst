-- Migration 019: Backfill ElevenLabs voice pointer for proj-vfarm-main
-- Ensures proj-vfarm-main has its canonical voice clone configured in persistent storage.

UPDATE projects
SET
  elevenlabs_voice_id = COALESCE(NULLIF(elevenlabs_voice_id, ''), 'Hmy97GCI840wuICQesiM'),
  elevenlabs_model_id = COALESCE(NULLIF(elevenlabs_model_id, ''), 'eleven_turbo_v2_5'),
  voice_enabled       = TRUE,
  updated_at          = NOW()
WHERE project_id = 'proj-vfarm-main' AND (elevenlabs_voice_id IS NULL OR elevenlabs_voice_id = '');
