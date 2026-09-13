ALTER TABLE "bots"
  ADD COLUMN "voiceProvider" TEXT,
  ADD COLUMN "voiceModelId" TEXT,
  ADD COLUMN "voiceLabel" TEXT;

ALTER TABLE "space_voice_preferences"
  ADD COLUMN "voiceLabel" TEXT;

-- Existing bot voice IDs historically resolved through the space default voice.
-- Preserve that behavior where an unambiguous default exists without probing
-- every provider or changing the stored voice ID.
UPDATE "bots" AS b
SET
  "voiceProvider" = c."provider",
  "voiceModelId" = NULLIF(p."modelId", ''),
  "voiceLabel" = p."voiceLabel"
FROM "space_voice_preferences" AS p
JOIN "user_voice_credentials" AS c
  ON c."id" = p."credentialId" AND c."userId" = p."userId"
WHERE b."voiceId" IS NOT NULL
  AND b."voiceProvider" IS NULL
  AND p."spaceId" = b."spaceId"
  AND p."userId" = b."userId"
  AND p."isDefault" = true;
