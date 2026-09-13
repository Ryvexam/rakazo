CREATE TABLE "voice_favorites" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "voiceId" TEXT NOT NULL,
  "label" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "voice_favorites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_favorites_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "voice_favorites_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "voice_favorites_spaceId_userId_provider_voiceId_key"
  ON "voice_favorites"("spaceId", "userId", "provider", "voiceId");
CREATE INDEX "voice_favorites_spaceId_userId_position_createdAt_idx"
  ON "voice_favorites"("spaceId", "userId", "position", "createdAt");
